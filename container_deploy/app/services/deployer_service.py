import asyncio
from datetime import datetime, timezone
import json
import logging
from typing import Any, Dict, List, Optional, Tuple
import uuid
import asyncpg

import re
from app.config import get_settings
from app.models.job import DeploymentJob
from app.services.image_builder import ImageBuilder
from app.services.docker_runner import DockerRunner

logger = logging.getLogger(__name__)

def sanitize_container_name(name: str) -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9_.-]", "-", name)
    return sanitized.strip("-") or "shipyard-app"

def sanitize_image_name(name: str) -> str:
    """Docker repository names must be lowercase and limited to [a-z0-9._-].

    Service names come straight from user config ("NightMark"), and an
    unsanitized value makes `docker build` fail instantly with
    "repository name must be lowercase" - after clone, on every retry.
    """
    lowered = (name or "").strip().lower()
    cleaned = re.sub(r"[^a-z0-9._-]+", "-", lowered).strip("-._")
    return cleaned or "app"

def sanitize_hostname_label(name: str) -> str:
    """Lowercase, DNS-safe label for a subdomain component."""
    sanitized = re.sub(r"[^a-z0-9-\.]", "-", name.lower())
    return sanitized.strip("-") or "app"

def build_deploy_hostname(service_name: str, service_id: str, deployment_id: str = "") -> str:
    """Public deploy URL: shipyard-<service>-<svc8>.<DEPLOY_DOMAIN>.

    STABLE PER SERVICE, deliberately. This used to key on the deployment id,
    which gave every redeploy a brand-new hostname. That made the URL unusable
    as something to hand out: a frontend built against it broke the next time
    the backend shipped, and nothing could hold a reference to "the API".

    The service id (not the name) supplies uniqueness because service names are
    only unique *within a project* - two projects with an `api` service would
    otherwise fight over the same hostname.

    First-level subdomains ride the apex wildcard covered by Cloudflare's
    Universal SSL, so no paid Advanced Certificate Manager is needed.

    `deployment_id` is the fallback discriminator only: a hand-pushed Redis job
    with no service_id still gets a working, if per-deployment, hostname rather
    than a malformed one.
    """
    settings = get_settings()
    svc_label = sanitize_hostname_label(service_name)
    discriminator = (service_id or deployment_id or "")[:8]
    tail = sanitize_hostname_label(discriminator) if discriminator else ""
    host_label = f"{settings.DEPLOY_SUBDOMAIN_PREFIX}-{svc_label}"
    if tail:
        host_label = f"{host_label}-{tail}"
    return f"{host_label}.{settings.DEPLOY_DOMAIN}"

