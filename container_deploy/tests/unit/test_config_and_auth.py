import pytest
from fastapi import HTTPException, status
from app.config import Settings, get_settings
from app.middleware.auth import verify_internal_api_key

def test_settings_load_defaults():
    settings = Settings(
        INTERNAL_API_KEY="test_secret_key",
        _env_file=None  # test explicit values
    )
    assert settings.APP_NAME == "shipyard-container-deployer"
    assert settings.PORT == 8002
    assert settings.QUEUE_NAME == "deployments:queue"
    assert settings.PROCESSING_SET == "deployments:processing"
    assert settings.MAX_JOB_RETRIES == 3

def test_get_settings_caching():
    s1 = get_settings()
    s2 = get_settings()
    assert s1 is s2

@pytest.mark.asyncio
async def test_auth_middleware_valid_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_KEY", "correct_secret_key")
    get_settings.cache_clear()
    
    # Should not raise exception
    await verify_internal_api_key(x_api_key="correct_secret_key")

@pytest.mark.asyncio
async def test_auth_middleware_invalid_key(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_KEY", "correct_secret_key")
    get_settings.cache_clear()
    
    with pytest.raises(HTTPException) as exc_info:
        await verify_internal_api_key(x_api_key="wrong_secret_key")
    
    assert exc_info.value.status_code == status.HTTP_403_FORBIDDEN
    assert "Invalid internal authentication key" in exc_info.value.detail
