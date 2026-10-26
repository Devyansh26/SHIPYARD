import asyncio
import os
import re
import shutil
import logging
from typing import Awaitable, Callable, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Called with a chunk of human-readable build output (clone / docker build).
OutputCallback = Callable[[str], Awaitable[None]]

# ---------------------------------------------------------------------------
# Host-binding shim
# ---------------------------------------------------------------------------
# Injected into every synthetic Python image as sitecustomize.py.
# Python imports sitecustomize.py automatically before any user script, so
# the patch fires even when the start command is just `python app.py`.
#
# Why three layers?
#   1. sitecustomize.py  → covers Flask.run() called directly in a script.
#   2. FLASK_RUN_HOST    → covers `flask run` (CLI) invocations.
#   3. _patch_server_cmd → covers gunicorn / uvicorn / flask run in CMD.
# ---------------------------------------------------------------------------
_FLASK_BIND_SHIM = (
    "# Shipyard host-binding shim — auto-injected, do not edit.\n"
    "try:\n"
    "    import os as _os\n"
    "    from flask import Flask as _F\n"
    "    _o = _F.run\n"
    "    def _shipyard_flask_run(s, host=None, port=None, **k):\n"
    "        env_p = _os.environ.get('PORT')\n"
    "        p = int(env_p) if env_p and env_p.isdigit() else (port or 5000)\n"
    "        h = '0.0.0.0' if (not host or host in ('127.0.0.1', 'localhost')) else host\n"
    "        return _o(s, host=h, port=p, **k)\n"
    "    _F.run = _shipyard_flask_run\n"
    "except ImportError:\n"
    "    pass\n"
)

# Filename written to the build context; the Dockerfile RUN step executes it.
_SHIM_INSTALLER_FILENAME = "_shipyard_shim_installer.py"

class ImageBuilderException(Exception):
    """Domain exception raised when image building or git checkout fails."""
    pass

