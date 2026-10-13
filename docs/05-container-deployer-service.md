# 05 - Container Deployer Service LLD

## 1. Executive Summary & Responsibility Boundary

- **Service Name:** `container-deployer`
- **Type:** Internal Worker Service with Control API
- **Language & Runtime:** Python 3.11+, FastAPI, Asyncio, Redis (`redis-py` async)
- **Port:** `8002`
- **Network Exposure:** Private Homelab Network only. Not exposed to public ingress.
- **Primary Responsibility:** Asynchronously consumes deployment jobs from Redis, clones Git repositories, executes builds (generating container images), invokes the `container-management` service to launch workloads, monitors health until convergence, and updates deployment state in MongoDB.

```
       +---------------------------------------------+
       |   Redis Queue ('deployments:queue')        |
       +---------------------------------------------+
                              |
                     BLPOP (blocking pull)
                              v
       +---------------------------------------------+
       |         Container Deployer Worker           |
       |                                             |
       |  +--------------------+  +---------------+  |
       |  | DeploymentWorker   |  | ImageBuilder  |  |
       |  +--------------------+  +---------------+  |
       |           |                                 |
       |           v                                 |
       |  +---------------------------------------+  |
       |  | DeployerService (Orchestrator)        |  |
       |  +---------------------------------------+  |
       +---------------------------------------------+
                  |                         |
         Internal HTTP (8001)       Direct Motor writes
                  |                         |
                  v                         v
       +----------------------+   +-------------------+
       | Container Management |   | MongoDB           |
       | Service (FastAPI)    |   | (deployments,     |
       +----------------------+   |  events, logs)    |
                                  +-------------------+
```

---

## 2. Directory Structure

```text
container-deployer/
├── app/
│   ├── __init__.py
│   ├── main.py                  # Lifespan: boots background worker thread/task + FastAPI
│   ├── config.py                # BaseSettings configuration singleton
│   ├── worker.py                # Redis queue consumer, retry logic & recovery loop
│   ├── dependencies.py          # FastAPI DI providers
│   ├── models/
│   │   ├── __init__.py
│   │   └── job.py               # DeploymentJob definition and state transitions
│   ├── schemas/
│   │   ├── __init__.py
│   │   └── deployment.py        # Worker API request/response schemas
│   ├── services/
│   │   ├── __init__.py
│   │   ├── deployer_service.py  # End-to-end execution pipeline
│   │   ├── image_builder.py     # Git clone, Dockerfile generation, docker build
│   │   └── management_client.py # HTTP client to Container Management Service (8001)
│   ├── routers/
│   │   ├── __init__.py
│   │   ├── deployments.py       # POST /execute, status, cancel, retry, logs, events
│   │   └── workers.py           # GET /internal/v1/workers/health and /ready
│   └── middleware/
│       ├── __init__.py
│       └── auth.py              # X-API-Key verification
├── tests/
│   ├── __init__.py
│   ├── conftest.py
│   ├── unit/
│   │   ├── test_worker.py
│   │   ├── test_deployer_service.py
│   │   └── test_image_builder.py
│   └── integration/
│       └── test_deployer_api.py
├── requirements.txt
├── Dockerfile
└── pytest.ini
```

---

## 3. Configuration Management (`app/config.py`)

```python
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    APP_NAME: str = "shipyard-container-deployer"
    LOG_LEVEL: str = "INFO"
    PORT: int = 8002
    HOST: str = "0.0.0.0"

    # Databases & Queues
    MONGO_URI: str = "mongodb://mongodb:27017"
    MONGO_DB_NAME: str = "shipyard"
    REDIS_URL: str = "redis://redis:6379/0"
    QUEUE_NAME: str = "deployments:queue"
    PROCESSING_SET: str = "deployments:processing"

    # Container Management Service (Target)
    CONTAINER_MANAGEMENT_URL: str = "http://container-management:8001"
    INTERNAL_API_KEY: str

    # Worker Settings
    MAX_JOB_RETRIES: int = 3
    JOB_TIMEOUT_SECONDS: int = 600  # 10 min max build/deploy time
    HEALTHCHECK_TIMEOUT_SECONDS: int = 60
    WORKSPACE_DIR: str = "/tmp/shipyard-workspaces"

    model_config = SettingsConfigDict(env_file=".env", case_sensitive=True)

@lru_cache()
def get_settings() -> Settings:
    return Settings()
```

---

## 4. Job Definitions & Schemas

