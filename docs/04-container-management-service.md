# 04 - Container Management Service LLD

## 1. Executive Summary & Responsibility Boundary

- **Service Name:** `container-management`
- **Type:** Internal Microservice
- **Language & Runtime:** Python 3.11+, FastAPI, Uvicorn (ASGI)
- **Port:** `8001`
- **Network Exposure:** Private Homelab Network only (isolated VLAN / Docker bridge). **Never exposed to public internet or Nginx ingress.**
- **Primary Responsibility:** Coordinate low-level container runtime lifecycle (Docker daemon interaction), maintain container state records in MongoDB, and safely redact sensitive configuration details (e.g., secrets, raw credentials) during inspection operations.

```
       +---------------------------------------------+
       |   Control API (Node.js) / Deployer (Python) |
       +---------------------------------------------+
                              |
                     Internal HTTP / REST
                     Header: X-API-Key
                              v
       +---------------------------------------------+
       |       Container Management Service          |
       |       FastAPI App (Port 8001)               |
       |                                             |
       |  +------------------+  +-----------------+  |
       |  | ContainerService |  | DockerService   |  |
       |  +------------------+  +-----------------+  |
       +---------------------------------------------+
                  |                         |
                  v                         v
       +--------------------+      +--------------------+
       |  MongoDB (Motor)   |      |   /var/run/docker.sock
       |  (containers coll) |      |   (Docker Engine)  |
       +--------------------+      +--------------------+
```

---

## 2. Directory Structure

```text
container-management/
├── app/
│   ├── __init__.py
│   ├── main.py                  # Application factory, lifespan, CORS & exception handlers
│   ├── config.py                # Pydantic BaseSettings singleton
│   ├── dependencies.py          # FastAPI dependency injection providers (db, docker, auth)
│   ├── models/
│   │   ├── __init__.py
│   │   └── container.py         # MongoDB document representations & state enums
│   ├── schemas/
│   │   ├── __init__.py
│   │   └── container.py         # Request/response DTOs with Pydantic v2
│   ├── services/
│   │   ├── __init__.py
│   │   ├── docker_service.py    # Direct Docker Engine SDK interaction & error translation
│   │   ├── encryption_service.py# Secret decryption helper (AES-256-GCM)
│   │   └── container_service.py # Orchestrates DB state transitions + Docker actions
│   ├── routers/
│   │   ├── __init__.py
│   │   └── containers.py        # 10 internal REST endpoints under /internal/v1/containers
│   └── middleware/
│       ├── __init__.py
│       └── auth.py              # Constant-time comparison for X-API-Key validation
├── tests/
│   ├── __init__.py
│   ├── conftest.py              # Fixtures: async client, mocked docker client, in-memory DB
│   ├── unit/
│   │   ├── test_docker_service.py
│   │   └── test_container_service.py
│   └── integration/
│       └── test_container_routes.py
├── requirements.txt
├── Dockerfile
└── pytest.ini
```

---

## 3. Configuration Management (`app/config.py`)

### 3.1 Implementation
```python
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    """
    Application settings loaded from environment variables or .env file.
    Follows 12-factor configuration principles.
    """
    APP_NAME: str = "shipyard-container-management"
    ENVIRONMENT: str = "production"
    LOG_LEVEL: str = "INFO"
    PORT: int = 8001
    HOST: str = "0.0.0.0"

    # Database
    MONGO_URI: str = "mongodb://mongodb:27017"
    MONGO_DB_NAME: str = "shipyard"

    # Docker Engine
    DOCKER_SOCKET: str = "unix:///var/run/docker.sock"
    DOCKER_DEFAULT_NETWORK: str = "shipyard_network"

    # Security
    INTERNAL_API_KEY: str  # Mandatory: fail startup if unset
    ENCRYPTION_MASTER_KEY: str  # 32-byte hex for decrypting secret_ref

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True
    )

@lru_cache()
def get_settings() -> Settings:
    """Return cached singleton instance of application settings."""
    return Settings()
```

