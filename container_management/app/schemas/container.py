"""Request/response DTOs for the Container Management Service (Pydantic v2).

JSON is camelCase on the wire (``deploymentId``, ``secretRef`` ...) while
Python code uses snake_case; ``populate_by_name=True`` accepts both, and the
routers serialize with ``by_alias=True``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

#: Safe HTTP path for a container healthcheck.
#:
#: Deliberately an *allowlist*: ``DockerService._build_healthcheck`` embeds this
#: value in a ``CMD-SHELL`` string, so anything shell-interpretable here would
#: be command injection inside the created container (e.g. ``/health; rm -rf /``).
HEALTH_PATH_PATTERN = r"^/[A-Za-z0-9._~%/-]*(?:\?[A-Za-z0-9._~%&=+-]*)?$"

#: Environment variable names accepted from the Deployer (POSIX identifier).
#: Blocks ``KEY=VALUE`` smuggling and empty/odd names reaching Docker.
ENV_KEY_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]*$"

#: Defensive per-container caps (homelab scale; see also ContainerService).
MAX_PORTS = 32
MAX_ENV_VARS = 100


class PortMapping(BaseModel):
    """A single container/host port mapping."""

    model_config = ConfigDict(populate_by_name=True)

    container_port: int = Field(..., alias="containerPort", ge=1, le=65535)
    host_port: Optional[int] = Field(None, alias="hostPort", ge=1, le=65535)
    protocol: str = Field("tcp", pattern="^(tcp|udp)$")


class ResourceLimits(BaseModel):
    """CPU and memory limits as human-readable strings."""

    model_config = ConfigDict(populate_by_name=True)

    cpu_limit: str = Field("1.0", alias="cpuLimit", description="e.g. '0.5', '1', '2'")
    memory_limit: str = Field(
        "512Mi", alias="memoryLimit", description="e.g. '256Mi', '1Gi'"
    )


class HealthCheckConfig(BaseModel):
    """HTTP health check configuration for a container.

    All fields are bounded: the path is additionally allowlist-validated because
    it is interpolated into the container's shell-based healthcheck command.
    """

    model_config = ConfigDict(populate_by_name=True)

    path: str = Field(
        "/health",
        pattern=HEALTH_PATH_PATTERN,
        max_length=256,
        description="HTTP health check path (allowlisted; no shell metacharacters)",
    )
    port: int = Field(8000, ge=1, le=65535, description="HTTP port to query")
    interval_seconds: int = Field(10, alias="intervalSeconds", ge=1, le=3600)
    timeout_seconds: int = Field(5, alias="timeoutSeconds", ge=1, le=60)
    retries: int = Field(3, ge=1, le=100)


class EnvVariableInput(BaseModel):
    """An encrypted environment variable supplied at container creation.

    ``secret_ref`` is never persisted, returned, or logged (``repr=False``).
    """

    model_config = ConfigDict(populate_by_name=True)

    key: str = Field(..., min_length=1, max_length=128, pattern=ENV_KEY_PATTERN)
    secret_ref: str = Field(
        ..., alias="secretRef", repr=False, min_length=1, max_length=8192
    )


class CreateContainerRequest(BaseModel):
    """Body of ``POST /internal/v1/containers``.

    Field lengths and collection sizes are bounded so a single request cannot
    exhaust memory/log lines on the ``CMD-SHELL``/Docker path.
    """

    model_config = ConfigDict(populate_by_name=True)

    deployment_id: str = Field(..., alias="deploymentId", min_length=1, max_length=128)
    service_id: str = Field(..., alias="serviceId", min_length=1, max_length=128)
    image: str = Field(..., min_length=1, max_length=512)
    ports: List[PortMapping] = Field(default_factory=list, max_length=MAX_PORTS)
    resources: ResourceLimits = Field(default_factory=ResourceLimits)
    health_check: Optional[HealthCheckConfig] = Field(None, alias="healthCheck")
    env: List[EnvVariableInput] = Field(default_factory=list, max_length=MAX_ENV_VARS)


class ContainerResponse(BaseModel):
    """Redacted container view returned by the API (no env values)."""

    model_config = ConfigDict(populate_by_name=True)

    container_id: str = Field(..., alias="containerId")
    deployment_id: str = Field(..., alias="deploymentId")
    service_id: str = Field(..., alias="serviceId")
    image: str
    status: str
    ports: List[PortMapping]
    resources: ResourceLimits
    created_at: datetime = Field(..., alias="createdAt")


class ContainerActionResponse(BaseModel):
    """Result of a lifecycle action (start/stop/restart)."""

    model_config = ConfigDict(populate_by_name=True)

    container_id: str = Field(..., alias="containerId")
    status: str


class ContainerStatsResponse(BaseModel):
    """Single-snapshot container resource utilization."""

    model_config = ConfigDict(populate_by_name=True)

    container_id: str = Field(..., alias="containerId")
    cpu_percent: float = Field(..., alias="cpuPercent")
    memory_usage_mb: float = Field(..., alias="memoryUsageMb")
    memory_limit_mb: float = Field(..., alias="memoryLimitMb")
    network_rx_bytes: int = Field(..., alias="networkRxBytes")
    network_tx_bytes: int = Field(..., alias="networkTxBytes")


class ContainerLogsResponse(BaseModel):
    """Merged stdout/stderr log payload."""

    model_config = ConfigDict(populate_by_name=True)

    container_id: str = Field(..., alias="containerId")
    logs: str


class ContainerHealthResponse(BaseModel):
    """Docker healthcheck state for a container."""

    model_config = ConfigDict(populate_by_name=True)

    container_id: str = Field(..., alias="containerId")
    status: str
    failing_streak: int = Field(0, alias="failingStreak")
    log: List[Dict[str, Any]] = Field(default_factory=list)
