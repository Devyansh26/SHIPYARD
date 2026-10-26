import asyncio
import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

class DockerRunnerException(Exception):
    """Domain exception raised when Docker runtime operations fail."""
    pass

class DockerRunner:
    async def _run_cmd(self, cmd: List[str], timeout: int = 60) -> Tuple[int, str]:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT
        )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
            return process.returncode or 0, stdout.decode("utf-8", errors="replace")
        except asyncio.TimeoutError:
            process.kill()
            raise DockerRunnerException(f"Command '{' '.join(cmd)}' timed out after {timeout}s")

    # Workloads must come back on host reboot (docker daemon start) and on
    # crash. "on-failure" only restarts on non-zero exits and is not guaranteed
    # to be re-launched by the daemon after a reboot, which silently left
    # deployments down until someone redeployed them. "unless-stopped" brings
    # them back every boot while still honouring an explicit `docker stop`.
    DEFAULT_RESTART_POLICY = "unless-stopped"

    async def run_container(
        self,
        container_name: str,
        image_tag: str,
        ports: List[Dict[str, Any]],
        resources: Dict[str, Any],
        env_vars: List[Dict[str, Any]],
        labels: Optional[Dict[str, str]] = None,
        restart_policy: Optional[str] = None
    ) -> str:
        """
        Runs an isolated Docker container workload directly.
        Returns the 12-char container ID.
        """
        # 1. Clean up any existing container with the same name
        await self._run_cmd(["docker", "rm", "-f", container_name], timeout=15)

        policy = restart_policy or self.DEFAULT_RESTART_POLICY
        cmd = ["docker", "run", "-d", "--name", container_name, "--restart", policy]

        # 2. Port mappings
        for p in ports:
            c_port = p.get("containerPort", 3000)
            h_port = p.get("hostPort")
            if h_port:
                cmd.extend(["-p", f"{h_port}:{c_port}"])
            else:
                cmd.extend(["-p", f"{c_port}"])

        # 3. Resource constraints
        mem = resources.get("memoryLimit")
        if mem:
            mem_clean = str(mem).lower().replace("i", "")
            cmd.extend(["--memory", mem_clean])

        cpu = resources.get("cpuLimit")
        if cpu:
            cmd.extend(["--cpus", str(cpu)])

        # 4. Environment variables
        for ev in env_vars:
            k = ev.get("key")
            v = ev.get("value") or ev.get("secret_ref") or ""
            if k:
                cmd.extend(["-e", f"{k}={v}"])

        # 5. Metadata labels
        if labels:
            for lk, lv in labels.items():
                cmd.extend(["--label", f"{lk}={lv}"])

        # 6. Target image tag
        cmd.append(image_tag)

        logger.info(f"Executing: {' '.join(cmd)}")
        code, out = await self._run_cmd(cmd, timeout=60)
        if code != 0:
            raise DockerRunnerException(f"docker run failed: {out.strip()}")

        container_id = out.strip()[:12]
        return container_id

    async def get_container_ip(self, container_id: str) -> Optional[str]:
        """First bridge/overlay IP of the container (what Traefik dials)."""
        code, out = await self._run_cmd(
            [
                "docker",
                "inspect",
                "-f",
                "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
                container_id,
            ],
            timeout=10,
        )
        if code != 0:
            return None
        ips = [ip for ip in out.split() if ip]
        return ips[0] if ips else None

    async def probe_port(self, host: str, port: int, timeout: float = 3.0) -> bool:
        """
        True if a TCP handshake succeeds at host:port.

        This reproduces exactly what Traefik does when it proxies a request:
        connect to the container IP on the declared port. A container can be
        "running" and still be unreachable here - e.g. the process bound
        127.0.0.1 inside the container, which no amount of networking can
        route to - and that is precisely the 502 case.
        """
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=timeout
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return True
        except (OSError, asyncio.TimeoutError):
            return False

    async def get_container_status(self, container_id: str) -> str:
        code, out = await self._run_cmd(
            ["docker", "inspect", "-f", "{{.State.Status}}", container_id],
            timeout=10
        )
        if code != 0:
            return "unknown"
        return out.strip().lower()

    async def get_container_logs(self, container_id: str, tail: int = 100) -> str:
        code, out = await self._run_cmd(
            ["docker", "logs", "--tail", str(tail), container_id],
            timeout=15
        )
        return out

    async def stop_container(self, container_id: str) -> None:
        await self._run_cmd(["docker", "stop", container_id], timeout=15)

    async def remove_container(self, container_id: str) -> None:
        """Force-remove a workload (failed deployments should not keep running)."""
        await self._run_cmd(["docker", "rm", "-f", container_id], timeout=20)

    async def get_listening_ports(self, container_id: str) -> List[Tuple[str, int]]:
        """
        Detects active TCP listening sockets inside the container.
        Returns a list of (bind_type, port), where bind_type is 'all', 'loopback', or 'other'.
        """
        listeners: List[Tuple[str, int]] = []
        code, out = await self._run_cmd(
            ["docker", "exec", container_id, "sh", "-c", "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null"],
            timeout=5
        )
        if code != 0 or not out.strip():
            # Fallback: check via host /proc/<pid>/net/tcp if accessible
            code_pid, pid_str = await self._run_cmd(
                ["docker", "inspect", "-f", "{{.State.Pid}}", container_id],
                timeout=5
            )
            if code_pid == 0 and pid_str.strip().isdigit() and int(pid_str.strip()) > 0:
                pid = pid_str.strip()
                try:
                    combined = ""
                    for p in [f"/proc/{pid}/net/tcp", f"/proc/{pid}/net/tcp6"]:
                        try:
                            with open(p, "r", encoding="utf-8") as f:
                                combined += f.read() + "\n"
                        except OSError:
                            pass
                    out = combined
                except Exception:
                    pass

        lines = out.strip().splitlines()
        for line in lines:
            parts = line.strip().split()
            if len(parts) >= 4 and parts[3] == "0A":  # TCP_LISTEN
                local_addr = parts[1]
                if ":" in local_addr:
                    ip_hex, port_hex = local_addr.split(":")
                    try:
                        port = int(port_hex, 16)
                        if ip_hex in ("0100007F", "00000000000000000000000001000000"):
                            bind_type = "loopback"
                        elif all(c == "0" for c in ip_hex):
                            bind_type = "all"
                        else:
                            bind_type = "other"
                        if (bind_type, port) not in listeners:
                            listeners.append((bind_type, port))
                    except ValueError:
                        pass
        return listeners
