"""Job and request shapes.

The create-job payload mirrors the agreed contract EXACTLY, including its mixed
casing: snake_case at the top level and inside `config_snapshot`, but camelCase
inside `ports[]` and `resources`. Do not "tidy" that — the worker parses these
keys. `populate_by_name` lets callers send either spelling; serialisation always
emits the contract spelling via `by_alias=True`.
"""
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ServiceType = Literal["backend", "frontend", "database"]

# Mirrors the deployments.status CHECK in Postgres.
DeploymentStatus = Literal[
    "queued", "validating", "building", "deploying",
    "healthy", "failed", "cancelled", "rolling_back", "rolled_back",
]


class StrictModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class PortMapping(StrictModel):
    # camelCase on purpose — see module docstring.
    container_port: int = Field(..., alias="containerPort", ge=1, le=65535)
    host_port: int | None = Field(None, alias="hostPort", ge=1, le=65535)
    protocol: Literal["tcp", "udp"] = "tcp"


class Resources(StrictModel):
    cpu_limit: str | None = Field(None, alias="cpuLimit", examples=["1.0"])
    memory_limit: str | None = Field(None, alias="memoryLimit", examples=["512Mi"])


class HealthCheck(StrictModel):
    path: str = "/health"
    port: int | None = Field(None, ge=1, le=65535)


class EnvVar(StrictModel):
    key: str = Field(..., min_length=1, max_length=255)
    # Plaintext by necessity: the worker has to hand these to the container.
    # Never log an EnvVar — see `queue.py` and the README's security note.
    value: str


class ConfigSnapshot(StrictModel):
    service_id: str
    project_id: str
    service_name: str
    service_type: ServiceType = "backend"
    # Full git URL the worker can clone, e.g. https://github.com/org/repo.git
    repository: str
    branch: str = "main"
    root_directory: str = "."
    build_command: str | None = None
    pre_deploy_command: str | None = None
    start_command: str | None = None
    env_vars: list[EnvVar] = Field(default_factory=list)
    ports: list[PortMapping] = Field(default_factory=list)
    resources: Resources | None = None
    health_check: HealthCheck | None = None


class Supersedes(StrictModel):
    """The deployment this one replaces.

    Present on a redeploy of an already-running service. CMS holds it until the
    new deployment reports healthy, then enqueues the teardown of the old
    container — create first, delete second, so a failed build never takes the
    running container down with it.
    """
    deployment_id: str
    container_id: str
    service_id: str | None = None
    project_id: str | None = None


class DeploymentRequest(StrictModel):
    deployment_id: str = Field(..., min_length=1, max_length=64)
    service_id: str = Field(..., min_length=1, max_length=64)
    project_id: str = Field(..., min_length=1, max_length=64)
    commit_sha: str = Field(..., min_length=1, max_length=64)
    branch: str = "main"
    retry_count: int = Field(0, ge=0)
    config_snapshot: ConfigSnapshot
    # Control-plane-only; stripped from the enqueued job (the worker handles one
    # deployment and does not need to know what it replaces).
    supersedes: Supersedes | None = None


class DeletionRequest(StrictModel):
    """Teardown of one container.

    Used for both "the user deleted this service" and "this old deployment was
    superseded". `container_id` is what the worker actually needs; the ids are
    carried for traceability.
    """
    container_id: str = Field(..., min_length=1)
    deployment_id: str | None = None
    service_id: str | None = None
    project_id: str | None = None
    reason: Literal["service_deleted", "superseded", "manual", "rollback"] = "manual"


class CallbackRequest(StrictModel):
    """What the worker reports once it has processed a deployment job."""
    status: DeploymentStatus
    container_id: str | None = None
    image_id: str | None = None
    deployment_url: str | None = None
    error: str | None = None


# --- responses ---------------------------------------------------------------


class EnqueuedResponse(BaseModel):
    queued: bool
    queue: str
    job_id: str
    deployment_id: str | None = None
    container_id: str | None = None
    queue_depth: int
    # True when this exact deployment_id was already enqueued inside the
    # idempotency window and we did NOT push a duplicate.
    duplicate: bool = False
    supersede_pending: bool = False


class CallbackResponse(BaseModel):
    deployment_id: str
    status: str
    supersede_enqueued: bool
    supersede_container_id: str | None = None
    forwarded_to_control_plane: bool
    detail: str | None = None


class QueueDepths(BaseModel):
    deployments: int
    deletions: int
    keys: dict[str, str]


class Health(BaseModel):
    status: str
    service: str = "container-management"
    detail: dict[str, Any] | None = None
