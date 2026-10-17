"""Structured request logging with request IDs.

Emits exactly one JSON log line per request containing **only**:

* ``event`` -- ``request`` (normal) or ``request_failed`` (unhandled error)
* ``request_id`` -- echoed from ``X-Request-ID`` or freshly generated
* ``method`` -- HTTP method
* ``path`` -- URL *path only* (the query string is never logged)
* ``status`` -- response status code
* ``duration_ms`` -- wall-clock handling time

Headers and bodies are **never** logged. That is a hard security requirement:
the ``X-API-Key`` header and every ``secretRef``/``env`` payload arrive in one
of those two places, so logging either would write secrets to disk.
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("app.request")

#: Response/request correlation header.
REQUEST_ID_HEADER = "X-Request-ID"

#: Only short, log-safe request IDs are honoured; anything else is replaced so
#: a caller cannot forge log lines or smuggle control characters.
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def _resolve_request_id(request: Request) -> str:
    """Return a trustworthy request id, honouring a valid inbound one."""
    inbound = request.headers.get(REQUEST_ID_HEADER)
    if inbound and _REQUEST_ID_RE.fullmatch(inbound):
        return inbound
    return uuid.uuid4().hex


def _emit(
    request: Request,
    request_id: str,
    status_code: int,
    duration_ms: float,
    event: str = "request",
) -> None:
    """Write one structured log line (never headers, never bodies)."""
    line = json.dumps(
        {
            "event": event,
            "request_id": request_id,
            "method": request.method,
            "path": request.url.path,
            "status": status_code,
            "duration_ms": duration_ms,
        },
        separators=(",", ":"),
    )
    level = logging.WARNING if status_code >= 500 else logging.INFO
    logger.log(level, line)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """Logs method/path/status/duration and tags responses with a request id."""

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        request_id = _resolve_request_id(request)
        # Exposed so error handlers can correlate their (redacted) logs.
        request.state.request_id = request_id
        started = time.perf_counter()

        try:
            response = await call_next(request)
        except Exception:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            _emit(request, request_id, 500, duration_ms, event="request_failed")
            # Re-raise: Starlette's outer middleware renders the 500 response.
            raise

        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        _emit(request, request_id, response.status_code, duration_ms)
        response.headers[REQUEST_ID_HEADER] = request_id
        return response


__all__ = ["REQUEST_ID_HEADER", "RequestLoggingMiddleware"]