### 3.2 Design Rationale
- **Why `pydantic-settings`:** Provides type enforcement, automatic parsing from env vars, and fails fast on service boot if critical secrets (`INTERNAL_API_KEY`, `ENCRYPTION_MASTER_KEY`) are omitted.
- **Why `lru_cache`:** Avoids re-parsing `.env` and disk/environment lookups across request lifecycles.

---

## 4. Data Models & Schemas

### 4.1 MongoDB Document Model (`app/models/container.py`)
```python
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

class ContainerStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    STOPPED = "stopped"
    FAILED = "failed"
    REMOVED = "removed"

class ContainerDocument(BaseModel):
    """
    Internal MongoDB persistence model stored in 'containers' collection.
    """
    id: str = Field(alias="_id")
    container_id: str  # Primary identifier, e.g., cnt_a1b2c3d4
    docker_container_id: Optional[str] = None  # Docker 64-char hex ID
    deployment_id: str
    service_id: str
    image: str
    status: ContainerStatus = ContainerStatus.PENDING
    ports: List[Dict[str, Any]] = Field(default_factory=list)
    resources: Dict[str, Any] = Field(default_factory=dict)
    health_check: Optional[Dict[str, Any]] = None
    env_keys: List[str] = Field(default_factory=list)  # Only key names, never raw secrets
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    metadata: Dict[str, Any] = Field(default_factory=dict)

    class Config:
        populate_by_name = True
        use_enum_values = True
```

### 4.2 Request and Response Schemas (`app/schemas/container.py`)
```python
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field

class PortMapping(BaseModel):
    container_port: int = Field(..., alias="containerPort", ge=1, le=65535)
    host_port: Optional[int] = Field(None, alias="hostPort", ge=1, le=65535)
    protocol: str = Field("tcp", pattern="^(tcp|udp)$")

class ResourceLimits(BaseModel):
    cpu_limit: str = Field("1.0", alias="cpuLimit", description="e.g. '0.5', '1', '2'")
    memory_limit: str = Field("512Mi", alias="memoryLimit", description="e.g. '256Mi', '1Gi'")

class HealthCheckConfig(BaseModel):
    path: str = Field("/health", description="HTTP health check path")
    port: int = Field(8000, description="HTTP port to query")
    interval_seconds: int = Field(10, alias="intervalSeconds")
    timeout_seconds: int = Field(5, alias="timeoutSeconds")
    retries: int = Field(3)

class EnvVariableInput(BaseModel):
    key: str
    secret_ref: str = Field(..., alias="secretRef")

class CreateContainerRequest(BaseModel):
    deployment_id: str = Field(..., alias="deploymentId")
    service_id: str = Field(..., alias="serviceId")
    image: str
    ports: List[PortMapping] = Field(default_factory=list)
    resources: ResourceLimits = Field(default_factory=ResourceLimits)
    health_check: Optional[HealthCheckConfig] = Field(None, alias="healthCheck")
    env: List[EnvVariableInput] = Field(default_factory=list)

class ContainerResponse(BaseModel):
    container_id: str = Field(..., alias="containerId")
    deployment_id: str = Field(..., alias="deploymentId")
    service_id: str = Field(..., alias="serviceId")
    image: str
    status: str
    ports: List[PortMapping]
    resources: ResourceLimits
    created_at: datetime = Field(..., alias="createdAt")

class ContainerStatsResponse(BaseModel):
    container_id: str = Field(..., alias="containerId")
    cpu_percent: float = Field(..., alias="cpuPercent")
    memory_usage_mb: float = Field(..., alias="memoryUsageMb")
    memory_limit_mb: float = Field(..., alias="memoryLimitMb")
    network_rx_bytes: int = Field(..., alias="networkRxBytes")
    network_tx_bytes: int = Field(..., alias="networkTxBytes")

class ContainerLogsResponse(BaseModel):
    container_id: str = Field(..., alias="containerId")
    logs: str

class ContainerHealthResponse(BaseModel):
    container_id: str = Field(..., alias="containerId")
    status: str  # healthy | unhealthy | starting | none
    failing_streak: int = Field(0, alias="failingStreak")
    log: List[dict] = Field(default_factory=list)
```

