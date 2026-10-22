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

    async def run_container(
        self,
        container_name: str,
        image_tag: str,
        ports: List[Dict[str, Any]],
        resources: Dict[str, Any],
        env_vars: List[Dict[str, Any]],
        labels: Optional[Dict[str, str]] = None
    ) -> str:
        """
        Runs an isolated Docker container workload directly.
        Returns the 12-char container ID.
        """
        # 1. Clean up any existing container with the same name
        await self._run_cmd(["docker", "rm", "-f", container_name], timeout=15)

        cmd = ["docker", "run", "-d", "--name", container_name, "--restart", "on-failure:5"]

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