### 4.1 Job Payload Model (`app/models/job.py`)
```python
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

class ServiceConfigSnapshot(BaseModel):
    service_id: str
    project_id: str
    service_name: str
    service_type: str
    repository: str
    branch: str
    root_directory: Optional[str] = "."
    build_command: Optional[str] = None
    pre_deploy_command: Optional[str] = None
    start_command: Optional[str] = None
    env_vars: List[Dict[str, Any]] = Field(default_factory=list)  # {key, secret_ref}
    ports: List[Dict[str, Any]] = Field(default_factory=list)
    resources: Dict[str, Any] = Field(default_factory=dict)
    health_check: Optional[Dict[str, Any]] = None

class DeploymentJob(BaseModel):
    deployment_id: str
    service_id: str
    project_id: str
    commit_sha: str
    branch: str
    config_snapshot: ServiceConfigSnapshot
    retry_count: int = 0
```

---

## 5. Background Queue Worker (`app/worker.py`)

### 5.1 Architecture & Implementation
**Why BLPOP + Processing Set:**
Standard FIFO queues without acknowledgments drop jobs if a worker crashes midway. By combining `BLPOP` with an atomic or immediate registration in a Redis processing set (`deployments:processing`), the system tracks in-flight jobs.

```python
import asyncio
import json
import logging
import time
from typing import Optional
import redis.asyncio as aioredis
from app.config import Settings
from app.models.job import DeploymentJob
from app.services.deployer_service import DeployerService

logger = logging.getLogger(__name__)

class DeploymentWorker:
    def __init__(
        self,
        redis_client: aioredis.Redis,
        deployer_service: DeployerService,
        settings: Settings
    ):
        self.redis = redis_client
        self.deployer_service = deployer_service
        self.settings = settings
        self.is_running = False

    async def start(self) -> None:
        """Starts worker consumer loop and recovery scanner."""
        self.is_running = True
        logger.info("DeploymentWorker started. Running stuck jobs recovery...")
        await self.recover_stuck_jobs()
        logger.info(f"Listening on queue '{self.settings.QUEUE_NAME}'...")

        while self.is_running:
            try:
                # BLPOP with 5s timeout to allow clean shutdown check
                item = await self.redis.blpop(self.settings.QUEUE_NAME, timeout=5)
                if not item:
                    continue

                _, raw_data = item
                await self.handle_job(raw_data.decode("utf-8"))
            except asyncio.CancelledError:
                logger.info("Worker cancelled, exiting loop.")
                break
            except Exception as e:
                logger.error(f"Unexpected worker error: {e}", exc_info=True)
                await asyncio.sleep(1)

    def stop(self) -> None:
        self.is_running = False

    async def handle_job(self, raw_payload: str) -> None:
        try:
            data = json.loads(raw_payload)
            job = DeploymentJob.model_validate(data)
        except Exception as e:
            logger.error(f"Malformed job payload rejected: {raw_payload}. Error: {e}")
            return

        job_key = f"{job.deployment_id}:{job.retry_count}"
        # 1. Mark in processing set with timestamp
        await self.redis.hset(
            self.settings.PROCESSING_SET,
            job_key,
            json.dumps({"payload": data, "timestamp": time.time()})
        )

        try:
            logger.info(f"Starting execution of deployment {job.deployment_id}")
            await self.deployer_service.execute(job)
            # 2. Success: remove from processing set
            await self.redis.hdel(self.settings.PROCESSING_SET, job_key)
            logger.info(f"Deployment {job.deployment_id} completed successfully.")
        except Exception as e:
            logger.error(f"Deployment {job.deployment_id} execution failed: {e}")
            await self.redis.hdel(self.settings.PROCESSING_SET, job_key)

            # Check bounded retry
            if job.retry_count < self.settings.MAX_JOB_RETRIES:
                job.retry_count += 1
                logger.info(f"Re-enqueuing {job.deployment_id} (retry {job.retry_count})")
                await self.redis.rpush(
                    self.settings.QUEUE_NAME,
                    job.model_dump_json()
                )
            else:
                logger.error(f"Deployment {job.deployment_id} exceeded max retries.")
                await self.deployer_service.mark_terminal_failed(
                    job.deployment_id,
                    f"Exceeded max retries: {str(e)}"
                )

    async def recover_stuck_jobs(self) -> None:
        """
        Scans processing set on worker startup. If a job has been in flight
        longer than JOB_TIMEOUT_SECONDS, re-enqueues it or marks as failed.
        """
        stuck_jobs = await self.redis.hgetall(self.settings.PROCESSING_SET)
        now = time.time()
        for key, raw_val in stuck_jobs.items():
            entry = json.loads(raw_val.decode("utf-8"))
            elapsed = now - entry["timestamp"]
            if elapsed > self.settings.JOB_TIMEOUT_SECONDS:
                logger.warning(f"Recovering stuck job {key.decode('utf-8')} (elapsed: {elapsed:.0f}s)")
                await self.redis.hdel(self.settings.PROCESSING_SET, key)
                await self.redis.rpush(self.settings.QUEUE_NAME, json.dumps(entry["payload"]))
```

