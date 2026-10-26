from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, ConfigDict, Field

class DeploymentStatus(str, Enum):
    QUEUED = "queued"
    VALIDATING = "validating"
    BUILDING = "building"
    DEPLOYING = "deploying"
    HEALTHY = "healthy"
    FAILED = "failed"
    CANCELLED = "cancelled"
    ROLLING_BACK = "rolling_back"
    ROLLED_BACK = "rolled_back"

class ServiceConfigSnapshot(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    service_id: str
    project_id: str
    service_name: str
    service_type: str
    repository: str
    branch: str = "main"
    root_directory: Optional[str] = "."
    build_command: Optional[str] = None
    pre_deploy_command: Optional[str] = None
    start_command: Optional[str] = None
    # Optional because upstream backends legitimately send `null` for unset
    # fields. Downstream consumers use `or <default>` fallbacks.
    env_vars: Optional[List[Dict[str, Any]]] = Field(default_factory=list)  # [{"key": "...", "secret_ref": "..."}]
    ports: Optional[List[Dict[str, Any]]] = Field(default_factory=list)
    resources: Optional[Dict[str, Any]] = Field(default_factory=dict)
    health_check: Optional[Dict[str, Any]] = None

class DeploymentJob(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    deployment_id: str
    service_id: str
    project_id: str
    commit_sha: str
    branch: str
    config_snapshot: ServiceConfigSnapshot
    retry_count: int = 0
