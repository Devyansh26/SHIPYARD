import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI
from unittest.mock import AsyncMock, MagicMock

from app.routers.workers import router
from app.dependencies import get_db_pool, get_redis

class MockPoolContext:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass

@pytest.fixture
def test_app():
    app = FastAPI()
    app.include_router(router)
    return app

@pytest.mark.asyncio
async def test_worker_health_probe(test_app):
    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/internal/v1/workers/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "shipyard-container-deployer" in data["service"]

@pytest.mark.asyncio
async def test_worker_ready_probe_success(test_app):
    # Mock Redis and asyncpg Pool
    mock_redis = AsyncMock()
    mock_redis.ping = AsyncMock(return_value=True)

    mock_conn = AsyncMock()
    mock_conn.fetchval = AsyncMock(return_value=1)

    mock_pool = MagicMock()
    mock_pool.acquire.return_value = MockPoolContext(mock_conn)

    test_app.dependency_overrides[get_redis] = lambda: mock_redis
    test_app.dependency_overrides[get_db_pool] = lambda: mock_pool

    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/internal/v1/workers/ready")
        assert resp.status_code == 200
        data = resp.json()
        assert data["ready"] is True
        assert data["redis"] == "connected"
        assert data["postgres"] == "connected"

@pytest.mark.asyncio
async def test_worker_ready_probe_dependency_failure(test_app):
    mock_redis = AsyncMock()
    mock_redis.ping = AsyncMock(side_effect=Exception("Redis connection refused"))

    mock_conn = AsyncMock()
    mock_conn.fetchval = AsyncMock(return_value=1)

    mock_pool = MagicMock()
    mock_pool.acquire.return_value = MockPoolContext(mock_conn)

    test_app.dependency_overrides[get_redis] = lambda: mock_redis
    test_app.dependency_overrides[get_db_pool] = lambda: mock_pool

    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/internal/v1/workers/ready")
        assert resp.status_code == 503
        data = resp.json()
        assert data["ready"] is False
        assert "Redis connection refused" in data["error"]
