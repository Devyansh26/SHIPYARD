import asyncio
from contextlib import asynccontextmanager
import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.dependencies import (
    get_db_pool,
    get_redis,
    get_deployer_service,
    close_resources
)
from app.routers import workers, deployments
from app.worker import DeploymentWorker

logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    logger.info(f"Starting {settings.APP_NAME} on port {settings.PORT}...")

    # Initialize connection pool & worker
    await get_db_pool()
    redis_client = get_redis()
    deployer_service = await get_deployer_service()

    worker = DeploymentWorker(
        redis_client=redis_client,
        deployer_service=deployer_service,
        settings=settings
    )

    worker_task = asyncio.create_task(worker.start())
    app.state.worker = worker
    app.state.worker_task = worker_task

    yield

    # Graceful shutdown
    logger.info(f"Shutting down {settings.APP_NAME}...")
    worker.stop()
    worker_task.cancel()
    try:
        await worker_task
    except asyncio.CancelledError:
        pass

    await close_resources()
    logger.info("Resources closed cleanly.")

def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.APP_NAME,
        version="1.0.0",
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Mount routers
    app.include_router(workers.router)
    app.include_router(deployments.router)

    return app

app = create_app()
