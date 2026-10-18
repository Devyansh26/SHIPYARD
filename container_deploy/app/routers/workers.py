from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse
import asyncpg
import redis.asyncio as aioredis
from app.config import get_settings, Settings
from app.dependencies import get_db_pool, get_redis

router = APIRouter(
    prefix="/internal/v1/workers",
    tags=["workers"]
)

@router.get("/health", status_code=status.HTTP_200_OK)
async def worker_health(settings: Settings = Depends(get_settings)):
    """
    Liveness probe: returns 200 while the process is up and running.
    """
    return {
        "status": "ok",
        "service": settings.APP_NAME
    }

@router.get("/ready")
async def worker_ready(
    db_pool: asyncpg.Pool = Depends(get_db_pool),
    redis_client: aioredis.Redis = Depends(get_redis)
):
    """
    Readiness probe: validates connectivity to Redis and PostgreSQL.
    Returns 503 Service Unavailable if either dependency cannot be reached.
    """
    try:
        # Check Redis
        await redis_client.ping()

        # Check PostgreSQL
        async with db_pool.acquire() as conn:
            await conn.fetchval("SELECT 1")

        return {
            "ready": True,
            "redis": "connected",
            "postgres": "connected"
        }
    except Exception as e:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={
                "ready": False,
                "error": str(e)
            }
        )
