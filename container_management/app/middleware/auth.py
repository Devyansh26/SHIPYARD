"""Constant-time X-API-Key validation for internal-only access."""

import logging
import secrets
from typing import Optional

from fastapi import Header, HTTPException, status

from app.config import get_settings

logger = logging.getLogger(__name__)


async def verify_internal_api_key(
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> None:
    """Enforce internal API key authentication.

    Uses constant-time comparison to guard against timing attacks.
    Missing or mismatched keys both yield 403 with code INVALID_API_KEY
    (never 422), per the Part D contract.

    Args:
        x_api_key: Value of the X-API-Key header (None when absent).

    Raises:
        HTTPException: 403 with INVALID_API_KEY code on failure.
    """
    settings = get_settings()
    if not x_api_key or not secrets.compare_digest(x_api_key, settings.INTERNAL_API_KEY):
        logger.warning("Rejected request with missing/invalid internal API key")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "INVALID_API_KEY",
                "message": "Forbidden: Invalid internal authentication key",
            },
        )
