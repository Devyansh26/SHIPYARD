import asyncio
import json
import uuid
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
import asyncpg
import redis.asyncio as aioredis

from app.config import get_settings, Settings
from app.dependencies import get_db_pool, get_redis, get_deployer_service
from app.middleware.auth import verify_internal_api_key
from app.models.job import DeploymentJob
from app.schemas.deployment import (
    ExecuteJobRequest,
    JobExecutionResponse,
    JobStatusResponse,
    CancelJobResponse,
    RetryJobResponse,
    ExecutionEventRequest,
    ExecutionEventResponse,
    WorkerLogsResponse
)
from app.services.deployer_service import DeployerService

router = APIRouter(
    prefix="/internal/v1/deployments",
    tags=["deployments"],
    dependencies=[Depends(verify_internal_api_key)]
)

@router.post("/execute", response_model=JobExecutionResponse, status_code=status.HTTP_202_ACCEPTED)
async def execute_deployment(
    req: ExecuteJobRequest,
    background_tasks: BackgroundTasks,
    deployer: DeployerService = Depends(get_deployer_service)
):
    job = DeploymentJob(
        deployment_id=req.deployment_id,
        service_id=req.service_id,
        project_id=req.project_id,
        commit_sha=req.commit_sha,
        branch=req.branch,
        config_snapshot=req.config_snapshot
    )
    # Launch background executor task
    background_tasks.add_task(deployer.execute, job)

    return JobExecutionResponse(
        job_id=f"job_{req.deployment_id}",
        status="executing",
        message="Deployment initiated on executor worker"
    )

@router.get("/{deployment_id}", response_model=JobStatusResponse)
async def get_deployment_status(
    deployment_id: str,
    db_pool: asyncpg.Pool = Depends(get_db_pool)
):
    query = """
        SELECT deployment_id, status, started_at
        FROM deployments
        WHERE deployment_id = $1
    """
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(query, deployment_id)

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Deployment {deployment_id} not found"
        )

    return JobStatusResponse(
        deployment_id=row["deployment_id"],
        executor_status=row["status"],
        current_step=None,
        started_at=row["started_at"]
    )

@router.post("/{deployment_id}/cancel", response_model=CancelJobResponse)
async def cancel_deployment(
    deployment_id: str,
    db_pool: asyncpg.Pool = Depends(get_db_pool),
    deployer: DeployerService = Depends(get_deployer_service)
):
    query = "SELECT status FROM deployments WHERE deployment_id = $1"
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(query, deployment_id)

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Deployment {deployment_id} not found"
        )

    current_status = row["status"]
    if current_status in ["healthy", "failed", "cancelled", "rolled_back"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Deployment is already in terminal state: {current_status}"
        )

    await deployer.set_state(deployment_id, "cancelled")
    await deployer.emit_event(deployment_id, "DEPLOYMENT_CANCELLED", "Deployment cancelled by user request")

    return CancelJobResponse(
        deployment_id=deployment_id,
        status="cancelled",
        message="Execution pipeline terminated"
    )

@router.post("/{deployment_id}/retry", response_model=RetryJobResponse)
async def retry_deployment(
    deployment_id: str,
    db_pool: asyncpg.Pool = Depends(get_db_pool),
    redis_client: aioredis.Redis = Depends(get_redis),
    settings: Settings = Depends(get_settings)
):
    query = """
        SELECT deployment_id, service_id, commit_sha, branch, config_snapshot
        FROM deployments
        WHERE deployment_id = $1
    """
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(query, deployment_id)

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Deployment {deployment_id} not found"
        )

    config_snapshot = row["config_snapshot"]
    if isinstance(config_snapshot, str):
        config_snapshot = json.loads(config_snapshot)

    job_payload = {
        "deployment_id": deployment_id,
        "service_id": row["service_id"],
        "project_id": config_snapshot.get("project_id", ""),
        "commit_sha": row["commit_sha"],
        "branch": row["branch"],
        "config_snapshot": config_snapshot,
        "retry_count": 0
    }

    # Re-enqueue in Redis queue
    await redis_client.rpush(
        settings.QUEUE_NAME,
        DeploymentJob.model_validate(job_payload).model_dump_json()
    )

    update_query = "UPDATE deployments SET status = 'queued', finished_at = NULL WHERE deployment_id = $1"
    async with db_pool.acquire() as conn:
        await conn.execute(update_query, deployment_id)

    return RetryJobResponse(
        deployment_id=deployment_id,
        status="queued",
        retry_count=0
    )

@router.get("/{deployment_id}/logs", response_model=WorkerLogsResponse)
async def get_deployment_logs(
    deployment_id: str,
    db_pool: asyncpg.Pool = Depends(get_db_pool)
):
    query = """
        SELECT log_content
        FROM deployment_logs
        WHERE deployment_id = $1
        ORDER BY created_at ASC
    """
    async with db_pool.acquire() as conn:
        rows = await conn.fetch(query, deployment_id)

    merged_logs = "".join(row["log_content"] for row in rows)

    return WorkerLogsResponse(
        deployment_id=deployment_id,
        logs=merged_logs
    )

@router.post("/{deployment_id}/events", response_model=ExecutionEventResponse, status_code=status.HTTP_201_CREATED)
async def record_deployment_event(
    deployment_id: str,
    event_req: ExecutionEventRequest,
    deployer: DeployerService = Depends(get_deployer_service)
):
    event_id = f"evt_{uuid.uuid4().hex[:12]}"
    await deployer.emit_event(
        deployment_id=deployment_id,
        event_type=event_req.event_type,
        message=event_req.message,
        metadata=event_req.metadata
    )
    return ExecutionEventResponse(
        event_id=event_id,
        status="recorded"
    )
