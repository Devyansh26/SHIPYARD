import json
import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI
from unittest.mock import AsyncMock, MagicMock

from app.routers.deployments import router
from app.dependencies import get_db_pool, get_redis, get_deployer_service
from app.middleware.auth import verify_internal_api_key

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
    conn.fetchrow = AsyncMock()
    conn.fetch = AsyncMock()
    conn.execute = AsyncMock()
    return conn

@pytest.fixture
def mock_db_pool(mock_conn):
    pool = MagicMock()
    pool.acquire.return_value = MockPoolContext(mock_conn)
    return pool

@pytest.fixture
def mock_redis():
    redis = MagicMock()
    redis.rpush = AsyncMock()
    return redis

@pytest.fixture
def mock_deployer():
    deployer = MagicMock()
    deployer.execute = AsyncMock()
    deployer.set_state = AsyncMock()
    deployer.emit_event = AsyncMock()
    return deployer

@pytest.fixture
def test_app(mock_db_pool, mock_redis, mock_deployer):
    app = FastAPI()
    app.include_router(router)

    # Dependency overrides
    app.dependency_overrides[get_db_pool] = lambda: mock_db_pool
    app.dependency_overrides[get_redis] = lambda: mock_redis
    app.dependency_overrides[get_deployer_service] = lambda: mock_deployer
    app.dependency_overrides[verify_internal_api_key] = lambda: None

    return app

@pytest.fixture
def client(test_app):
    transport = ASGITransport(app=test_app)
    return AsyncClient(transport=transport, base_url="http://test")

@pytest.mark.asyncio
async def test_execute_deployment_endpoint(client, mock_deployer):
    payload = {
        "deploymentId": "dep_api_1",
        "serviceId": "svc_api_1",
        "projectId": "prj_api_1",
        "commitSha": "abc1234",
        "branch": "main",
        "configSnapshot": {
            "service_id": "svc_api_1",
            "project_id": "prj_api_1",
            "service_name": "web",
            "service_type": "backend",
            "repository": "https://github.com/org/web.git",
            "branch": "main"
        }
    }

    async with client as c:
        resp = await c.post("/internal/v1/deployments/execute", json=payload)
        assert resp.status_code == 202
        data = resp.json()
        assert data["status"] == "executing"
        assert "jobId" in data

@pytest.mark.asyncio
async def test_get_deployment_status(client, mock_conn):
    mock_conn.fetchrow.return_value = {
        "deployment_id": "dep_status_1",
        "status": "building",
        "started_at": None
    }

    async with client as c:
        resp = await c.get("/internal/v1/deployments/dep_status_1")
        assert resp.status_code == 200
        data = resp.json()
        assert data["executorStatus"] == "building"

@pytest.mark.asyncio
async def test_cancel_deployment_endpoint(client, mock_conn, mock_deployer):
    mock_conn.fetchrow.return_value = {
        "status": "building"
    }

    async with client as c:
        resp = await c.post("/internal/v1/deployments/dep_cancel_1/cancel")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "cancelled"
        mock_deployer.set_state.assert_awaited_once_with("dep_cancel_1", "cancelled")

@pytest.mark.asyncio
async def test_record_deployment_event(client, mock_deployer):
    event_payload = {
        "eventType": "HEALTH_OK",
        "message": "Health check responded with 200",
        "metadata": {"latencyMs": 15}
    }

    async with client as c:
        resp = await c.post("/internal/v1/deployments/dep_event_1/events", json=event_payload)
        assert resp.status_code == 201
        data = resp.json()
        assert data["status"] == "recorded"
        mock_deployer.emit_event.assert_awaited_once()

@pytest.mark.asyncio
async def test_get_deployment_logs(client, mock_conn):
    mock_conn.fetch.return_value = [
        {"log_content": "Building image...\n"},
        {"log_content": "Image built successfully.\n"}
    ]

    async with client as c:
        resp = await c.get("/internal/v1/deployments/dep_logs_1/logs")
        assert resp.status_code == 200
        data = resp.json()
        assert "Building image..." in data["logs"]
        assert "Image built successfully." in data["logs"]
