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
    runner.get_container_ip = AsyncMock(return_value="172.17.0.9")
    runner.probe_port = AsyncMock(return_value=True)
    runner.remove_container = AsyncMock()
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
    assert args[6] == "https://shipyard-web-dep-100.divy13ansh.in"  # $6: deployment_url

    # Traefik routing labels must be attached for dynamic ingress
    assert call_kwargs["labels"]["traefik.enable"] == "true"
    assert any("Host(`shipyard-web-dep-100.divy13ansh.in`)" in v for v in call_kwargs["labels"].values())

@pytest.mark.asyncio
async def test_execute_lowercases_image_tag_for_mixed_case_service(deployer, sample_job, mock_image_builder, mock_docker_runner):
    """docker build rejects uppercase repository names; the tag must be sanitized."""
    sample_job.config_snapshot.service_name = "NightMark App"

    await deployer.execute(sample_job, healthcheck_max_retries=1, poll_interval=0.01)

    build_kwargs = mock_image_builder.build.call_args[1]
    assert build_kwargs["tag"] == "shipyard-app/nightmark-app:dep_100"
    assert mock_docker_runner.run_container.call_args[1]["image_tag"] == "shipyard-app/nightmark-app:dep_100"


def test_sanitize_image_name_cases():
    from app.services.deployer_service import sanitize_image_name

    assert sanitize_image_name("NightMark") == "nightmark"
    assert sanitize_image_name("NightMark App") == "nightmark-app"
    assert sanitize_image_name("NightMark/backend") == "nightmark-backend"
    assert sanitize_image_name("--weird__name--") == "weird__name"
    assert sanitize_image_name("") == "app"


@pytest.mark.asyncio
async def test_execute_persists_build_output_in_deployment_logs(deployer, sample_job, mock_conn, mock_image_builder):
    """GET /deployments/{id}/logs must show build output, not only runtime logs."""
    async def fake_build(**kwargs):
        await kwargs["on_output"]("#8 [4/4] RUN npm run build\nnpm error Missing script: \"build\"\n")
        return "shipyard-app/web:dep_100"

    mock_image_builder.build = AsyncMock(side_effect=fake_build)

    await deployer.execute(sample_job, healthcheck_max_retries=1, poll_interval=0.01)

    log_calls = [c for c in mock_conn.execute.call_args_list if "INSERT INTO deployment_logs" in c[0][0]]
    contents = [c[0][4] for c in log_calls]
    assert any("Missing script" in text for text in contents)


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
async def test_execute_probes_declared_port(deployer, sample_job, mock_docker_runner):
    sample_job.config_snapshot.ports = [{"containerPort": 5000}]

    await deployer.execute(sample_job, healthcheck_max_retries=2, poll_interval=0.01)

    mock_docker_runner.get_container_ip.assert_awaited()
    mock_docker_runner.probe_port.assert_awaited_with("172.17.0.9", 5000)


@pytest.mark.asyncio
async def test_execute_running_but_unreachable_fails(deployer, sample_job, mock_conn, mock_docker_runner):
    """Running container with no listener must fail, not be reported healthy."""
    sample_job.config_snapshot.ports = [{"containerPort": 5000}]
    mock_docker_runner.probe_port = AsyncMock(return_value=False)
    mock_docker_runner.get_container_logs = AsyncMock(
        return_value=" * Running on http://127.0.0.1:5000\nINFO:werkzeug:Press CTRL+C to quit"
    )

    with pytest.raises(TimeoutError) as exc:
        await deployer.execute(sample_job, healthcheck_max_retries=2, poll_interval=0.01)

    assert "bound to loopback" in str(exc.value)

    update_calls = [call for call in mock_conn.execute.call_args_list if "UPDATE deployments" in call[0][0]]
    assert update_calls[-1][0][1] == "failed"
    event_calls = [call for call in mock_conn.execute.call_args_list if "INSERT INTO deployment_events" in call[0][0]]
    event_types = [c[0][3] for c in event_calls]
    assert "UNREACHABLE_PORT" in event_types
    assert "RELEASE_HEALTHY" not in event_types
    # ...and the broken workload must not be left running on the host
    mock_docker_runner.remove_container.assert_awaited_once_with("cnt_456")