class DeployerService:
    # Server startup banners that reveal a loopback bind. Matches Flask/Werkzeug
    # ("Running on http://127.0.0.1:5000"), uvicorn, gunicorn and generic
    # "listening on localhost:PORT" output.
    LOOPBACK_BANNER = re.compile(
        r"(?:running on|listening (?:on|at)|serving on|starting development server at)\s+"
        r"https?://(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?",
        re.IGNORECASE,
    )

    def __init__(
        self,
        db_pool: asyncpg.Pool,
        image_builder: ImageBuilder,
        docker_runner: DockerRunner
    ):
        self.db_pool = db_pool
        self.image_builder = image_builder
        self.docker_runner = docker_runner

    async def emit_event(
        self,
        deployment_id: str,
        event_type: str,
        message: str,
        metadata: Optional[Dict[str, Any]] = None
    ) -> None:
        event_id = f"evt_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc)
        meta_json = json.dumps(metadata or {})

        query = """
            INSERT INTO deployment_events (event_id, deployment_id, event_type, message, metadata, created_at)
            VALUES ($1, $2, $3, $4, $5, $6)
        """
        async with self.db_pool.acquire() as conn:
            await conn.execute(query, event_id, deployment_id, event_type, message, meta_json, now)

    async def append_log(
        self,
        deployment_id: str,
        stream: str,
        log_content: str
    ) -> None:
        log_id = f"log_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc)

        query = """
            INSERT INTO deployment_logs (log_id, deployment_id, stream, log_content, created_at)
            VALUES ($1, $2, $3, $4, $5)
        """
        async with self.db_pool.acquire() as conn:
            await conn.execute(query, log_id, deployment_id, stream, log_content, now)

    async def set_state(
        self,
        deployment_id: str,
        status: str,
        extra_fields: Optional[Dict[str, Any]] = None
    ) -> None:
        now = datetime.now(timezone.utc)
        extras = extra_fields or {}

        started_at = now if status == "building" else None
        finished_at = now if status in ["healthy", "failed", "cancelled", "rolled_back"] else None
        image_id = extras.get("image_id")
        container_id = extras.get("container_id")
        deployment_url = extras.get("deployment_url")

        query = """
            UPDATE deployments
            SET status = $1,
                started_at = COALESCE($2, started_at),
                finished_at = COALESCE($3, finished_at),
                image_id = COALESCE($4, image_id),
                container_id = COALESCE($5, container_id),
                deployment_url = COALESCE($6, deployment_url)
            WHERE deployment_id = $7
        """
        async with self.db_pool.acquire() as conn:
            await conn.execute(
                query,
                status,
                started_at,
                finished_at,
                image_id,
                container_id,
                deployment_url,
                deployment_id
            )

    async def mark_terminal_failed(self, deployment_id: str, error_msg: str) -> None:
        try:
            await self.set_state(deployment_id, "failed")
        except Exception as e:
            logger.warning(f"Failed to set status to failed: {e}")
        try:
            await self.emit_event(deployment_id, "DEPLOYMENT_FAILED", error_msg)
        except Exception as e:
            logger.warning(f"Failed to emit DEPLOYMENT_FAILED event: {e}")

    async def _log_output(self, deployment_id: str, text: str) -> None:
        """Append builder/subprocess output to deployment_logs (never fatal)."""
        if not text:
            return
        try:
            await self.append_log(deployment_id, "stdout", text if text.endswith("\n") else text + "\n")
        except Exception as e:
            logger.warning(f"Failed to persist deployment log for {deployment_id}: {e}")

    async def execute(
        self,
        job: DeploymentJob,
        healthcheck_max_retries: int = 12,
        poll_interval: float = 5.0
    ) -> None:
        dep_id = job.deployment_id
        cfg = job.config_snapshot

        # 0. Ensure base entities exist in DB (supports standalone queue testing without FK errors)
        try:
            async with self.db_pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO users (user_id, username) VALUES ('usr_system', 'system') ON CONFLICT (user_id) DO NOTHING"
                )

                # Resolve or insert Project
                prj_id = job.project_id or "prj_default"
                existing_prj = await conn.fetchrow("SELECT project_id FROM projects WHERE project_id = $1", prj_id)
                if not existing_prj:
                    p_name = cfg.service_name or "default-project"
                    existing_pname = await conn.fetchrow(
                        "SELECT project_id FROM projects WHERE user_id = 'usr_system' AND project_name = $1", p_name
                    )
                    if existing_pname:
                        prj_id = existing_pname["project_id"]
                    else:
                        await conn.execute(
                            """
                            INSERT INTO projects (project_id, user_id, project_name, github_url)
                            VALUES ($1, 'usr_system', $2, $3)
                            ON CONFLICT DO NOTHING
                            """,
                            prj_id,
                            p_name,
                            cfg.repository or "https://github.com/shipyard/app"
                        )

                # Resolve or insert Service
                svc_id = job.service_id or "svc_default"
                existing_svc = await conn.fetchrow("SELECT service_id FROM services WHERE service_id = $1", svc_id)
                if not existing_svc:
                    s_name = cfg.service_name or "default-service"
                    existing_sname = await conn.fetchrow(
                        "SELECT service_id FROM services WHERE project_id = $1 AND service_name = $2", prj_id, s_name
                    )
                    if existing_sname:
                        svc_id = existing_sname["service_id"]
                    else:
                        await conn.execute(
                            """
                            INSERT INTO services (service_id, project_id, service_name, service_type, repository)
                            VALUES ($1, $2, $3, $4, $5)
                            ON CONFLICT DO NOTHING
                            """,
                            svc_id,
                            prj_id,
                            s_name,
                            cfg.service_type or "backend",
                            cfg.repository or "https://github.com/shipyard/app"
                        )

                # Ensure Deployment row exists
                existing_dep = await conn.fetchrow("SELECT deployment_id FROM deployments WHERE deployment_id = $1", dep_id)
                if not existing_dep:
                    await conn.execute(
                        """
                        INSERT INTO deployments (deployment_id, service_id, commit_sha, branch, status, config_snapshot)
                        VALUES ($1, $2, $3, $4, 'queued', $5)
                        ON CONFLICT (deployment_id) DO NOTHING
                        """,
                        dep_id,
                        svc_id,
                        job.commit_sha or "HEAD",
                        job.branch or "main",
                        json.dumps(cfg.model_dump())
                    )
        except Exception as e:
            logger.warning(f"Could not auto-seed deployment row: {e}")

        # 1. Validating
        await self.set_state(dep_id, "validating")
        await self.emit_event(dep_id, "VALIDATION_START", "Validating configuration parameters")

        if not cfg.repository:
            err = "Repository URL is missing in deployment config."
            await self.mark_terminal_failed(dep_id, err)
            raise ValueError(err)

        await self.emit_event(dep_id, "VALIDATION_PASSED", "Configuration verified successfully")

        # 2. Building
        await self.set_state(dep_id, "building")
        image_tag = f"shipyard-app/{sanitize_image_name(cfg.service_name)}:{dep_id[:8]}"
        await self.emit_event(dep_id, "BUILD_START", f"Compiling image {image_tag}")

        try:
            await self.image_builder.build(
                deployment_id=dep_id,
                repo_url=cfg.repository,
                branch=cfg.branch,
                commit_sha=job.commit_sha,
                root_dir=cfg.root_directory,
                build_cmd=cfg.build_command,
                pre_deploy_cmd=cfg.pre_deploy_command,
                start_cmd=cfg.start_command,
                tag=image_tag,
                on_output=lambda text: self._log_output(dep_id, text)
            )
        except Exception as e:
            await self.mark_terminal_failed(dep_id, f"Build failure: {e}")
            raise

        await self.emit_event(dep_id, "BUILD_SUCCESS", f"Built image {image_tag}")

        # 3. Deploying Workload via DockerRunner
        await self.set_state(dep_id, "deploying", {"image_id": image_tag})
        await self.emit_event(dep_id, "DEPLOY_START", "Launching container workload on host Docker daemon")

        svc_clean = sanitize_container_name(cfg.service_name)
        container_name = f"shipyard-{svc_clean}-{dep_id[:8]}"

        # Port & Environment Variable Reconciliation:
        # 1. Check if PORT is explicitly defined in env_vars
        env_port: Optional[int] = None
        effective_env_vars = list(cfg.env_vars or [])
        for ev in effective_env_vars:
            if str(ev.get("key", "")).strip().upper() == "PORT":
                val = str(ev.get("value") or ev.get("secret_ref") or "").strip()
                if val.isdigit() and 1 <= int(val) <= 65535:
                    env_port = int(val)
                    break

        # 2. Extract ports declared in cfg.ports
        declared_ports = [int(p.get("containerPort")) for p in (cfg.ports or []) if p.get("containerPort")]

        # 3. Reconcile primary port and declared ports:
        # - If env_port is set (e.g. PORT=4000), prioritize it:
        #   If declared_ports is empty or defaulted to [3000], adopt env_port as the primary port.
        #   Otherwise ensure env_port is first in declared_ports.
        # - If env_port is not set, use declared_ports (defaulting to 3000) and inject
        #   PORT=<primary_port> into container environment (standard 12-factor contract).
        if env_port:
            primary_port = env_port
            if not declared_ports or declared_ports == [3000]:
                declared_ports = [env_port]
            elif env_port not in declared_ports:
                declared_ports.insert(0, env_port)
        else:
            primary_port = declared_ports[0] if declared_ports else 3000
            if not declared_ports:
                declared_ports = [3000]
            effective_env_vars.append({"key": "PORT", "value": str(primary_port)})

        effective_ports = [{"containerPort": p, "protocol": "tcp"} for p in declared_ports]

        # Dynamic ingress: Traefik (docker provider on the host) consumes
        # these labels at container creation time and routes the public
        # hostname immediately - no proxy reload, no Cloudflare changes.
        deploy_hostname = build_deploy_hostname(cfg.service_name, cfg.service_id, dep_id)

        # Router name is keyed on the SERVICE, matching the hostname: one
        # service, one route. During a redeploy the old container briefly also
        # declares it, which Traefik resolves by keeping one definition - and
        # `retire_superseded_containers` below closes that window as soon as the
        # new container is proven healthy.
        router_discriminator = sanitize_hostname_label((cfg.service_id or dep_id)[:8])
        router_name = sanitize_container_name(
            f"shipyard-{svc_clean}-{router_discriminator}"
        ).lower().replace("_", "-")

        labels = {
            "shipyard.deployment_id": dep_id,
            "shipyard.service_name": cfg.service_name,
            "shipyard.service_id": cfg.service_id or "",
            "shipyard.project_id": job.project_id or "",
            "shipyard.public_url": f"https://{deploy_hostname}",
            "traefik.enable": "true",
            f"traefik.http.routers.{router_name}.rule": f"Host(`{deploy_hostname}`)",
            f"traefik.http.routers.{router_name}.entrypoints": "web",
            f"traefik.http.services.{router_name}.loadbalancer.server.port": str(primary_port),
        }

        try:
            container_id = await self.docker_runner.run_container(
                container_name=container_name,
                image_tag=image_tag,
                ports=effective_ports,
                resources=cfg.resources or {"cpuLimit": "1", "memoryLimit": "512Mi"},
                env_vars=effective_env_vars,
                labels=labels
            )
        except Exception as e:
            await self.mark_terminal_failed(dep_id, f"Workload creation failed: {e}")
            raise

        # 4. Health Polling Loop
        # "running" is not proof of a working deployment: a container whose
        # process binds 127.0.0.1 (or the wrong port) is up but unreachable,
        # which surfaces to users as a Cloudflare 502 while the deployment is
        # reported healthy. So we also dial the container IP on the declared
        # port - the same connection Traefik makes - before calling it healthy.
        probe_ports = [int(p.get("containerPort")) for p in effective_ports if p.get("containerPort")]
        await self.emit_event(dep_id, "HEALTH_CHECK_WAIT", f"Awaiting running status for container {container_id}")
        is_healthy = False
        final_status = "unknown"
        active_listeners: List[Tuple[str, int]] = []
        for _ in range(healthcheck_max_retries):
            await asyncio.sleep(poll_interval)
            try:
                status = await self.docker_runner.get_container_status(container_id)
                final_status = status
            except Exception:
                continue  # Interim polling glitch
            if status in ["exited", "dead"]:
                break
            if status != "running":
                continue
            if await self._probe_listener(container_id, probe_ports):
                is_healthy = True
                break
            # Check active socket listeners to see what ports the container has actually opened
            try:
                active = await self.docker_runner.get_listening_ports(container_id)
                if active:
                    active_listeners = active
            except Exception:
                pass

        # Capture container runtime logs
        runtime_logs = ""
        try:
            runtime_logs = await self.docker_runner.get_container_logs(container_id)
            if runtime_logs:
                await self.append_log(dep_id, "stdout", runtime_logs)
        except Exception as e:
            logger.warning(f"Failed to capture container logs: {e}")

        # 5. Final Evaluation
        public_url = f"https://{deploy_hostname}"
        if is_healthy:
            await self.set_state(
                dep_id,
                "healthy",
                {"container_id": container_id, "deployment_url": public_url}
            )
            await self.emit_event(dep_id, "RELEASE_HEALTHY", f"Deployment is healthy and live at {public_url}")
            # Cut over only now that the replacement is proven: a failed build
            # must never take the running version down. Required rather than
            # tidy-up, because the hostname is stable per service - leaving the
            # old container up means two containers answering to one Host rule.
            await self.retire_superseded_containers(dep_id, cfg.service_id, container_id)
        else:
            try:
                if not active_listeners:
                    active_listeners = await self.docker_runner.get_listening_ports(container_id)
            except Exception:
                pass
            reason = self.diagnose_unreachable(
                runtime_logs,
                probe_ports or [primary_port],
                active_listeners,
                container_status=final_status
            )
            err = f"Container {container_id} is not serving traffic: {reason}"
            await self.emit_event(dep_id, "UNREACHABLE_PORT", reason)
            # A failed workload must not keep running: it would squat on the
            # host and keep answering with someone else's 502 behind a router.
            try:
                await self.docker_runner.remove_container(container_id)
            except Exception as e:
                logger.warning(f"Failed to remove unhealthy container {container_id}: {e}")
            await self.mark_terminal_failed(dep_id, err)
            raise TimeoutError(err)

    async def retire_superseded_containers(
        self, deployment_id: str, service_id: str, keep_container_id: str
    ) -> int:
        """Stops and removes every other container belonging to this service.

        Called only after the new container reports healthy, so the sequence is
        create -> verify -> retire: a build that never comes up leaves the
        previous version serving.

        Why this lives in CDS rather than coming back as a CMS instruction: CDS
        is the only component that talks to Docker, and the `supersedes`
        mapping CMS holds is released by a callback CDS does not send. Doing it
        here needs no new wiring and cannot leave an orphan if the callback
        path stays unimplemented.

        Failures are logged, never raised - a successful deployment must not be
        reported as failed because an old container refused to die.
        """
        if not service_id:
            return 0
        try:
            found = await self.docker_runner.find_containers_by_label(
                "shipyard.service_id", service_id
            )
        except Exception as e:
            logger.warning(f"Could not list containers for service {service_id}: {e}")
            return 0

        # Compare on the full id: `keep_container_id` may be the short form.
        stale = [
            cid for cid in found
            if cid != keep_container_id and not cid.startswith(keep_container_id)
            and not keep_container_id.startswith(cid)
        ]
        retired = 0
        for cid in stale:
            try:
                await self.docker_runner.stop_container(cid)
                await self.docker_runner.remove_container(cid)
                retired += 1
                await self.emit_event(
                    deployment_id, "SUPERSEDED_RETIRED",
                    f"Retired previous container {cid[:12]} for this service"
                )
            except Exception as e:
                logger.warning(f"Failed to retire superseded container {cid[:12]}: {e}")
                await self.emit_event(
                    deployment_id, "SUPERSEDE_FAILED",
                    f"Could not retire previous container {cid[:12]}: {e}"
                )
        return retired

    async def _probe_listener(self, container_id: str, ports: List[int]) -> bool:
        """True when at least one declared port accepts a TCP connection."""
        if not ports:
            return True
        try:
            ip = await self.docker_runner.get_container_ip(container_id)
        except Exception:
            return False
        if not ip:
            return False
        for port in ports:
            try:
                if await self.docker_runner.probe_port(ip, port):
                    return True
            except Exception:
                continue
        return False

    def diagnose_unreachable(
        self,
        logs: str,
        ports: List[int],
        active_listeners: Optional[List[Tuple[str, int]]] = None,
        container_status: Optional[str] = None
    ) -> str:
        """Explain why a running container serves no traffic, in the user's terms."""
        port_list = ", ".join(str(p) for p in ports) or "the declared port"

        if container_status in ["exited", "dead"]:
            tail_lines = [l.strip() for l in (logs or "").strip().splitlines() if l.strip()]
            error_snippet = f": {tail_lines[-1]}" if tail_lines else ""
            return (
                f"the container process crashed or exited prematurely (status: {container_status}){error_snippet}. "
                f"Check your start command, pre-deploy command, and container logs."
            )

        if active_listeners:
            loopbacks = [p for (bind_type, p) in active_listeners if bind_type == "loopback"]
            if loopbacks:
                return (
                    f"the app is bound to loopback (127.0.0.1:{loopbacks[0]}), so Docker networking and "
                    f"Traefik cannot reach it - that is what turns the public URL into a 502. "
                    f"Bind it to 0.0.0.0 on port {port_list} (e.g. Flask: app.run(host='0.0.0.0', port={loopbacks[0]}))."
                )

            other_listeners = [p for (bind_type, p) in active_listeners if bind_type == "all" and p not in ports]
            if other_listeners:
                return (
                    f"the app is listening on port {other_listeners[0]}, but the deployment is configured to "
                    f"route traffic to port {port_list}. Update the port in your service settings or set "
                    f"the PORT environment variable to {other_listeners[0]}."
                )

        match = self.LOOPBACK_BANNER.search(logs or "")
        if match:
            bound = match.group(1) or (str(ports[0]) if ports else "5000")
            return (
                f"the app is bound to loopback (127.0.0.1:{bound}), so Docker networking and Traefik "
                f"cannot reach it - that is what turns the public URL into a 502. Bind it to 0.0.0.0 on "
                f"port {port_list} (e.g. Flask: app.run(host='0.0.0.0', port={bound}))."
            )
        return (
            f"nothing accepted a TCP connection on port {port_list} from the container's network "
            f"interface, so the public URL would return 502. Check that the start command actually "
            f"starts the server, that it listens on {port_list}, and that it binds 0.0.0.0 rather "
            f"than 127.0.0.1."
        )

