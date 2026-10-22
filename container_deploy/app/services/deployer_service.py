import asyncio
from datetime import datetime, timezone
import json
import logging
from typing import Any, Dict, Optional
import uuid
import asyncpg

import re
from app.models.job import DeploymentJob
from app.services.image_builder import ImageBuilder
from app.services.docker_runner import DockerRunner

logger = logging.getLogger(__name__)

def sanitize_container_name(name: str) -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9_.-]", "-", name)
    return sanitized.strip("-") or "shipyard-app"

class DeployerService:
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
        image_tag = f"shipyard-app/{cfg.service_name}:{dep_id[:8]}"
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
                tag=image_tag
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

        labels = {
            "shipyard.deployment_id": dep_id,
            "shipyard.service_name": cfg.service_name,
            "shipyard.service_id": cfg.service_id or "",
            "shipyard.project_id": job.project_id or "",
        }

        try:
            container_id = await self.docker_runner.run_container(
                container_name=container_name,
                image_tag=image_tag,
                ports=cfg.ports or [{"containerPort": 3000, "protocol": "tcp"}],
                resources=cfg.resources or {"cpuLimit": "1", "memoryLimit": "512Mi"},
                env_vars=cfg.env_vars or [],
                labels=labels
            )
        except Exception as e:
            await self.mark_terminal_failed(dep_id, f"Workload creation failed: {e}")
            raise

        # 4. Health Polling Loop
        await self.emit_event(dep_id, "HEALTH_CHECK_WAIT", f"Awaiting running status for container {container_id}")
        is_healthy = False
        for _ in range(healthcheck_max_retries):
            await asyncio.sleep(poll_interval)
            try:
                status = await self.docker_runner.get_container_status(container_id)
                if status == "running":
                    is_healthy = True
                    break
                elif status in ["exited", "dead"]:
                    break
            except Exception:
                pass  # Interim polling glitch

        # Capture container runtime logs
        runtime_logs = ""
        try:
            runtime_logs = await self.docker_runner.get_container_logs(container_id)
            if runtime_logs:
                await self.append_log(dep_id, "stdout", runtime_logs)
        except Exception as e:
            logger.warning(f"Failed to capture container logs: {e}")

        # 5. Final Evaluation
        public_url = f"http://{cfg.service_name}.local.shipyard.lan"
        if is_healthy:
            await self.set_state(
                dep_id,
                "healthy",
                {"container_id": container_id, "deployment_url": public_url}
            )
            await self.emit_event(dep_id, "RELEASE_HEALTHY", f"Deployment is healthy and live at {public_url}")
        else:
            err = f"Container {container_id} failed to reach running status: {runtime_logs.strip() or 'exited/unhealthy'}"
            await self.mark_terminal_failed(dep_id, err)
            raise TimeoutError(err)

