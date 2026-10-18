import pytest
import httpx
from app.services.management_client import ManagementClient, ManagementServiceException

@pytest.fixture
def client():
    return ManagementClient(
        base_url="http://mock-container-management:8001",
        api_key="test_api_key"
    )

@pytest.mark.asyncio
async def test_create_container_success(client, monkeypatch):
    async def mock_handler(request: httpx.Request):
        assert request.headers["x-api-key"] == "test_api_key"
        assert request.url.path == "/internal/v1/containers"
        return httpx.Response(201, json={"containerId": "cnt_123", "status": "running"})

    transport = httpx.MockTransport(mock_handler)
    client._transport = transport

    res = await client.create_container({"serviceId": "svc_1"})
    assert res["containerId"] == "cnt_123"
    assert res["status"] == "running"

@pytest.mark.asyncio
async def test_create_container_failure(client):
    async def mock_handler(request: httpx.Request):
        return httpx.Response(400, text="Invalid port mapping")

    transport = httpx.MockTransport(mock_handler)
    client._transport = transport

    with pytest.raises(ManagementServiceException) as exc:
        await client.create_container({"serviceId": "svc_1"})
    assert "Create container failed (400)" in str(exc.value)

@pytest.mark.asyncio
async def test_get_health_success(client):
    async def mock_handler(request: httpx.Request):
        assert request.url.path == "/internal/v1/containers/cnt_123/health"
        return httpx.Response(200, json={"containerId": "cnt_123", "status": "healthy"})

    transport = httpx.MockTransport(mock_handler)
    client._transport = transport

    res = await client.get_health("cnt_123")
    assert res["status"] == "healthy"

@pytest.mark.asyncio
async def test_stop_container_success(client):
    async def mock_handler(request: httpx.Request):
        assert request.url.path == "/internal/v1/containers/cnt_123/stop"
        return httpx.Response(200, json={"containerId": "cnt_123", "status": "stopped"})

    transport = httpx.MockTransport(mock_handler)
    client._transport = transport

    res = await client.stop_container("cnt_123")
    assert res["status"] == "stopped"
