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
    async def mock_run_command(cmd, cwd, timeout=180):
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