---

## 6. Image Builder Service (`app/services/image_builder.py`)

### 6.1 Rationale
- Uses direct Git CLI commands via `asyncio.create_subprocess_exec` with timeouts to prevent hanging repository clones.
- Automatically generates a standardized `Dockerfile` if the repository does not contain one, respecting `build_command`, `pre_deploy_command`, and `start_command`.

```python
import asyncio
import os
import shutil
import logging
from typing import Optional

logger = logging.getLogger(__name__)

class ImageBuilderException(Exception):
    pass

class ImageBuilder:
    def __init__(self, workspace_root: str = "/tmp/shipyard-workspaces"):
        self.workspace_root = workspace_root
        os.makedirs(self.workspace_root, exist_ok=True)

    async def _run_command(self, cmd: list[str], cwd: str, timeout: int = 180) -> tuple[int, str]:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT
        )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
            return process.returncode or 0, stdout.decode("utf-8", errors="replace")
        except asyncio.TimeoutError:
            process.kill()
            raise ImageBuilderException(f"Command '{' '.join(cmd)}' timed out after {timeout}s")

    async def build(
        self,
        deployment_id: str,
        repo_url: str,
        branch: str,
        commit_sha: str,
        root_dir: Optional[str],
        build_cmd: Optional[str],
        pre_deploy_cmd: Optional[str],
        start_cmd: Optional[str],
        tag: str
    ) -> str:
        build_dir = os.path.join(self.workspace_root, deployment_id)
        if os.path.exists(build_dir):
            shutil.rmtree(build_dir)
        os.makedirs(build_dir)

        try:
            # 1. Clone repository
            logger.info(f"Cloning {repo_url} (branch: {branch}) into {build_dir}")
            clone_cmd = ["git", "clone", "--depth", "1", "--branch", branch, repo_url, build_dir]
            code, out = await self._run_command(clone_cmd, cwd=self.workspace_root)
            if code != 0:
                raise ImageBuilderException(f"Git clone failed: {out}")

            target_context = os.path.join(build_dir, root_dir) if root_dir and root_dir != "." else build_dir
            dockerfile_path = os.path.join(target_context, "Dockerfile")

            # 2. Synthesize Dockerfile if absent
            if not os.path.exists(dockerfile_path):
                logger.info(f"No Dockerfile found in {target_context}. Generating automated container spec.")
                synthetic = self._generate_synthetic_dockerfile(build_cmd, pre_deploy_cmd, start_cmd)
                with open(dockerfile_path, "w", encoding="utf-8") as f:
                    f.write(synthetic)

            # 3. Docker build command
            logger.info(f"Building Docker image with tag: {tag}")
            build_cmd_args = ["docker", "build", "-t", tag, target_context]
            code, out = await self._run_command(build_cmd_args, cwd=target_context, timeout=300)
            if code != 0:
                raise ImageBuilderException(f"Docker build failed: {out}")

            return tag
        finally:
            # Clean up checked-out code from worker filesystem to preserve disk space
            if os.path.exists(build_dir):
                shutil.rmtree(build_dir, ignore_errors=True)

    def _generate_synthetic_dockerfile(
        self,
        build_cmd: Optional[str],
        pre_deploy_cmd: Optional[str],
        start_cmd: Optional[str]
    ) -> str:
        lines = [
            "FROM node:20-alpine",
            "WORKDIR /app",
            "COPY . .",
        ]
        if build_cmd:
            lines.append(f"RUN {build_cmd}")
        
        # Assemble run script
        run_cmds = []
        if pre_deploy_cmd:
            run_cmds.append(pre_deploy_cmd)
        if start_cmd:
            run_cmds.append(start_cmd)
        else:
            run_cmds.append("npm start")

        entrypoint = " && ".join(run_cmds)
        lines.append(f'CMD ["sh", "-c", "{entrypoint}"]')
        return "\n".join(lines) + "\n"
```

