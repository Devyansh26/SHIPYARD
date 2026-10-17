"""Unit tests for ``app.services.encryption_service`` (Phase 4).

Verifies that both documented ``secretRef`` layouts decrypt correctly and that
failures never leak ciphertext or plaintext.
"""

from __future__ import annotations

import base64

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.services.encryption_service import (
    EncryptionService,
    EncryptionServiceException,
    InvalidSecretRefException,
    SecretDecryptionException,
)

TEST_KEY = "0123456789abcdef" * 4  # 64 hex chars == 32 bytes
_IV = b"\x01" * 12


def _refs(plaintext: str, key_hex: str = TEST_KEY) -> tuple[str, str]:
    """Build a docs/02 v1 (base64) ref and a docs/03 legacy (hex) ref."""
    key = bytes.fromhex(key_hex)
    ct_tag = AESGCM(key).encrypt(_IV, plaintext.encode("utf-8"), None)
    ciphertext, tag = ct_tag[:-16], ct_tag[-16:]
    v1 = f"enc:v1:{_IV.hex()}:{tag.hex()}:{base64.b64encode(ciphertext).decode()}"
    legacy = f"enc:{_IV.hex()}:{tag.hex()}:{ciphertext.hex()}"
    return v1, legacy


@pytest.fixture()
def service() -> EncryptionService:
    return EncryptionService(TEST_KEY)


def test_round_trip(service: EncryptionService) -> None:
    ref = service.encrypt("hunter2")
    assert ref.startswith("enc:v1:")
    assert service.decrypt(ref) == "hunter2"


def test_decrypts_v1_base64_layout(service: EncryptionService) -> None:
    """docs/02 & api-docs F: enc:v1:<iv>:<tag>:<base64 ciphertext>."""
    v1, _ = _refs("docs02-secret")
    assert service.decrypt(v1) == "docs02-secret"


def test_decrypts_bare_hex_layout(service: EncryptionService) -> None:
    """docs/03 Control API: enc:<iv>:<tag>:<hex ciphertext>."""
    _, legacy = _refs("docs03-secret")
    assert service.decrypt(legacy) == "docs03-secret"


def test_unicode_round_trip(service: EncryptionService) -> None:
    ref = service.encrypt("pä55wörd-🔐")
    assert service.decrypt(ref) == "pä55wörd-🔐"


def test_wrong_key_raises_and_message_is_clean(service: EncryptionService) -> None:
    v1, _ = _refs("top-secret-payload", key_hex="ff" * 32)
    with pytest.raises(SecretDecryptionException) as exc:
        service.decrypt(v1)
    assert "top-secret-payload" not in str(exc.value)
    # No ciphertext echoed either.
    assert v1 not in str(exc.value)


def test_tampered_tag_raises(service: EncryptionService) -> None:
    v1, _ = _refs("payload")
    parts = v1.split(":")  # enc : v1 : iv : tag : ciphertext
    parts[3] = "00" * 16  # clobber the auth tag
    with pytest.raises(SecretDecryptionException):
        service.decrypt(":".join(parts))


def test_missing_prefix_raises(service: EncryptionService) -> None:
    with pytest.raises(InvalidSecretRefException):
        service.decrypt("plaintext-value")


def test_unknown_version_raises(service: EncryptionService) -> None:
    with pytest.raises(InvalidSecretRefException):
        service.decrypt("enc:v2:aa:bb:cc")


def test_wrong_segment_count_raises(service: EncryptionService) -> None:
    with pytest.raises(InvalidSecretRefException):
        service.decrypt("enc:v1:only-two:segments")


def test_invalid_iv_length_raises(service: EncryptionService) -> None:
    with pytest.raises(InvalidSecretRefException):
        service.decrypt("enc:v1:abcd:00:00")


@pytest.mark.parametrize("bad_key", ["not-hex", "abcd", ""])
def test_constructor_rejects_bad_key(bad_key: str) -> None:
    with pytest.raises(EncryptionServiceException):
        EncryptionService(bad_key)
