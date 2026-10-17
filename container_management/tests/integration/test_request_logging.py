"""Integration tests for the structured request-logging middleware.

Verifies the correlation header and that log lines contain only the agreed
structured fields -- in particular that headers (``X-API-Key``) and request
bodies (``secretRef``/plaintext secrets) never reach the logs.
"""

from __future__ import annotations

import json
import logging

import pytest
from httpx import AsyncClient

from app.middleware.request_logging import REQUEST_ID_HEADER
from app.services.encryption_service import EncryptionService

BASE = "/internal/v1/containers"
TEST_KEY = "0123456789abcdef" * 4
_ENC = EncryptionService(TEST_KEY)

_LOGGER = "app.request"


def _payload(secret_ref: str) -> dict:
    return {
        "deploymentId": "dep_1",
        "serviceId": "svc_1",
        "image": "img:1",
        "env": [{"key": "DATABASE_URL", "secretRef": secret_ref}],
    }


def _records(caplog: pytest.LogCaptureFixture) -> list:
    return [r for r in caplog.records if r.name == _LOGGER]


def test_request_id_header_is_documented_name() -> None:
    assert REQUEST_ID_HEADER == "X-Request-ID"


async def test_request_id_is_generated_and_returned(client: AsyncClient) -> None:
    resp = await client.get("/health")

    assert resp.status_code == 200
    request_id = resp.headers.get(REQUEST_ID_HEADER)
    assert request_id is not None
    assert len(request_id) == 32  # uuid4().hex


async def test_inbound_request_id_is_honoured(client: AsyncClient) -> None:
    resp = await client.get("/health", headers={REQUEST_ID_HEADER: "trace-abc-123"})

    assert resp.headers[REQUEST_ID_HEADER] == "trace-abc-123"


@pytest.mark.parametrize(
    "bad", ["has spaces", "with\nnewline", "x" * 129, "semi;colon", ""]
)
async def test_unsafe_inbound_request_id_is_replaced(
    client: AsyncClient, bad: str
) -> None:
    resp = await client.get("/health", headers={REQUEST_ID_HEADER: bad})

    returned = resp.headers[REQUEST_ID_HEADER]
    assert returned != bad
    assert len(returned) == 32


async def test_log_line_has_only_structured_fields(
    client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        resp = await client.get("/health?probe=1")

    records = _records(caplog)
    assert records, "expected at least one app.request log line"

    payload = json.loads(records[-1].getMessage())
    assert set(payload) == {
        "event",
        "request_id",
        "method",
        "path",
        "status",
        "duration_ms",
    }
    assert payload["event"] == "request"
    assert payload["method"] == "GET"
    assert payload["path"] == "/health"  # query string deliberately excluded
    assert payload["status"] == 200
    assert isinstance(payload["duration_ms"], float)
    assert payload["request_id"] == resp.headers[REQUEST_ID_HEADER]


async def test_five_xx_is_logged_as_warning(
    client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    from app.config import get_settings

    # Valid key, no database on app.state (lifespan does not run) -> 500.
    headers = {"X-API-Key": get_settings().INTERNAL_API_KEY}
    with caplog.at_level(logging.INFO, logger=_LOGGER):
        resp = await client.post(BASE, json=_payload(_ENC.encrypt("x")), headers=headers)

    assert resp.status_code == 500
    records = _records(caplog)
    assert records[-1].levelno == logging.WARNING
    assert json.loads(records[-1].getMessage())["status"] == 500


async def test_headers_and_body_are_never_logged(
    client: AsyncClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    from app.config import get_settings

    api_key = get_settings().INTERNAL_API_KEY
    plaintext = "super-secret-plaintext"
    secret_ref = _ENC.encrypt(plaintext)

    with caplog.at_level(logging.DEBUG):
        await client.post(
            BASE,
            json=_payload(secret_ref),
            headers={"X-API-Key": api_key},
        )

    text = caplog.text
    assert api_key not in text
    assert plaintext not in text
    assert secret_ref not in text
    assert "X-API-Key" not in text
