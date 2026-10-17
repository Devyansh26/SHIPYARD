"""Cross-cutting HTTP middleware: internal API-key auth and request logging."""

from app.middleware.auth import verify_internal_api_key
from app.middleware.request_logging import (
    REQUEST_ID_HEADER,
    RequestLoggingMiddleware,
)

__all__ = [
    "REQUEST_ID_HEADER",
    "RequestLoggingMiddleware",
    "verify_internal_api_key",
]