@pytest.mark.asyncio
async def test_execute_cleanup_failure_does_not_mask_error(deployer, sample_job, mock_docker_runner):
    sample_job.config_snapshot.ports = [{"containerPort": 5000}]
    mock_docker_runner.probe_port = AsyncMock(return_value=False)
    mock_docker_runner.remove_container = AsyncMock(side_effect=Exception("docker rm failed"))

    with pytest.raises(TimeoutError):
        await deployer.execute(sample_job, healthcheck_max_retries=1, poll_interval=0.01)


def test_diagnose_unreachable_cases():
    from app.services.deployer_service import DeployerService

    svc = DeployerService.__new__(DeployerService)

    loopback = svc.diagnose_unreachable("* Running on http://127.0.0.1:5000", [5000])
    assert "loopback" in loopback and "5000" in loopback

    localhost = svc.diagnose_unreachable("listening on http://localhost:8000", [8000])
    assert "loopback" in localhost

    silent = svc.diagnose_unreachable("sh: python: not found", [5000])
    assert "loopback" not in silent
    assert "0.0.0.0" in silent


@pytest.mark.asyncio
async def test_execute_health_check_timeout(deployer, sample_job, mock_conn, mock_docker_runner):
    mock_docker_runner.get_container_status = AsyncMock(return_value="exited")

    with pytest.raises(TimeoutError):
        await deployer.execute(sample_job, healthcheck_max_retries=2, poll_interval=0.01)

    update_calls = [call for call in mock_conn.execute.call_args_list if "UPDATE deployments" in call[0][0]]
    last_update = update_calls[-1]
    assert last_update[0][1] == "failed"


@pytest.mark.asyncio
async def test_execute_reconciles_env_var_port_over_default_ports(deployer, sample_job, mock_docker_runner):
    """When PORT=4000 is specified in env_vars, primary_port and Traefik routing must use 4000."""
    sample_job.config_snapshot.ports = [{"containerPort": 3000}]
    sample_job.config_snapshot.env_vars = [{"key": "PORT", "value": "4000"}]

    await deployer.execute(sample_job, healthcheck_max_retries=2, poll_interval=0.01)

    call_kwargs = mock_docker_runner.run_container.call_args[1]
    # Check Traefik routed to port 4000
    assert any("loadbalancer.server.port=4000" in v or k.endswith("loadbalancer.server.port") and v == "4000"
               for k, v in call_kwargs["labels"].items())
    # Check effective ports
    assert call_kwargs["ports"][0]["containerPort"] == 4000
    # Check probe probed port 4000
    mock_docker_runner.probe_port.assert_awaited_with("172.17.0.9", 4000)


@pytest.mark.asyncio
async def test_execute_injects_port_when_missing_from_env_vars(deployer, sample_job, mock_docker_runner):
    """12-factor apps expect $PORT. When missing, the deployer should inject PORT=<primary_port>."""
    sample_job.config_snapshot.ports = [{"containerPort": 8080}]
    sample_job.config_snapshot.env_vars = [{"key": "DATABASE_URL", "value": "postgres://..."}]

    await deployer.execute(sample_job, healthcheck_max_retries=2, poll_interval=0.01)

    call_kwargs = mock_docker_runner.run_container.call_args[1]
    env_keys = {ev["key"]: ev.get("value") for ev in call_kwargs["env_vars"]}
    assert env_keys.get("PORT") == "8080"


def test_diagnose_unreachable_with_active_listeners():
    from app.services.deployer_service import DeployerService

    svc = DeployerService.__new__(DeployerService)

    # Detects loopback listener
    loopback_msg = svc.diagnose_unreachable("", [3000], active_listeners=[("loopback", 5000)])
    assert "bound to loopback" in loopback_msg
    assert "127.0.0.1:5000" in loopback_msg

    # Detects port mismatch (app opened 4000, but route expected 3000)
    mismatch_msg = svc.diagnose_unreachable("", [3000], active_listeners=[("all", 4000)])
    assert "listening on port 4000" in mismatch_msg
    assert "route traffic to port 3000" in mismatch_msg

    # Detects premature container exit/crash
    crash_msg = svc.diagnose_unreachable("Error: pg_config not found\nexit code 1", [5000], container_status="exited")
    assert "crashed or exited prematurely" in crash_msg
    assert "exit code 1" in crash_msg