---

## 5. Service Layer Implementations

### 5.1 Docker Service (`app/services/docker_service.py`)
**Responsibility:** Low-level encapsulation of the `docker-py` client. Translates raw Docker exceptions into strongly typed domain exceptions.

```python
import logging
from typing import Any, Dict, List, Optional
import docker
from docker.errors import APIError, NotFound, DockerException

logger = logging.getLogger(__name__)

class DockerServiceException(Exception):
    """Base exception for docker interactions."""
    pass

class ContainerNotFoundException(DockerServiceException):
    """Container not found on Docker daemon."""
    pass

class DockerService:
    def __init__(self, base_url: str = "unix:///var/run/docker.sock"):
        try:
            self.client = docker.DockerClient(base_url=base_url)
        except DockerException as e:
            logger.error(f"Failed to initialize Docker Client: {e}")
            raise DockerServiceException(f"Docker daemon connection failed: {e}")

    def create_and_run(
        self,
        name: str,
        image: str,
        ports: List[Dict[str, Any]],
        cpu_quota: int,  # e.g., 100000 = 1 CPU
        memory_bytes: int,  # e.g., 512 * 1024 * 1024
        env: Dict[str, str],
        labels: Dict[str, str],
        network: str
    ) -> str:
        """
        Creates and starts a detached Docker container with security sandboxing.
        Returns the 64-char Docker container ID.
        """
        port_bindings = {}
        for p in ports:
            c_port = f"{p['container_port']}/{p['protocol']}"
            port_bindings[c_port] = p.get("host_port")

        try:
            container = self.client.containers.run(
                image=image,
                name=name,
                detach=True,
                environment=env,
                ports=port_bindings if port_bindings else None,
                cpu_quota=cpu_quota,
                cpu_period=100000,
                mem_limit=memory_bytes,
                memswap_limit=memory_bytes,  # Disable swap amplification
                restart_policy={"Name": "on-failure", "MaximumRetryCount": 5},
                network=network,
                labels=labels,
                security_opt=["no-new-privileges:true"]  # Prevent privilege escalation
            )
            return container.id
        except APIError as e:
            logger.error(f"Docker API Error during run: {e}")
            raise DockerServiceException(f"Failed to run container: {e.explanation}")

    def get_container(self, docker_id: str):
        try:
            return self.client.containers.get(docker_id)
        except NotFound:
            raise ContainerNotFoundException(f"Container {docker_id} not found.")
        except APIError as e:
            raise DockerServiceException(f"Docker query failed: {e}")

    def start(self, docker_id: str) -> None:
        c = self.get_container(docker_id)
        c.start()

    def stop(self, docker_id: str, timeout: int = 10) -> None:
        c = self.get_container(docker_id)
        c.stop(timeout=timeout)

    def restart(self, docker_id: str, timeout: int = 10) -> None:
        c = self.get_container(docker_id)
        c.restart(timeout=timeout)

    def remove(self, docker_id: str, force: bool = False) -> None:
        c = self.get_container(docker_id)
        c.remove(force=force)

    def get_logs(self, docker_id: str, tail: int = 500) -> str:
        c = self.get_container(docker_id)
        raw = c.logs(stdout=True, stderr=True, tail=tail, timestamps=True)
        return raw.decode("utf-8", errors="replace")

    def get_stats(self, docker_id: str) -> Dict[str, Any]:
        """Reads a single stats sample without streaming."""
        c = self.get_container(docker_id)
        stats = c.stats(stream=False)
        return stats

    def get_health(self, docker_id: str) -> Dict[str, Any]:
        c = self.get_container(docker_id)
        c.reload()
        state = c.attrs.get("State", {})
        return state.get("Health", {"Status": "none"})
```

### 5.2 Container Service (`app/services/container_service.py`)
**Responsibility:** Business logic layer. Resolves secret references, enforces business constraints, interacts with Motor (async MongoDB), and manages container states.

