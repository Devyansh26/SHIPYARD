import secrets
from fastapi import Header, HTTPException, status
from app.config import get_settings

async def verify_internal_api_key(
    x_api_key: str = Header(..., alias="X-API-Key", description="Internal service shared secret key")
) -> None:
    """
    Enforces internal authentication across microservices.
    Uses constant-time comparison to protect against timing attacks.
    """
    settings = get_settings()
    if not secrets.compare_digest(x_api_key, settings.INTERNAL_API_KEY):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: Invalid internal authentication key"
        )
