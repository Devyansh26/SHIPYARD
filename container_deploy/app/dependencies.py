import logging
import os
from typing import Optional
import asyncpg
import redis.asyncio as aioredis

from app.config import get_settings, Settings
from app.services.image_builder import ImageBuilder
from app.services.docker_runner import DockerRunner
from app.services.deployer_service import DeployerService

logger = logging.getLogger(__name__)

_db_pool: Optional[asyncpg.Pool] = None
_redis_client: Optional[aioredis.Redis] = None
_image_builder: Optional[ImageBuilder] = None
_docker_runner: Optional[DockerRunner] = None
_deployer_service: Optional[DeployerService] = None

async def init_db_schema(pool: asyncpg.Pool) -> None:
    """
    Auto-applies schema.sql if available, ensuring required tables exist.
    """
    try:
        async with pool.acquire() as conn:
            exists = await conn.fetchval(
                "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'deployments')"
            )
            if exists:
                logger.info("Database schema already exists, skipping schema.sql initialization.")
                return

        base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
        schema_path = os.path.join(base_dir, "schema.sql")
        if os.path.exists(schema_path):
            with open(schema_path, "r", encoding="utf-8") as f:
                schema_sql = f.read()
            async with pool.acquire() as conn:
                await conn.execute(schema_sql)
            logger.info("Database schema applied successfully from schema.sql.")
    except Exception as e:
        logger.warning(f"Could not auto-apply schema.sql: {e}")

async def get_db_pool() -> asyncpg.Pool:
    global _db_pool
    if _db_pool is None:
        settings = get_settings()
        _db_pool = await asyncpg.create_pool(
            dsn=settings.DATABASE_URL,
            min_size=settings.DB_MIN_CONNECTIONS,
            max_size=settings.DB_MAX_CONNECTIONS
        )
        await init_db_schema(_db_pool)
    return _db_pool

def get_redis() -> aioredis.Redis:
    global _redis_client
    if _redis_client is None:
        settings = get_settings()
        _redis_client = aioredis.from_url(settings.REDIS_URL, decode_responses=False)
    return _redis_client

def get_image_builder() -> ImageBuilder:
    global _image_builder
    if _image_builder is None:
        settings = get_settings()
        _image_builder = ImageBuilder(workspace_root=settings.WORKSPACE_DIR)
    return _image_builder

def get_docker_runner() -> DockerRunner:
    global _docker_runner
    if _docker_runner is None:
        _docker_runner = DockerRunner()
    return _docker_runner

async def get_deployer_service() -> DeployerService:
    global _deployer_service
    if _deployer_service is None:
        db_pool = await get_db_pool()
        image_builder = get_image_builder()
        docker_runner = get_docker_runner()
        _deployer_service = DeployerService(
            db_pool=db_pool,
            image_builder=image_builder,
            docker_runner=docker_runner
        )
    return _deployer_service

async def close_resources() -> None:
    global _db_pool, _redis_client, _deployer_service
    if _db_pool is not None:
        await _db_pool.close()
        _db_pool = None
    if _redis_client is not None:
        await _redis_client.aclose()
        _redis_client = None
    _deployer_service = None