```python
import math
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.container import ContainerDocument, ContainerStatus
from app.schemas.container import (
    CreateContainerRequest,
    ContainerStatsResponse,
    ContainerHealthResponse,
    ResourceLimits
)
from app.services.docker_service import DockerService
from app.services.encryption_service import EncryptionService

class ContainerService:
    def __init__(
        self,
        db: AsyncIOMotorDatabase,
        docker_service: DockerService,
        encryption_service: EncryptionService
    ):
        self.db = db
        self.collection = db["containers"]
        self.docker_service = docker_service
        self.encryption_service = encryption_service

    def _parse_memory_limit(self, mem_str: str) -> int:
        """Parses human readable memory strings (512Mi, 1Gi) into bytes."""
        unit = mem_str[-2:].upper()
        val = float(mem_str[:-2])
        if unit == "MI":
            return int(val * 1024 * 1024)
        elif unit == "GI":
            return int(val * 1024 * 1024 * 1024)
        elif unit == "KB":
            return int(val * 1024)
        return int(mem_str)

    def _parse_cpu_limit(self, cpu_str: str) -> int:
        """Parses CPU limit (e.g. '0.5', '1') into CFS quota with 100,000 period."""
        return int(float(cpu_str) * 100000)

    async def create_container(self, req: CreateContainerRequest) -> ContainerDocument:
        # 1. Generate internal unique container ID
        cnt_id = f"cnt_{uuid.uuid4().hex[:12]}"

        # 2. Resolve secret references into plaintext environment dictionary
        resolved_env: Dict[str, str] = {}
        env_keys: List[str] = []
        for item in req.env:
            env_keys.append(item.key)
            # Decrypt secret_ref into raw plaintext secret for container runtime
            resolved_env[item.key] = self.encryption_service.decrypt(item.secret_ref)

        # 3. Parse resource constraints
        cpu_quota = self._parse_cpu_limit(req.resources.cpu_limit)
        mem_bytes = self._parse_memory_limit(req.resources.memory_limit)

        # 4. Prepare ports structure
        ports_dict = [p.model_dump() for p in req.ports]

        # 5. Execute Docker run
        labels = {
            "shipyard.service_id": req.service_id,
            "shipyard.deployment_id": req.deployment_id,
            "shipyard.container_id": cnt_id
        }
        
        docker_id = self.docker_service.create_and_run(
            name=f"shipyard-{cnt_id}",
            image=req.image,
            ports=ports_dict,
            cpu_quota=cpu_quota,
            memory_bytes=mem_bytes,
            env=resolved_env,
            labels=labels,
            network="shipyard_network"
        )

        # 6. Persist record in MongoDB (redacted: env values NEVER saved)
        doc = ContainerDocument(
            _id=cnt_id,
            container_id=cnt_id,
            docker_container_id=docker_id,
            deployment_id=req.deployment_id,
            service_id=req.service_id,
            image=req.image,
            status=ContainerStatus.RUNNING,
            ports=ports_dict,
            resources=req.resources.model_dump(),
            health_check=req.health_check.model_dump() if req.health_check else None,
            env_keys=env_keys,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow()
        )

        await self.collection.insert_one(doc.model_dump(by_alias=True))
        return doc

    async def get_container(self, container_id: str) -> Optional[ContainerDocument]:
        record = await self.collection.find_one({"container_id": container_id})
        if not record:
            return None
        return ContainerDocument.model_validate(record)

    async def list_containers(self, skip: int = 0, limit: int = 50) -> List[ContainerDocument]:
        cursor = self.collection.find({"status": {"$ne": ContainerStatus.REMOVED}}).skip(skip).limit(limit)
        items = []
        async for doc in cursor:
            items.append(ContainerDocument.model_validate(doc))
        return items

    async def start_container(self, container_id: str) -> ContainerDocument:
        doc = await self.get_container(container_id)
        if not doc or not doc.docker_container_id:
            raise ValueError(f"Container {container_id} not found.")
        self.docker_service.start(doc.docker_container_id)
        await self.collection.update_one(
            {"container_id": container_id},
            {"$set": {"status": ContainerStatus.RUNNING, "updated_at": datetime.utcnow()}}
        )
        doc.status = ContainerStatus.RUNNING
        return doc

    async def stop_container(self, container_id: str) -> ContainerDocument:
        doc = await self.get_container(container_id)
        if not doc or not doc.docker_container_id:
            raise ValueError(f"Container {container_id} not found.")
        self.docker_service.stop(doc.docker_container_id)
        await self.collection.update_one(
            {"container_id": container_id},
            {"$set": {"status": ContainerStatus.STOPPED, "updated_at": datetime.utcnow()}}
        )
        doc.status = ContainerStatus.STOPPED
        return doc

    async def restart_container(self, container_id: str) -> ContainerDocument:
        doc = await self.get_container(container_id)
        if not doc or not doc.docker_container_id:
            raise ValueError(f"Container {container_id} not found.")
        self.docker_service.restart(doc.docker_container_id)
        await self.collection.update_one(
            {"container_id": container_id},
            {"$set": {"status": ContainerStatus.RUNNING, "updated_at": datetime.utcnow()}}
        )
        doc.status = ContainerStatus.RUNNING
        return doc

    async def remove_container(self, container_id: str) -> None:
        doc = await self.get_container(container_id)
        if not doc or not doc.docker_container_id:
            raise ValueError(f"Container {container_id} not found.")
        if doc.status == ContainerStatus.RUNNING:
            raise RuntimeError(f"Cannot remove running container {container_id}. Stop it first.")
        self.docker_service.remove(doc.docker_container_id)
        await self.collection.update_one(
            {"container_id": container_id},
            {"$set": {"status": ContainerStatus.REMOVED, "updated_at": datetime.utcnow()}}
        )

    async def get_logs(self, container_id: str) -> str:
        doc = await self.get_container(container_id)
        if not doc or not doc.docker_container_id:
            raise ValueError(f"Container {container_id} not found.")
        return self.docker_service.get_logs(doc.docker_container_id)

    async def get_stats(self, container_id: str) -> ContainerStatsResponse:
        doc = await self.get_container(container_id)
        if not doc or not doc.docker_container_id:
            raise ValueError(f"Container {container_id} not found.")
        raw_stats = self.docker_service.get_stats(doc.docker_container_id)

        # Parse CPU %
        cpu_delta = (
            raw_stats["cpu_stats"]["cpu_usage"]["total_usage"]
            - raw_stats["precpu_stats"]["cpu_usage"]["total_usage"]
        )
        system_delta = (
            raw_stats["cpu_stats"].get("system_cpu_usage", 0)
            - raw_stats["precpu_stats"].get("system_cpu_usage", 0)
        )
        cpu_count = raw_stats["cpu_stats"].get("online_cpus", 1)
        cpu_percent = 0.0
        if system_delta > 0 and cpu_delta > 0:
            cpu_percent = (cpu_delta / system_delta) * cpu_count * 100.0

        # Parse Memory
        mem_usage = raw_stats["memory_stats"].get("usage", 0) / (1024 * 1024)
        mem_limit = raw_stats["memory_stats"].get("limit", 1) / (1024 * 1024)

        # Parse Network
        networks = raw_stats.get("networks", {})
        rx = sum(net.get("rx_bytes", 0) for net in networks.values())
        tx = sum(net.get("tx_bytes", 0) for net in networks.values())

        return ContainerStatsResponse(
            container_id=container_id,
            cpu_percent=round(cpu_percent, 2),
            memory_usage_mb=round(mem_usage, 2),
            memory_limit_mb=round(mem_limit, 2),
            network_rx_bytes=rx,
            network_tx_bytes=tx
        )

    async def get_health(self, container_id: str) -> ContainerHealthResponse:
        doc = await self.get_container(container_id)
        if not doc or not doc.docker_container_id:
            raise ValueError(f"Container {container_id} not found.")
        raw_health = self.docker_service.get_health(doc.docker_container_id)
        status = raw_health.get("Status", "none").lower()
        failing_streak = raw_health.get("FailingStreak", 0)
        log = raw_health.get("Log", [])
        return ContainerHealthResponse(
            container_id=container_id,
            status=status,
            failing_streak=failing_streak,
            log=log
        )
```

