from datetime import datetime
from typing import Any, Dict, Optional
from pydantic import BaseModel, ConfigDict, Field
from app.models.job import ServiceConfigSnapshot

class ExecuteJobRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    deployment_id: str = Field(..., alias="deploymentId")
    service_id: str = Field(..., alias="serviceId")
    project_id: str = Field(..., alias="projectId")
    commit_sha: str = Field(..., alias="commitSha")
    branch: str
    config_snapshot: ServiceConfigSnapshot = Field(..., alias="configSnapshot")

class JobExecutionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    job_id: str = Field(..., alias="jobId")
    status: str
    message: str

class JobStatusResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    deployment_id: str = Field(..., alias="deploymentId")
    executor_status: str = Field(..., alias="executorStatus")
    current_step: Optional[str] = Field(None, alias="currentStep")
    started_at: Optional[datetime] = Field(None, alias="startedAt")

class CancelJobResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    deployment_id: str = Field(..., alias="deploymentId")
    status: str
    message: str

class RetryJobResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    deployment_id: str = Field(..., alias="deploymentId")
    status: str
    retry_count: int = Field(..., alias="retryCount")

class ExecutionEventRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    event_type: str = Field(..., alias="eventType")
    message: str
    metadata: Dict[str, Any] = Field(default_factory=dict)

class ExecutionEventResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    event_id: str = Field(..., alias="eventId")
    status: str

class WorkerLogsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    deployment_id: str = Field(..., alias="deploymentId")
    logs: str
