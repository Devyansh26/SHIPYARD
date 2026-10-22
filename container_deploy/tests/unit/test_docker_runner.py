import pytest
from unittest.mock import AsyncMock, patch

from app.services.docker_runner import DockerRunner, DockerRunnerException

@pytest.fixture
def runner():
    return DockerRunner()

@pytest.mark.asyncio
async def test_run_container_success(runner):
    with patch.object(runner, "_run_cmd", new_callable=AsyncMock) as mock_cmd:
        # First call is docker rm -f, second is docker run -d
        mock_cmd.side_effect = [
            (0, "shipyard-web-123\n"),
            (0, "c1a2b3d4e5f67890abcdef\n")
        ]

        container_id = await runner.run_container(
            container_name="shipyard-web-123",
            image_tag="shipyard-app/web:123",
            ports=[{"containerPort": 8080, "hostPort": 8080}],
            resources={"memoryLimit": "256Mi", "cpuLimit": 0.5},
            env_vars=[{"key": "NODE_ENV", "value": "production"}],
            labels={"shipyard.deployment_id": "dep_123"}
        )

        assert container_id == "c1a2b3d4e5f6"
        assert mock_cmd.call_count == 2
        # Check docker run arguments
        run_args = mock_cmd.call_args_list[1][0][0]
        assert "run" in run_args
        assert "-d" in run_args
        assert "--name" in run_args
        assert "shipyard-web-123" in run_args
        assert "-p" in run_args
        assert "8080:8080" in run_args
        assert "--memory" in run_args
        assert "256m" in run_args
        assert "--cpus" in run_args
        assert "0.5" in run_args
        assert "-e" in run_args
        assert "NODE_ENV=production" in run_args
        assert "--label" in run_args
        assert "shipyard.deployment_id=dep_123" in run_args
        assert "shipyard-app/web:123" in run_args

@pytest.mark.asyncio
async def test_run_container_failure(runner):
    with patch.object(runner, "_run_cmd", new_callable=AsyncMock) as mock_cmd:
        mock_cmd.side_effect = [
            (0, ""),
            (1, "docker: Error response from daemon: port already allocated\n")
        ]

        with pytest.raises(DockerRunnerException) as exc:
            await runner.run_container(
                container_name="test-fail",
                image_tag="test:latest",
                ports=[],
                resources={},
                env_vars=[]
            )
        assert "docker run failed" in str(exc.value)

@pytest.mark.asyncio
async def test_get_container_status(runner):
    with patch.object(runner, "_run_cmd", new_callable=AsyncMock) as mock_cmd:
        mock_cmd.return_value = (0, "running\n")
        status = await runner.get_container_status("c1a2b3d4e5f6")
        assert status == "running"

        mock_cmd.return_value = (1, "No such container")
        status_err = await runner.get_container_status("nonexistent")
        assert status_err == "unknown"

@pytest.mark.asyncio
async def test_get_container_logs(runner):
    with patch.object(runner, "_run_cmd", new_callable=AsyncMock) as mock_cmd:
        mock_cmd.return_value = (0, "Log line 1\nLog line 2\n")
        logs = await runner.get_container_logs("c1a2b3d4e5f6")
        assert "Log line 1" in logs
        assert "Log line 2" in logs

@pytest.mark.asyncio
async def test_stop_container(runner):
    with patch.object(runner, "_run_cmd", new_callable=AsyncMock) as mock_cmd:
        mock_cmd.return_value = (0, "c1a2b3d4e5f6\n")
        await runner.stop_container("c1a2b3d4e5f6")
        mock_cmd.assert_awaited_once_with(["docker", "stop", "c1a2b3d4e5f6"], timeout=15)