---

## 6. Authentication Middleware (`app/middleware/auth.py`)

```python
import secrets
from fastapi import Header, HTTPException, status
from app.config import get_settings

async def verify_internal_api_key(x_api_key: str = Header(..., alias="X-API-Key")) -> None:
    """
    Enforces internal API key authentication.
    Uses constant-time comparison to guard against timing attacks.
    """
    settings = get_settings()
    if not secrets.compare_digest(x_api_key, settings.INTERNAL_API_KEY):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: Invalid internal authentication key"
        )
```

---

## 7. Router Endpoints (`app/routers/containers.py`)

All endpoints require `Depends(verify_internal_api_key)`.

| Method | Endpoint | Handler | Return Code | Summary |
| --- | --- | --- | --- | --- |
| `POST` | `/internal/v1/containers` | `create_container` | `201 Created` | Create and launch container workload |
| `GET` | `/internal/v1/containers` | `list_containers` | `200 OK` | List managed containers |
| `GET` | `/internal/v1/containers/{container_id}` | `get_container` | `200 OK` | Get container details (redacted secrets) |
| `POST` | `/internal/v1/containers/{container_id}/start` | `start_container` | `200 OK` | Start stopped container |
| `POST` | `/internal/v1/containers/{container_id}/stop` | `stop_container` | `200 OK` | Stop running container |
| `POST` | `/internal/v1/containers/{container_id}/restart` | `restart_container` | `200 OK` | Restart container |
| `DELETE`| `/internal/v1/containers/{container_id}` | `remove_container` | `204 No Content`| Remove stopped container |
| `GET` | `/internal/v1/containers/{container_id}/logs` | `get_logs` | `200 OK` | Retrieve stdout/stderr logs |
| `GET` | `/internal/v1/containers/{container_id}/health` | `get_health` | `200 OK` | Inspect container health check state |
| `GET` | `/internal/v1/containers/{container_id}/stats` | `get_stats` | `200 OK` | Inspect container CPU, memory & network |

