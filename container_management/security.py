"""Shared-secret auth for the internal API.

CMS is private infrastructure: per `docs/01-architecture.md` there is no Nginx
route to it and it sits on a bridge network with no published ports. This header
check is defence in depth so a mistake in the network layer is not immediately
exploitable — it is not the primary control.
"""
import hmac
import logging

from fastapi import Header, HTTPException, status

from config import get_settings

log = logging.getLogger("cms.security")

HEADER = "X-Internal-Key"


async def require_internal_key(
    x_internal_key: str | None = Header(default=None, alias=HEADER),
) -> None:
    settings = get_settings()
    if not x_internal_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "MISSING_INTERNAL_KEY", "message": f"{HEADER} header is required"},
        )
    # Constant-time compare so a wrong key cannot be discovered by timing.
    if not hmac.compare_digest(x_internal_key, settings.internal_api_key):
        log.warning("rejected a request with an invalid %s", HEADER)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "INVALID_INTERNAL_KEY", "message": "Internal key rejected"},
        )
