import os
import pytest
from app.services.image_builder import ImageBuilder, ImageBuilderException

def test_generate_synthetic_dockerfile():
    builder = ImageBuilder(workspace_root="/tmp/test-shipyard-workspaces")
    dockerfile = builder._generate_synthetic_dockerfile(
        build_cmd="npm install && npm run build",
        pre_deploy_cmd="npx prisma migrate deploy",
        start_cmd="node dist/index.js"
    )
    assert "FROM node:20-alpine" in dockerfile
    assert "WORKDIR /app" in dockerfile
    assert "RUN npm install && npm run build" in dockerfile
    assert 'CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]' in dockerfile

def test_generate_synthetic_dockerfile_defaults():
    builder = ImageBuilder(workspace_root="/tmp/test-shipyard-workspaces")
    dockerfile = builder._generate_synthetic_dockerfile(
        build_cmd=None,
        pre_deploy_cmd=None,
        start_cmd=None
    )
    assert 'CMD ["sh", "-c", "npm start"]' in dockerfile

def test_generate_synthetic_dockerfile_python():
    builder = ImageBuilder(workspace_root="/tmp/test-shipyard-workspaces")
    dockerfile = builder._generate_synthetic_dockerfile(
        build_cmd=None,
        pre_deploy_cmd="pip install -r requirements.txt",
        start_cmd="python app.py",
        runtime="python"
    )
    assert "FROM python:3.12-slim" in dockerfile
    assert "node:" not in dockerfile
    assert "PYTHONUNBUFFERED=1" in dockerfile
    assert "libpq-dev" in dockerfile
    assert "gcc" in dockerfile
    assert 'CMD ["sh", "-c", "pip install -r requirements.txt && python app.py"]' in dockerfile


def test_detect_runtime_python(tmp_path):
    (tmp_path / "requirements.txt").write_text("flask\n")
    (tmp_path / "app.py").write_text("print('hi')\n")
    builder = ImageBuilder(workspace_root=str(tmp_path / "ws"))
    assert builder.detect_runtime(str(tmp_path)) == "python"


def test_detect_runtime_node(tmp_path):
    (tmp_path / "package.json").write_text("{}\n")
    builder = ImageBuilder(workspace_root=str(tmp_path / "ws"))
    assert builder.detect_runtime(str(tmp_path)) == "node"


def test_detect_runtime_node_wins_when_both(tmp_path):
    (tmp_path / "package.json").write_text("{}\n")
    (tmp_path / "requirements.txt").write_text("flask\n")
    builder = ImageBuilder(workspace_root=str(tmp_path / "ws"))
    assert builder.detect_runtime(str(tmp_path)) == "node"


@pytest.mark.asyncio
async def test_build_clone_failure(mocker, tmp_path):
    builder = ImageBuilder(workspace_root=str(tmp_path))
    
    # Mock subprocess return code != 0
    mocker.patch.object(
        builder,
        "_run_command",
        return_value=(128, "fatal: repository not found")
    )

    with pytest.raises(ImageBuilderException) as exc:
        await builder.build(
            deployment_id="dep_fail",
            repo_url="https://github.com/invalid/repo.git",
            branch="main",
            commit_sha="123",
            root_dir=".",
            build_cmd=None,
            pre_deploy_cmd=None,
            start_cmd=None,
            tag="shipyard-app/demo:dep_fail"
        )
    assert "Git clone failed: fatal: repository not found" in str(exc.value)

@pytest.mark.asyncio
async def test_build_success(mocker, tmp_path):
    builder = ImageBuilder(workspace_root=str(tmp_path))
    
    # Mock successful git clone and docker build
    async def mock_run_command(cmd, cwd, timeout=180, on_output=None):
        # Simulate creating directory
        return (0, "Successfully executed")

    mocker.patch.object(builder, "_run_command", side_effect=mock_run_command)

    tag = await builder.build(
        deployment_id="dep_success",
        repo_url="https://github.com/valid/repo.git",
        branch="main",
        commit_sha="123",
        root_dir=".",
        build_cmd="npm test",
        pre_deploy_cmd=None,
        start_cmd="npm start",
        tag="shipyard-app/demo:dep_success"
    )
    assert tag == "shipyard-app/demo:dep_success"
    # Ensure workspace was cleaned up
    assert not os.path.exists(os.path.join(str(tmp_path), "dep_success"))


@pytest.mark.asyncio
async def test_build_streams_command_output_to_callback(mocker, tmp_path):
    """Build output must reach the deployment log stream, not just stderr."""
    builder = ImageBuilder(workspace_root=str(tmp_path))
    chunks = []

    async def on_output(text):
        chunks.append(text)

    async def mock_run_command(cmd, cwd, timeout=180, on_output=None):
        output = "Cloning into ..." if cmd[0] == "git" else "Step 1/4 : FROM node:20-alpine"
        if on_output:
            await on_output(output)
        return (0, output)

    mocker.patch.object(builder, "_run_command", side_effect=mock_run_command)

    await builder.build(
        deployment_id="dep_stream",
        repo_url="https://github.com/valid/repo.git",
        branch="main",
        commit_sha="123",
        root_dir=".",
        build_cmd=None,
        pre_deploy_cmd=None,
        start_cmd="npm start",
        tag="shipyard-app/demo:dep_stream",
        on_output=on_output
    )

    assert any("Cloning into" in c for c in chunks)
    assert any("Step 1/4" in c for c in chunks)


@pytest.mark.asyncio
async def test_build_failure_streams_output_before_raising(mocker, tmp_path):
    builder = ImageBuilder(workspace_root=str(tmp_path))
    chunks = []

    async def on_output(text):
        chunks.append(text)

    async def mock_run_command(cmd, cwd, timeout=180, on_output=None):
        output = "fatal: repository not found"
        if on_output:
            await on_output(output)
        return (128, output)

    mocker.patch.object(builder, "_run_command", side_effect=mock_run_command)

    with pytest.raises(ImageBuilderException):
        await builder.build(
            deployment_id="dep_fail_stream",
            repo_url="https://github.com/invalid/repo.git",
            branch="main",
            commit_sha="123",
            root_dir=".",
            build_cmd=None,
            pre_deploy_cmd=None,
            start_cmd=None,
            tag="shipyard-app/demo:dep_fail_stream",
            on_output=on_output
        )

    assert any("repository not found" in c for c in chunks)
