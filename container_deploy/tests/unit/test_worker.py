import json
import time
import pytest
from unittest.mock import AsyncMock, MagicMock

from app.config import Settings
from app.models.job import DeploymentJob, ServiceConfigSnapshot
from app.worker import DeploymentWorker

@pytest.fixture
def mock_redis():
    redis = MagicMock()
    redis.blpop = AsyncMock()
    redis.hset = AsyncMock()
    redis.hdel = AsyncMock()
    redis.hgetall = AsyncMock(return_value={})
    redis.rpush = AsyncMock()
    return redis

@pytest.fixture
def mock_deployer_service():
    service = MagicMock()
    service.execute = AsyncMock()
    service.mark_terminal_failed = AsyncMock()
    return service

@pytest.fixture
def settings():
    return Settings(
        QUEUE_NAME="test:deployments:queue",
        PROCESSING_SET="test:deployments:processing",
        MAX_JOB_RETRIES=2,
        JOB_TIMEOUT_SECONDS=300,
        INTERNAL_API_KEY="test_key"
    )

@pytest.fixture
def worker(mock_redis, mock_deployer_service, settings):
    return DeploymentWorker(
        redis_client=mock_redis,
        deployer_service=mock_deployer_service,
        settings=settings
    )

@pytest.fixture
def sample_payload():
    return {
        "deployment_id": "dep_test",
        "service_id": "svc_test",
        "project_id": "prj_test",
        "commit_sha": "123456",
        "branch": "main",
        "config_snapshot": {
            "service_id": "svc_test",
            "project_id": "prj_test",
            "service_name": "web",
            "service_type": "backend",
            "repository": "https://github.com/org/web.git",
            "branch": "main"
        },
        "retry_count": 0
    }

@pytest.mark.asyncio
async def test_handle_job_success(worker, mock_redis, mock_deployer_service, sample_payload):
    raw_json = json.dumps(sample_payload)
    await worker.handle_job(raw_json)

    # 1. Marked in processing set
    mock_redis.hset.assert_awaited_once()
    # 2. Executed
    mock_deployer_service.execute.assert_awaited_once()
    # 3. Removed from processing set
    mock_redis.hdel.assert_awaited_once_with(
        "test:deployments:processing",
        "dep_test:0"
    )

@pytest.mark.asyncio
async def test_handle_job_retry_on_failure(worker, mock_redis, mock_deployer_service, sample_payload):
    mock_deployer_service.execute.side_effect = Exception("Build timeout")

    raw_json = json.dumps(sample_payload)
    await worker.handle_job(raw_json)

    # Removed failed attempt from processing
    mock_redis.hdel.assert_awaited_once_with(
        "test:deployments:processing",
        "dep_test:0"
    )

    # Re-enqueued with retry_count = 1
    mock_redis.rpush.assert_awaited_once()
    re_enqueued_call_args = mock_redis.rpush.call_args[0]
    assert re_enqueued_call_args[0] == "test:deployments:queue"
    re_enqueued_data = json.loads(re_enqueued_call_args[1])
    assert re_enqueued_data["retry_count"] == 1

@pytest.mark.asyncio
async def test_handle_job_exceeded_max_retries(worker, mock_redis, mock_deployer_service, sample_payload):
    sample_payload["retry_count"] = 2  # Max is 2
    mock_deployer_service.execute.side_effect = Exception("Persistent crash")

    raw_json = json.dumps(sample_payload)
    await worker.handle_job(raw_json)

    # Not re-enqueued
    mock_redis.rpush.assert_not_called()
    # Marked as terminal failed
    mock_deployer_service.mark_terminal_failed.assert_awaited_once()
    assert "Exceeded max retries" in mock_deployer_service.mark_terminal_failed.call_args[0][1]

@pytest.mark.asyncio
async def test_recover_stuck_jobs(worker, mock_redis, sample_payload):
    stuck_time = time.time() - 400  # 400s ago, timeout is 300s
    mock_redis.hgetall.return_value = {
        b"dep_stuck:0": json.dumps({"payload": sample_payload, "timestamp": stuck_time}).encode("utf-8")
    }

    await worker.recover_stuck_jobs()

    # Removed from processing set and re-queued
    mock_redis.hdel.assert_awaited_once_with("test:deployments:processing", b"dep_stuck:0")
    mock_redis.rpush.assert_awaited_once_with("test:deployments:queue", json.dumps(sample_payload))

@pytest.mark.asyncio
async def test_start_loop_handles_timeout_silently(worker, mock_redis):
    # Simulate a TimeoutError on the first poll, then cancel
    worker.recover_stuck_jobs = AsyncMock()
    call_count = 0

    async def mock_blpop(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise TimeoutError("Timeout reading from Redis")
        worker.is_running = False
        return None

    mock_redis.blpop.side_effect = mock_blpop
    await worker.start()

    assert call_count >= 1
    assert worker.is_running is False