### Router Code Example:
```python
from fastapi import APIRouter, Depends, HTTPException, status
from app.middleware.auth import verify_internal_api_key
from app.dependencies import get_container_service
from app.schemas.container import (
    CreateContainerRequest, ContainerResponse, ContainerStatsResponse,
    ContainerLogsResponse, ContainerHealthResponse
)
from app.services.container_service import ContainerService

router = APIRouter(
    prefix="/internal/v1/containers",
    tags=["containers"],
    dependencies=[Depends(verify_internal_api_key)]
)

@router.post("", response_model=ContainerResponse, status_code=status.HTTP_201_CREATED)
async def create_container_endpoint(
    req: CreateContainerRequest,
    service: ContainerService = Depends(get_container_service)
):
    doc = await service.create_container(req)
    return ContainerResponse(
        container_id=doc.container_id,
        deployment_id=doc.deployment_id,
        service_id=doc.service_id,
        image=doc.image,
        status=doc.status,
        ports=doc.ports,
        resources=doc.resources,
        created_at=doc.created_at
    )
```

---

## 8. Test-Driven Development (TDD) Strategy

### 8.1 Test Suites Setup
- **Framework:** `pytest`, `pytest-asyncio`, `httpx.AsyncClient`
- **Mocks:** Unit tests mock `docker.DockerClient` and Motor `AsyncIOMotorDatabase`. Integration tests run against an in-memory/ephemeral MongoDB or test container.

### 8.2 Test Matrix
1. **`test_auth_failure`:** Assert `403 Forbidden` when `X-API-Key` is missing or mismatched.
2. **`test_create_container_redaction`:** Assert container created returns response without any secret values, and DB document contains only `env_keys`.
3. **`test_remove_running_container_fails`:** Assert calling `DELETE` on a running container raises `400 Bad Request` or `409 Conflict`.
4. **`test_stats_calculation`:** Assert CPU delta calculation divides correctly by system delta and handles division by zero safely.
5. **`test_docker_error_translation`:** Assert `docker.errors.NotFound` translates to `404 Not Found` in HTTP response rather than 500 stack trace.