---

## 7. HTTP Management Client (`app/services/management_client.py`)

Communicates over internal HTTP with `container-management` (Port 8001).

```python
import logging
from typing import Any, Dict
import httpx

logger = logging.getLogger(__name__)

class ManagementServiceException(Exception):
    pass

class ManagementClient:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url
        self.headers = {"X-API-Key": api_key, "Content-Type": "application/json"}

    async def create_container(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self.base_url}/internal/v1/containers",
                json=payload,
                headers=self.headers
            )
            if resp.status_code != 201:
                raise ManagementServiceException(
                    f"Create container failed ({resp.status_code}): {resp.text}"
                )
            return resp.json()

    async def get_health(self, container_id: str) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{self.base_url}/internal/v1/containers/{container_id}/health",
                headers=self.headers
            )
            if resp.status_code != 200:
                raise ManagementServiceException(
                    f"Health check failed ({resp.status_code}): {resp.text}"
                )
            return resp.json()

    async def stop_container(self, container_id: str) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(
                f"{self.base_url}/internal/v1/containers/{container_id}/stop",
                headers=self.headers
            )
```

---

## 8. Deployer Orchestration Service (`app/services/deployer_service.py`)

### 8.1 State Progression & DB Ownership
The deployer service directly writes status to `deployments`, `deployment_events`, and `deployment_logs` in MongoDB.

```
+------------+     +--------------+     +------------+     +-------------+     +-----------+
|   queued   | --> |  validating  | --> |  building  | --> |  deploying  | --> |  healthy  |
+------------+     +--------------+     +------------+     +-------------+     +-----------+
       \                  \                    \                  \
        +------------------+--------------------+------------------+---------> |  failed   |
                                                                               +-----------+
```

```python
import asyncio
from datetime import datetime
import logging
import uuid
from motor.motor_asyncio import AsyncIOMotorDatabase
from app.models.job import DeploymentJob
from app.services.image_builder import ImageBuilder
from app.services.management_client import ManagementClient

logger = logging.getLogger(__name__)

class DeployerService:
    def __init__(
        self,
        db: AsyncIOMotorDatabase,
        image_builder: ImageBuilder,
        management_client: ManagementClient
    ):
        self.db = db
        self.deployments_col = db["deployments"]
        self.events_col = db["deployment_events"]
        self.image_builder = image_builder
        self.management_client = management_client

    async def emit_event(self, deployment_id: str, event_type: str, message: str, metadata: dict = None) -> None:
        event_doc = {
            "event_id": f"evt_{uuid.uuid4().hex[:12]}",
            "deployment_id": deployment_id,
            "event_type": event_type,
            "message": message,
            "metadata": metadata or {},
            "created_at": datetime.utcnow()
        }
        await self.events_col.insert_one(event_doc)

    async def set_state(self, deployment_id: str, status: str, extra_fields: dict = None) -> None:
        update_data = {"status": status, **(extra_fields or {})}
        if status == "building" and "started_at" not in update_data:
            update_data["started_at"] = datetime.utcnow()
        if status in ["healthy", "failed", "cancelled", "rolled_back"]:
            update_data["finished_at"] = datetime.utcnow()

        await self.deployments_col.update_one(
            {"deployment_id": deployment_id},
            {"$set": update_data}
        )

    async def mark_terminal_failed(self, deployment_id: str, error_msg: str) -> None:
        await self.set_state(deployment_id, "failed")
        await self.emit_event(deployment_id, "DEPLOYMENT_FAILED", error_msg)

    async def execute(self, job: DeploymentJob) -> None:
        dep_id = job.deployment_id
        cfg = job.config_snapshot

        # 1. Validating
        await self.set_state(dep_id, "validating")
        await self.emit_event(dep_id, "VALIDATION_START", "Validating configuration parameters")

        if not cfg.repository:
            raise ValueError("Repository URL is required in config_snapshot.")

        await self.emit_event(dep_id, "VALIDATION_PASSED", "Configuration verified")

        # 2. Building
        await self.set_state(dep_id, "building")
        image_tag = f"shipyard-app/{cfg.service_name}:{dep_id[:8]}"
        await self.emit_event(dep_id, "BUILD_START", f"Starting build for image {image_tag}")

        try:
            await self.image_builder.build(
                deployment_id=dep_id,
                repo_url=cfg.repository,
                branch=cfg.branch,
                commit_sha=job.commit_sha,
                root_dir=cfg.root_directory,
                build_cmd=cfg.build_command,
                pre_deploy_cmd=cfg.pre_deploy_command,
                start_cmd=cfg.start_command,
                tag=image_tag
            )
        except Exception as e:
            await self.mark_terminal_failed(dep_id, f"Build failure: {e}")
            raise

        await self.emit_event(dep_id, "BUILD_SUCCESS", f"Built image {image_tag}")

        # 3. Deploying
        await self.set_state(dep_id, "deploying", {"image_id": image_tag})
        await self.emit_event(dep_id, "DEPLOY_START", "Launching container on container management service")

        container_payload = {
            "deploymentId": dep_id,
            "serviceId": cfg.service_id,
            "image": image_tag,
            "ports": cfg.ports or [{"containerPort": 3000, "protocol": "tcp"}],
            "resources": cfg.resources or {"cpuLimit": "1", "memoryLimit": "512Mi"},
            "healthCheck": cfg.health_check or {"path": "/health", "port": 3000},
            "env": cfg.env_vars
        }

        try:
            container_resp = await self.management_client.create_container(container_payload)
            container_id = container_resp["containerId"]
        except Exception as e:
            await self.mark_terminal_failed(dep_id, f"Workload initiation failed: {e}")
            raise

        # 4. Health Polling Loop
        await self.emit_event(dep_id, "HEALTH_CHECK_WAIT", f"Awaiting healthy state for container {container_id}")
        is_healthy = False
        for _ in range(12):  # 12 * 5s = 60s max
            await asyncio.sleep(5)
            try:
                health = await self.management_client.get_health(container_id)
                status = health.get("status")
                if status == "healthy":
                    is_healthy = True
                    break
            except Exception:
                pass  # Ignore interim connection drops

        # 5. Convergence Evaluation
        public_url = f"http://{cfg.service_name}.local.shipyard.lan"
        if is_healthy:
            await self.set_state(
                dep_id,
                "healthy",
                {"container_id": container_id, "deployment_url": public_url}
            )
            await self.emit_event(dep_id, "RELEASE_HEALTHY", f"Workload active at {public_url}")
        else:
            await self.mark_terminal_failed(dep_id, "Health check timed out after 60s")
            raise TimeoutError("Container failed to reach healthy state.")
```