class ImageBuilder:
    def __init__(self, workspace_root: str = "/tmp/shipyard-workspaces"):
        self.workspace_root = workspace_root
        os.makedirs(self.workspace_root, exist_ok=True)

    async def _run_command(
        self,
        cmd: List[str],
        cwd: str,
        timeout: int = 180,
        on_output: Optional[OutputCallback] = None,
    ) -> Tuple[int, str]:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT
        )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
            text = stdout.decode("utf-8", errors="replace")
        except asyncio.TimeoutError:
            process.kill()
            raise ImageBuilderException(f"Command '{' '.join(cmd)}' timed out after {timeout}s")

        # Surface the output to the caller (the deployment log stream) even
        # when the command fails, so a failed build is diagnosable from
        # GET /internal/v1/deployments/{id}/logs without host access.
        if on_output and text.strip():
            try:
                await on_output(text)
            except Exception as e:
                logger.warning(f"Failed to stream build output: {e}")

        return process.returncode or 0, text

    PYTHON_MARKERS = {"requirements.txt", "pyproject.toml", "Pipfile", "setup.py"}

    def detect_runtime(self, context_dir: str) -> str:
        """
        Best-effort runtime detection for synthetic Dockerfiles.
        An explicit package.json wins (Node monorepos often carry a stray
        requirements.txt); otherwise Python markers select Python.
        """
        try:
            files = set(os.listdir(context_dir))
        except OSError:
            return "node"

        has_node = "package.json" in files
        has_python = bool(files & self.PYTHON_MARKERS)

        if has_python and not has_node:
            return "python"
        return "node"

    def _write_shim_installer(self, context_dir: str) -> None:
        """Write a small Python installer script to the build context.

        The Dockerfile executes it with ``RUN python3 <file>`` during
        ``docker build``.  It installs ``_FLASK_BIND_SHIM`` as
        ``sitecustomize.py`` inside Python's site-packages directory.
        Python imports sitecustomize.py automatically on every startup,
        before any user module — so the patch is active even when the
        start command is just ``python app.py``.

        Flask does not need to be installed at build time; the file is
        written into site-packages unconditionally and only activates
        once Flask is importable (i.e. after ``pip install -r requirements.txt``
        runs inside the container CMD).
        """
        installer_path = os.path.join(context_dir, _SHIM_INSTALLER_FILENAME)
        # repr() produces a valid Python string literal, so no quoting issues.
        shim_repr = repr(_FLASK_BIND_SHIM)
        content = (
            "import site, os\n"
            f"shim = {shim_repr}\n"
            "for d in site.getsitepackages():\n"
            "    try:\n"
            "        os.makedirs(d, exist_ok=True)\n"
            "        with open(os.path.join(d, 'sitecustomize.py'), 'w') as f:\n"
            "            f.write(shim)\n"
            "        break\n"
            "    except Exception:\n"
            "        pass\n"
        )
        with open(installer_path, "w", encoding="utf-8") as f:
            f.write(content)

    @staticmethod
    def _patch_server_cmd(cmd: str) -> str:
        """Rewrite common WSGI/ASGI server invocations to bind 0.0.0.0.

        Handles three patterns that default to loopback:
        - ``gunicorn app:app``         → adds ``--bind 0.0.0.0:${PORT:-3000}``
        - ``uvicorn app:app``          → adds ``--host 0.0.0.0``
        - ``flask run``                → adds ``--host 0.0.0.0``

        ``python <script>.py`` style invocations are handled by the
        sitecustomize.py shim instead (no CMD rewrite needed).
        Already-correct commands (containing --bind / --host) are left alone.
        """
        if not cmd:
            return cmd

        # gunicorn: --bind controls both host and port
        if re.search(r"\bgunicorn\b", cmd) and "--bind" not in cmd and "-b " not in cmd:
            cmd = re.sub(r"(\bgunicorn\b)", r"\1 --bind 0.0.0.0:${PORT:-3000}", cmd, count=1)

        # uvicorn: --host controls the bind address
        if re.search(r"\buvicorn\b", cmd) and "--host" not in cmd:
            cmd = re.sub(r"(\buvicorn\b)", r"\1 --host 0.0.0.0", cmd, count=1)

        # flask run: --host controls the bind address
        if re.search(r"\bflask\s+run\b", cmd) and "--host" not in cmd:
            cmd = re.sub(r"(\bflask\s+run\b)", r"\1 --host 0.0.0.0", cmd, count=1)

        return cmd

    def _generate_synthetic_dockerfile(
        self,
        build_cmd: Optional[str],
        pre_deploy_cmd: Optional[str],
        start_cmd: Optional[str],
        runtime: str = "node"
    ) -> str:
        if runtime == "python":
            lines = [
                "FROM python:3.12-slim",
                "ENV PYTHONUNBUFFERED=1",
                # Layer 2: covers `flask run` invocations (CLI respects this env var)
                "ENV FLASK_RUN_HOST=0.0.0.0",
                "WORKDIR /app",
                # Install common build tools and client libraries needed for C extensions (e.g. psycopg2)
                "RUN apt-get update && apt-get install -y --no-install-recommends gcc libpq-dev python3-dev && rm -rf /var/lib/apt/lists/*",
                "COPY . .",
                # Install requirements at image build time so container startup does not time out downloading wheels
                "RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi",
                # Layer 1: installs sitecustomize.py → patches Flask.run() before
                # any user code executes, covering `python app.py` style starts.
                # The installer file is written to the context by build() below.
                f"RUN python3 {_SHIM_INSTALLER_FILENAME} && rm {_SHIM_INSTALLER_FILENAME}",
            ]
            default_start = "python app.py"
        else:
            lines = [
                "FROM node:20-alpine",
                "WORKDIR /app",
                "COPY . .",
            ]
            default_start = "npm start"

        if build_cmd:
            lines.append(f"RUN {build_cmd}")

        # Assemble entrypoint command chain
        run_cmds: List[str] = []
        if pre_deploy_cmd:
            run_cmds.append(pre_deploy_cmd)
        if start_cmd:
            # Layer 3: rewrite gunicorn/uvicorn/flask-run to bind 0.0.0.0
            patched = self._patch_server_cmd(start_cmd) if runtime == "python" else start_cmd
            run_cmds.append(patched)
        else:
            run_cmds.append(default_start)

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
        tag: str,
        on_output: Optional[OutputCallback] = None
    ) -> str:
        build_dir = os.path.join(self.workspace_root, deployment_id)
        if os.path.exists(build_dir):
            shutil.rmtree(build_dir, ignore_errors=True)
        os.makedirs(build_dir, exist_ok=True)

        try:
            # 1. Clone repository (depth=1 for minimal transfer)
            logger.info(f"Cloning {repo_url} (branch: {branch}) into {build_dir}")
            clone_cmd = ["git", "clone", "--depth", "1", "--branch", branch, repo_url, build_dir]
            code, out = await self._run_command(
                clone_cmd, cwd=self.workspace_root, timeout=120, on_output=on_output
            )
            if code != 0:
                raise ImageBuilderException(f"Git clone failed: {out.strip()}")

            target_context = os.path.join(build_dir, root_dir) if root_dir and root_dir != "." else build_dir
            if not os.path.exists(target_context):
                os.makedirs(target_context, exist_ok=True)

            dockerfile_path = os.path.join(target_context, "Dockerfile")

            # 2. Synthesize Dockerfile if none exists
            if not os.path.exists(dockerfile_path):
                runtime = self.detect_runtime(target_context)
                logger.info(f"Generating synthetic Dockerfile in {target_context} (runtime={runtime})")
                # Write the shim installer to the build context so that
                # the Dockerfile's RUN step can execute it during docker build.
                if runtime == "python":
                    self._write_shim_installer(target_context)
                synthetic = self._generate_synthetic_dockerfile(build_cmd, pre_deploy_cmd, start_cmd, runtime=runtime)
                with open(dockerfile_path, "w", encoding="utf-8") as f:
                    f.write(synthetic)

            # 3. Execute Docker build
            logger.info(f"Running docker build for {tag} in {target_context}")
            build_cmd_args = ["docker", "build", "-t", tag, target_context]
            code, out = await self._run_command(
                build_cmd_args, cwd=target_context, timeout=300, on_output=on_output
            )
            if code != 0:
                raise ImageBuilderException(f"Docker build failed: {out.strip()}")

            return tag
        finally:
            # Guarantee workspace cleanup
            if os.path.exists(build_dir):
                shutil.rmtree(build_dir, ignore_errors=True)
