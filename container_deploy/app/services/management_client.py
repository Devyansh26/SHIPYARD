import logging
from typing import Any, Dict, Optional
import httpx

logger = logging.getLogger(__name__)

class ManagementServiceException(Exception):
    """Domain exception raised when upstream Container Management Service fails."""
    pass

class ManagementClient:
    def __init__(self, base_url: str, api_key: str, transport: Optional[httpx.AsyncBaseTransport] = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._transport = transport
        self.headers = {
            "X-API-Key": self.api_key,
            "Content-Type": "application/json"
        }

    def _get_client(self, timeout: float = 30.0) -> httpx.AsyncClient:
        kwargs: Dict[str, Any] = {"timeout": timeout}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        return httpx.AsyncClient(**kwargs)

    async def create_container(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.base_url}/internal/v1/containers"
        async with self._get_client(timeout=30.0) as client:
            try:
                resp = await client.post(url, json=payload, headers=self.headers)
                if resp.status_code != 201:
                    raise ManagementServiceException(
                        f"Create container failed ({resp.status_code}): {resp.text}"
                    )
                return resp.json()
            except httpx.RequestError as exc:
                raise ManagementServiceException(f"Network error calling Container Management: {exc}")

    async def get_container(self, container_id: str) -> Dict[str, Any]:
        url = f"{self.base_url}/internal/v1/containers/{container_id}"
        async with self._get_client(timeout=10.0) as client:
            try:
                resp = await client.get(url, headers=self.headers)
                if resp.status_code != 200:
                    raise ManagementServiceException(
                        f"Get container failed ({resp.status_code}): {resp.text}"
                    )
                return resp.json()
            except httpx.RequestError as exc:
                raise ManagementServiceException(f"Network error calling Container Management: {exc}")

    async def start_container(self, container_id: str) -> Dict[str, Any]:
        url = f"{self.base_url}/internal/v1/containers/{container_id}/start"
        async with self._get_client(timeout=15.0) as client:
            try:
                resp = await client.post(url, headers=self.headers)
                if resp.status_code != 200:
                    raise ManagementServiceException(
                        f"Start container failed ({resp.status_code}): {resp.text}"
                    )
                return resp.json()
            except httpx.RequestError as exc:
                raise ManagementServiceException(f"Network error calling Container Management: {exc}")

    async def stop_container(self, container_id: str) -> Dict[str, Any]:
        url = f"{self.base_url}/internal/v1/containers/{container_id}/stop"
        async with self._get_client(timeout=15.0) as client:
            try:
                resp = await client.post(url, headers=self.headers)
                if resp.status_code != 200:
                    raise ManagementServiceException(
                        f"Stop container failed ({resp.status_code}): {resp.text}"
                    )
                return resp.json()
            except httpx.RequestError as exc:
                raise ManagementServiceException(f"Network error calling Container Management: {exc}")

    async def get_health(self, container_id: str) -> Dict[str, Any]:
        url = f"{self.base_url}/internal/v1/containers/{container_id}/health"
        async with self._get_client(timeout=10.0) as client:
            try:
                resp = await client.get(url, headers=self.headers)
                if resp.status_code != 200:
                    raise ManagementServiceException(
                        f"Health check failed ({resp.status_code}): {resp.text}"
                    )
                return resp.json()
            except httpx.RequestError as exc:
                raise ManagementServiceException(f"Network error calling Container Management: {exc}")

    async def get_logs(self, container_id: str, tail: int = 500) -> str:
        url = f"{self.base_url}/internal/v1/containers/{container_id}/logs"
        async with self._get_client(timeout=15.0) as client:
            try:
                resp = await client.get(url, params={"tail": tail}, headers=self.headers)
                if resp.status_code != 200:
                    raise ManagementServiceException(
                        f"Get logs failed ({resp.status_code}): {resp.text}"
                    )
                return resp.json().get("logs", "")
            except httpx.RequestError as exc:
                raise ManagementServiceException(f"Network error calling Container Management: {exc}")
