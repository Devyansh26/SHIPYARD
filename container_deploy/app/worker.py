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
                if isinstance(raw_data, bytes):
                    payload_str = raw_data.decode("utf-8")
                else:
                    payload_str = str(raw_data)

                await self.handle_job(payload_str)
            except (TimeoutError, aioredis.TimeoutError):
                # Normal idle timeout waiting for queue items; continue listening
                continue
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
        longer than JOB_TIMEOUT_SECONDS, re-enqueues it.
        """
        stuck_jobs = await self.redis.hgetall(self.settings.PROCESSING_SET)
        now = time.time()
        for key, raw_val in stuck_jobs.items():
            if isinstance(raw_val, bytes):
                raw_str = raw_val.decode("utf-8")
            else:
                raw_str = str(raw_val)

            try:
                entry = json.loads(raw_str)
                elapsed = now - entry["timestamp"]
                if elapsed > self.settings.JOB_TIMEOUT_SECONDS:
                    logger.warning(f"Recovering stuck job {key} (elapsed: {elapsed:.0f}s)")
                    await self.redis.hdel(self.settings.PROCESSING_SET, key)
                    await self.redis.rpush(self.settings.QUEUE_NAME, json.dumps(entry["payload"]))
            except Exception as e:
                logger.error(f"Failed to parse stuck job {key}: {e}")
