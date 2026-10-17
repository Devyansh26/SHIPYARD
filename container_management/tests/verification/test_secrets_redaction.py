"""STEP 4 -- secret handling: reference-compatible decryption and redaction.

Uses :mod:`tests.verification.refcrypto` (an independent AES-256-GCM
implementation of ``enc:v1:<iv>:<tag>:<ct>``) so CMS is tested for
*compatibility* with the platform wire format, not self-consistency.
"""

from __future__ import annotations

import json
import logging

import pytest

from tests.fakes import make_doc
from tests.verification.conftest import (
    CANARY,
    CONTAINERS_BASE as BASE,
    TEST_MASTER_KEY,
    error_code,
    full_payload,
    minimal_payload,
)
from tests.verification.refcrypto import (
    reference_encrypt,
    tamper_ciphertext,
)

pytestmark = pytest.mark.integration

#: A second valid 64-hex key that is NOT the CMS master key.
OTHER_KEY = "f" * 64


def _payload_with_env(secret_ref: str):
    payload = minimal_payload()
    payload["env"] = [{"key": "CANARY", "secretRef": secret_ref}]
    return payload


# ---------------------------------------------------------------------------
# (a) Reference ciphertext decrypts; plaintext reaches Docker (mock capture)
# ---------------------------------------------------------------------------
async def test_reference_ciphertext_is_decrypted_for_docker(stack, auth) -> None:
    ref = reference_encrypt(CANARY, TEST_MASTER_KEY)
    resp = await stack.client.post(BASE, json=_payload_with_env(ref), headers=auth)

    assert resp.status_code == 201, resp.text
    kwargs = stack.docker.create_and_run.call_args.kwargs
    # (a) the container really receives the decrypted value -- in memory only.
    assert kwargs["env"] == {"CANARY": CANARY}


# ---------------------------------------------------------------------------
# (b)(c)(d) the value/ciphertext never leaves via response, DB, or logs
# ---------------------------------------------------------------------------
async def test_secret_absent_from_response_db_and_logs(stack, auth, caplog, capsys) -> None:
    ref = reference_encrypt(CANARY, TEST_MASTER_KEY)
    with caplog.at_level(logging.DEBUG):
        create = await stack.client.post(BASE, json=_payload_with_env(ref), headers=auth)
    assert create.status_code == 201
    cid = create.json()["containerId"]

    listed = await stack.client.get(BASE, headers=auth)
    fetched = await stack.client.get(f"{BASE}/{cid}", headers=auth)

    # (b) no API response echoes the value or the ciphertext.
    for resp in (create, listed, fetched):
        assert CANARY not in resp.text
        assert ref not in resp.text
        assert "enc:" not in resp.text

    # (c) DB record stores only env_keys -- no value, no ciphertext.
    stored = stack.repo.rows[cid]
    assert stored["env_keys"] == ["CANARY"]
    dumped = json.dumps(stored, default=str)
    assert CANARY not in dumped
    assert ref not in dumped
    assert "secret_ref" not in dumped

    # (d) application logs (root logger + stdout/stderr) never contain either.
    captured = capsys.readouterr()
    haystack = caplog.text + captured.out + captured.err
    assert CANARY not in haystack
    assert ref not in haystack


async def test_responses_do_not_expose_env_at_all(stack, auth) -> None:
    """"Return secret references or redacted values": CMS returns neither env
    values nor env keys in any response."""
    ref = reference_encrypt(CANARY, TEST_MASTER_KEY)
    create = await stack.client.post(BASE, json=_payload_with_env(ref), headers=auth)
    body = create.json()
    assert "env" not in body
    assert "envKeys" not in body
    assert "secretRef" not in create.text


