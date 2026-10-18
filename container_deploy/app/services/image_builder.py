import asyncio
import os
import shutil
import logging
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

class ImageBuilderException(Exception):
    """Domain exception raised when image building or git checkout fails."""
    pass

class ImageBuilder:
    def __init__(self, workspace_root: str = "/tmp/shipyard-workspaces"):
        self.workspace_root = workspace_root
        os.makedirs(self.workspace_root, exist_ok=True)

    async def _run_command(self, cmd: List[str], cwd: str, timeout: int = 180) -> Tuple[int, str]:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT
        )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
            return process.returncode or 0, stdout.decode("utf-8", errors="replace")
        except asyncio.TimeoutError:
            process.kill()
            raise ImageBuilderException(f"Command '{' '.join(cmd)}' timed out after {timeout}s")

    def _generate_synthetic_dockerfile(
        self,
        build_cmd: Optional[str],
        pre_deploy_cmd: Optional[str],
        start_cmd: Optional[str]
    ) -> str:
        lines = [
            "FROM node:20-alpine",
            "WORKDIR /app",
            "COPY . .",
        ]
        if build_cmd:
            lines.append(f"RUN {build_cmd}")

        # Assemble entrypoint command chain
        run_cmds: List[str] = []
        if pre_deploy_cmd:
            run_cmds.append(pre_deploy_cmd)
        if start_cmd:
            run_cmds.append(start_cmd)
        else:
            run_cmds.append("npm start")

        entrypoint = " && ".join(run_cmds)
        escaped_entrypoint = entrypoint.replace('\\', '\\\\').replace('"', '\\"')
        lines.append(f'CMD ["sh", "-c", "{escaped_entrypoint}"]')
        return "\n".join(lines) + "\n"

    async def build(
        self,
        deployment_id: str,
        repo_url: str,
        branch: str,
        commit_sha: str,
        root_dir: Optional[str],
        build_cmd: Optional[str],
        pre_deploy_cmd: Optional[str],
        start_cmd: Optional[str],
        tag: str
    ) -> str:
        build_dir = os.path.join(self.workspace_root, deployment_id)
        if os.path.exists(build_dir):
            shutil.rmtree(build_dir, ignore_errors=True)
        os.makedirs(build_dir, exist_ok=True)

        try:
            # 1. Clone repository (depth=1 for minimal transfer)
            logger.info(f"Cloning {repo_url} (branch: {branch}) into {build_dir}")
            clone_cmd = ["git", "clone", "--depth", "1", "--branch", branch, repo_url, build_dir]
            code, out = await self._run_command(clone_cmd, cwd=self.workspace_root, timeout=120)
            if code != 0:
                raise ImageBuilderException(f"Git clone failed: {out.strip()}")

            target_context = os.path.join(build_dir, root_dir) if root_dir and root_dir != "." else build_dir
            if not os.path.exists(target_context):
                os.makedirs(target_context, exist_ok=True)

            dockerfile_path = os.path.join(target_context, "Dockerfile")

            # 2. Synthesize Dockerfile if none exists
            if not os.path.exists(dockerfile_path):
                logger.info(f"Generating synthetic Dockerfile in {target_context}")
                synthetic = self._generate_synthetic_dockerfile(build_cmd, pre_deploy_cmd, start_cmd)
                with open(dockerfile_path, "w", encoding="utf-8") as f:
                    f.write(synthetic)

            # 3. Execute Docker build
            logger.info(f"Running docker build for {tag} in {target_context}")
            build_cmd_args = ["docker", "build", "-t", tag, target_context]
            code, out = await self._run_command(build_cmd_args, cwd=target_context, timeout=300)
            if code != 0:
                raise ImageBuilderException(f"Docker build failed: {out.strip()}")

            return tag
        finally:
            # Guarantee workspace cleanup
            if os.path.exists(build_dir):
                shutil.rmtree(build_dir, ignore_errors=True)
