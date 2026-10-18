import pytest
from pydantic import ValidationError
from app.models.job import DeploymentJob, ServiceConfigSnapshot, DeploymentStatus
from app.schemas.deployment import ExecuteJobRequest, ExecutionEventRequest

def test_service_config_snapshot_defaults():
    cfg = ServiceConfigSnapshot(
        service_id="svc_123",
        project_id="prj_123",
        service_name="api",
        service_type="backend",
        repository="https://github.com/org/repo.git",
        branch="main"
    )
    assert cfg.root_directory == "."
    assert cfg.env_vars == []
    assert cfg.ports == []
    assert cfg.resources == {}
    assert cfg.health_check is None

def test_deployment_job_serialization():
    data = {
        "deployment_id": "dep_001",
        "service_id": "svc_123",
        "project_id": "prj_123",
        "commit_sha": "abc12345",
        "branch": "main",
        "config_snapshot": {
            "service_id": "svc_123",
            "project_id": "prj_123",
            "service_name": "api",
            "service_type": "backend",
            "repository": "https://github.com/org/repo.git",
            "branch": "main"
        },
        "retry_count": 0
    }
    job = DeploymentJob.model_validate(data)
    assert job.deployment_id == "dep_001"
    assert job.config_snapshot.service_name == "api"
    assert job.retry_count == 0

def test_deployment_job_missing_required_fields():
    with pytest.raises(ValidationError):
        # Missing deployment_id
        DeploymentJob.model_validate({
            "service_id": "svc_123",
            "commit_sha": "abc12345"
        })

def test_execute_job_request_camel_case_parsing():
    payload = {
        "deploymentId": "dep_camel",
        "serviceId": "svc_camel",
        "projectId": "prj_camel",
        "commitSha": "deadbeef",
        "branch": "main",
        "configSnapshot": {
            "service_id": "svc_camel",
            "project_id": "prj_camel",
            "service_name": "worker",
            "service_type": "backend",
            "repository": "https://github.com/org/worker.git",
            "branch": "main"
        }
    }
    req = ExecuteJobRequest.model_validate(payload)
    assert req.deployment_id == "dep_camel"
    assert req.service_id == "svc_camel"
    assert req.commit_sha == "deadbeef"

def test_execution_event_request():
    event = ExecutionEventRequest(
        eventType="BUILD_STEP",
        message="Compiling assets",
        metadata={"step": 2}
    )
    assert event.event_type == "BUILD_STEP"
    assert event.metadata["step"] == 2