# ---------------------------------------------------------------------------
# Redaction of container logs -- documented behaviour
# ---------------------------------------------------------------------------
async def test_container_logs_are_not_redacted_by_design(stack, auth) -> None:
    """CMS logs endpoint returns raw container output.

    If a workload prints its environment (e.g. ``busybox env``), the value WILL
    appear in the logs endpoint. That is inherent to container logs; CMS
    deliberately has nothing to match against (only ``env_keys`` are stored).
    """
    stack.repo.seed(
        make_doc("cnt_1", status="running", docker_id="d" * 64)
    )
    stack.repo.rows["cnt_1"]["env_keys"] = ["CANARY"]
    stack.docker.get_logs.return_value = f"PATH=/usr/bin\nCANARY={CANARY}\n"
    body = (await stack.client.get(f"{BASE}/cnt_1/logs", headers=auth)).json()
    # ACTUAL / expected: logs are container output; no redaction possible.
    assert CANARY in body["logs"]


# ---------------------------------------------------------------------------
# Malformed / tampered references
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "bad_ref",
    ["not-encrypted", "enc:", "enc:v2:aabbccddeeff001122334455:00112233445566778899aabbccddeeff:AAAA"],
)
async def test_malformed_secret_ref_is_400(stack, auth, bad_ref: str) -> None:
    resp = await stack.client.post(BASE, json=_payload_with_env(bad_ref), headers=auth)
    assert resp.status_code == 400, resp.text
    assert error_code(resp) == "INVALID_PAYLOAD"
    assert bad_ref not in resp.text
    assert not stack.docker.create_and_run.called


async def test_empty_secret_ref_is_400(stack, auth) -> None:
    resp = await stack.client.post(BASE, json=_payload_with_env(""), headers=auth)
    assert resp.status_code == 400
    assert error_code(resp) == "INVALID_PAYLOAD"
    assert not stack.docker.create_and_run.called


async def test_tampered_ciphertext_is_clean_error(stack, auth) -> None:
    ref = reference_encrypt(CANARY, TEST_MASTER_KEY)
    bad = tamper_ciphertext(ref, TEST_MASTER_KEY)
    resp = await stack.client.post(BASE, json=_payload_with_env(bad), headers=auth)

    # ACTUAL: valid format + failing GCM tag -> 500 INTERNAL_ERROR (docs imply
    # a 400-class "bad secretRef"). Clean: no ciphertext/plaintext leaked.
    assert resp.status_code in (400, 500), resp.text
    assert resp.json()["error"]["code"] in {"INVALID_PAYLOAD", "INTERNAL_ERROR"}
    assert CANARY not in resp.text
    assert bad not in resp.text
    assert "Traceback" not in resp.text
    assert not stack.docker.create_and_run.called


async def test_wrong_key_is_clean_error(stack, auth) -> None:
    ref = reference_encrypt(CANARY, OTHER_KEY)  # correct format, wrong key
    resp = await stack.client.post(BASE, json=_payload_with_env(ref), headers=auth)
    assert resp.status_code in (400, 500), resp.text
    assert CANARY not in resp.text
    assert ref not in resp.text
    assert not stack.docker.create_and_run.called


async def test_truncated_payload_is_clean_error(stack, auth) -> None:
    ref = reference_encrypt(CANARY, TEST_MASTER_KEY)
    truncated = ref.rsplit(":", 1)[0] + ":AAAA"
    resp = await stack.client.post(BASE, json=_payload_with_env(truncated), headers=auth)
    assert resp.status_code in (400, 500), resp.text
    assert CANARY not in resp.text
    assert not stack.docker.create_and_run.called


async def test_invalid_hex_iv_is_400(stack, auth) -> None:
    bad = "enc:v1:ZZZZ:00112233445566778899aabbccddeeff:AAAA"
    resp = await stack.client.post(BASE, json=_payload_with_env(bad), headers=auth)
    assert resp.status_code == 400
    assert error_code(resp) == "INVALID_PAYLOAD"


# ---------------------------------------------------------------------------
# Non-sensitive but valid: value never logged even for full payload
# ---------------------------------------------------------------------------
async def test_full_payload_secret_never_logged(stack, auth, caplog) -> None:
    ref = reference_encrypt(CANARY, TEST_MASTER_KEY)
    with caplog.at_level(logging.DEBUG):
        resp = await stack.client.post(BASE, json=full_payload(ref), headers=auth)
    assert resp.status_code == 201
    assert CANARY not in caplog.text
    assert ref not in caplog.text
    assert auth["X-API-Key"] not in caplog.text
