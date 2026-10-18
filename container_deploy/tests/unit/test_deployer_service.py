import pytest
from unittest.mock import AsyncMock, MagicMock

from app.models.job import DeploymentJob, ServiceConfigSnapshot
from app.services.deployer_service import DeployerService

class MockPoolContext:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass

@pytest.fixture
def mock_conn():
    conn = AsyncMock()
    conn.execute = AsyncMock()
    return conn

@pytest.fixture
def mock_db_pool(mock_conn):
    pool = MagicMock()
    pool.acquire.return_value = MockPoolContext(mock_conn)
    return pool

@pytest.fixture
def mock_image_builder():
    builder = MagicMock()
    builder.build = AsyncMock(return_value="shipyard-app/web:dep_100")
    return builder

@pytest.fixture
def mock_docker_runner():
    runner = MagicMock()
    runner.run_container = AsyncMock(return_value="cnt_456")
    runner.get_container_status = AsyncMock(return_value="running")
    runner.get_container_logs = AsyncMock(return_value="Server started on port 3000")
    runner.stop_container = AsyncMock()
    return runner

@pytest.fixture
def deployer(mock_db_pool, mock_image_builder, mock_docker_runner):
    return DeployerService(
        db_pool=mock_db_pool,
        image_builder=mock_image_builder,
        docker_runner=mock_docker_runner
    )

@pytest.fixture
def sample_job():
    return DeploymentJob(
        deployment_id="dep_100",
        service_id="svc_200",
        project_id="prj_300",
        commit_sha="abcdef",
        branch="main",
        config_snapshot=ServiceConfigSnapshot(
            service_id="svc_200",
            project_id="prj_300",
            service_name="web",
            service_type="backend",
            repository="https://github.com/org/web.git",
            branch="main",
            root_directory=".",
            build_command="npm run build",
            start_command="npm start"
        )
    )

@pytest.mark.asyncio
async def test_execute_happy_path(deployer, sample_job, mock_conn, mock_docker_runner):
    await deployer.execute(sample_job, healthcheck_max_retries=2, poll_interval=0.01)

    # Check docker runner invocation
    mock_docker_runner.run_container.assert_awaited_once()
    call_kwargs = mock_docker_runner.run_container.call_args[1]
    assert "shipyard-web-dep_100" in call_kwargs["container_name"]
    assert call_kwargs["image_tag"] == "shipyard-app/web:dep_100"

    # Check execute calls on PostgreSQL connection
    executed_queries = [call[0][0] for call in mock_conn.execute.call_args_list]
    
    # Assert events were recorded in deployment_events
    assert any("INSERT INTO deployment_events" in q for q in executed_queries)
    # Assert logs were recorded in deployment_logs
    assert any("INSERT INTO deployment_logs" in q for q in executed_queries)
    # Assert updates to deployments table
    assert any("UPDATE deployments" in q for q in executed_queries)

    # Find final update call
    update_calls = [call for call in mock_conn.execute.call_args_list if "UPDATE deployments" in call[0][0]]
    last_update = update_calls[-1]
    args = last_update[0]
    assert args[1] == "healthy"  # $1: status
    assert args[5] == "cnt_456"   # $5: container_id
    assert "web.local.shipyard.lan" in args[6]  # $6: deployment_url

@pytest.mark.asyncio
async def test_execute_build_failure(deployer, sample_job, mock_conn, mock_image_builder):
    mock_image_builder.build = AsyncMock(side_effect=Exception("Compilation error"))

    with pytest.raises(Exception) as exc:
        await deployer.execute(sample_job)
    assert "Compilation error" in str(exc.value)

    # Assert failed state set in deployments
    update_calls = [call for call in mock_conn.execute.call_args_list if "UPDATE deployments" in call[0][0]]
    last_update = update_calls[-1]
    assert last_update[0][1] == "failed"

    # Assert DEPLOYMENT_FAILED event inserted
    event_calls = [call for call in mock_conn.execute.call_args_list if "INSERT INTO deployment_events" in call[0][0]]
    last_event = event_calls[-1]
    assert last_event[0][3] == "DEPLOYMENT_FAILED"
    assert "Build failure" in last_event[0][4]

@pytest.mark.asyncio
async def test_execute_container_run_failure(deployer, sample_job, mock_conn, mock_docker_runner):
    mock_docker_runner.run_container = AsyncMock(side_effect=Exception("Docker engine unavailable"))

    with pytest.raises(Exception) as exc:
        await deployer.execute(sample_job)
    assert "Docker engine unavailable" in str(exc.value)

    update_calls = [call for call in mock_conn.execute.call_args_list if "UPDATE deployments" in call[0][0]]
    last_update = update_calls[-1]
    assert last_update[0][1] == "failed"

    event_calls = [call for call in mock_conn.execute.call_args_list if "INSERT INTO deployment_events" in call[0][0]]
    last_event = event_calls[-1]
    assert last_event[0][3] == "DEPLOYMENT_FAILED"
    assert "Workload creation failed" in last_event[0][4]

@pytest.mark.asyncio
async def test_execute_health_check_timeout(deployer, sample_job, mock_conn, mock_docker_runner):
    mock_docker_runner.get_container_status = AsyncMock(return_value="exited")

    with pytest.raises(TimeoutError):
        await deployer.execute(sample_job, healthcheck_max_retries=2, poll_interval=0.01)

    update_calls = [call for call in mock_conn.execute.call_args_list if "UPDATE deployments" in call[0][0]]
    last_update = update_calls[-1]
    assert last_update[0][1] == "failed"