---

## 9. Router Endpoints (`app/routers/`)

### 9.1 `app/routers/deployments.py`
Endpoints under `/internal/v1/deployments`:

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/internal/v1/deployments/execute` | Explicitly submit job for execution |
| `GET` | `/internal/v1/deployments/{deployment_id}` | Inspect executor-side status |
| `POST` | `/internal/v1/deployments/{deployment_id}/cancel` | Cancel in-flight execution |
| `POST` | `/internal/v1/deployments/{deployment_id}/retry` | Retry a failed step or job |
| `GET` | `/internal/v1/deployments/{deployment_id}/logs` | Retrieve worker logs |
| `POST` | `/internal/v1/deployments/{deployment_id}/events` | Ingest execution events |

### 9.2 `app/routers/workers.py`
- `GET /internal/v1/workers/health` -> Returns `{"status": "ok"}`
- `GET /internal/v1/workers/ready` -> Validates Redis and MongoDB ping; returns `{"ready": true}`

---

## 10. Test-Driven Development (TDD) Strategy

### 10.1 Key Test Scenarios
1. **`test_happy_path_pipeline`:** Mocking `ImageBuilder` and `ManagementClient`, assert job transitions through `validating` -> `building` -> `deploying` -> `healthy`.
2. **`test_build_failure_sets_failed_state`:** If `image_builder.build` raises an exception, assert deployment status is set to `failed` and a `DEPLOYMENT_FAILED` event is written.
3. **`test_bounded_retry_behavior`:** Verify that a failed job with `retry_count < 3` is pushed back to `deployments:queue` with incremented retry count.
4. **`test_stuck_job_recovery`:** Seed the `deployments:processing` set with a timestamp 15 minutes in the past. Assert `recover_stuck_jobs()` removes it from the processing set and re-queues it.
5. **`test_synthetic_dockerfile_generation`:** Assert `_generate_synthetic_dockerfile` with custom `build_command`, `pre_deploy_command`, and `start_command` produces the correct bash chain.
6. **`test_health_timeout_failure`:** If `get_health` returns `unhealthy` throughout 60s, assert container deployment is flagged as failed.
