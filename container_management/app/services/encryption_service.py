"""AES-256-GCM decryption of platform ``secretRef`` values.

The Container Management Service receives environment values as encrypted
``secretRef`` strings and decrypts them **in memory only**, right before a
container is created. Plaintext secrets must never be persisted, returned, or
logged.

Key derivation
--------------
``ENCRYPTION_MASTER_KEY`` (config) is a 64-character hex string. It is read
directly as 32 raw bytes (``bytes.fromhex``); no KDF is applied. This matches
the Control API, which does ``Buffer.from(env.ENCRYPTION_KEY, 'hex')``.

Wire format (documented conflict, both supported)
-------------------------------------------------
The reference docs disagree on the exact layout:

* ``docs/02-database-schema.md`` and ``docs/api-docs/F-env-vars.md``:
  ``enc:v1:<iv_hex>:<tag_hex>:<ciphertext_base64>``
* ``docs/03-control-api.md`` (the Control API's *actual* implementation):
  ``enc:<iv_hex>:<tag_hex>:<ciphertext_hex>`` -- no version segment, hex
  ciphertext.

Because the Control API ciphertext MUST decrypt here, this service accepts
**both** layouts. Auto-detection is safe: the version segment (``v1``) selects
the preferred ciphertext encoding, and GCM tag authentication disambiguates
base64 vs. hex definitively (a wrong decoding simply fails the tag check).

Assumptions documented here:
* IV is 12 bytes (96-bit) and the auth tag is 16 bytes, as in both docs.
* A ``v1`` prefix prefers base64 ciphertext (docs/02), then falls back to hex.
* A bare ``enc:`` prefix prefers hex ciphertext (docs/03), then base64.
* Unknown versions (``enc:v2:``) and malformed refs are rejected.

No ciphertext or plaintext ever appears in an exception message.
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
from typing import List, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger(__name__)

__all__ = [
    "EncryptionService",
    "EncryptionServiceException",
    "InvalidSecretRefException",
    "SecretDecryptionException",
]

_PREFIX = "enc:"
_SUPPORTED_VERSION = "v1"
_IV_BYTES = 12
_TAG_BYTES = 16
_KEY_BYTES = 32


class EncryptionServiceException(Exception):
    """Base exception for secret encryption/decryption failures."""


class InvalidSecretRefException(EncryptionServiceException):
    """The ``secretRef`` is not a well-formed ``enc:...`` reference."""


class SecretDecryptionException(EncryptionServiceException):
    """The ``secretRef`` could not be decrypted (bad key or tampered data)."""


def _try_hex(value: str) -> Optional[bytes]:
    """Decode hex, returning ``None`` when the input is not valid hex."""
    try:
        return bytes.fromhex(value)
    except (ValueError, TypeError):
        return None


def _try_base64(value: str) -> Optional[bytes]:
    """Decode strict base64, returning ``None`` on invalid input."""
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError, TypeError):
        return None


class EncryptionService:
    """Decrypts platform ``secretRef`` values using AES-256-GCM.

    Args:
        master_key: 64-character hex string (32 bytes).

    Raises:
        EncryptionServiceException: If the key is not valid 32-byte hex.
    """

    def __init__(self, master_key: str) -> None:
        try:
            key = bytes.fromhex(master_key)
        except (ValueError, TypeError) as exc:
            raise EncryptionServiceException(
                "ENCRYPTION_MASTER_KEY must be a valid hex string"
            ) from exc
        if len(key) != _KEY_BYTES:
            raise EncryptionServiceException(
                f"ENCRYPTION_MASTER_KEY must decode to {_KEY_BYTES} bytes"
            )
        self._key = key

    # -- public API ---------------------------------------------------------
    def decrypt(self, secret_ref: str) -> str:
        """Decrypt a ``secretRef`` into its plaintext value.

        Tries the encoding implied by the reference's shape first, then the
        alternative; GCM authentication makes the choice unambiguous.

        Args:
            secret_ref: An ``enc:``-prefixed reference string.

        Returns:
            The plaintext secret.

        Raises:
            InvalidSecretRefException: Malformed reference / unknown version.
            SecretDecryptionException: Tag mismatch or wrong key. The message
                never contains the ciphertext or plaintext.
        """
        if not isinstance(secret_ref, str) or not secret_ref.startswith(_PREFIX):
            raise InvalidSecretRefException(
                "secretRef is not in the expected 'enc:' format"
            )

        parts = secret_ref[len(_PREFIX):].split(":")
        version: Optional[str] = None
        if parts and parts[0] == _SUPPORTED_VERSION:
            version = parts.pop(0)
        elif parts and parts[0].startswith("v") and len(parts) != 3:
            # e.g. enc:v2:... -> explicitly unsupported version
            raise InvalidSecretRefException("Unsupported secretRef version")

        if len(parts) != 3:
            raise InvalidSecretRefException(
                "secretRef is malformed (expected iv:tag:ciphertext)"
            )
        iv_hex, tag_hex, ciphertext = parts

        iv = _try_hex(iv_hex)
        tag = _try_hex(tag_hex)
        if iv is None or len(iv) != _IV_BYTES:
            raise InvalidSecretRefException("secretRef has an invalid IV")
        if tag is None or len(tag) != _TAG_BYTES:
            raise InvalidSecretRefException("secretRef has an invalid auth tag")

        # v1 references prefer base64 (docs/02); bare refs prefer hex (docs/03).
        decoders = (
            (_try_base64, _try_hex) if version == _SUPPORTED_VERSION else (_try_hex, _try_base64)
        )
        candidates: List[bytes] = []
        for decode in decoders:
            decoded = decode(ciphertext)
            if decoded is not None and decoded not in candidates:
                candidates.append(decoded)

        aesgcm = AESGCM(self._key)
        for ciphertext_bytes in candidates:
            try:
                return aesgcm.decrypt(iv, ciphertext_bytes + tag, None).decode("utf-8")
            except Exception:  # InvalidTag or UnicodeDecodeError -> try next
                continue

        raise SecretDecryptionException("Failed to decrypt secretRef")

    def encrypt(self, plaintext: str) -> str:
        """Encrypt a plaintext value into a ``v1`` ``secretRef``.

        Provided for completeness and round-trip testing only; CMS never
        encrypts at runtime (the Control API owns the write path).
        """
        iv = os.urandom(_IV_BYTES)
        ciphertext_with_tag = AESGCM(self._key).encrypt(
            iv, plaintext.encode("utf-8"), None
        )
        ciphertext, tag = (
            ciphertext_with_tag[:-_TAG_BYTES],
            ciphertext_with_tag[-_TAG_BYTES:],
        )
        return (
            f"{_PREFIX}{_SUPPORTED_VERSION}:{iv.hex()}:{tag.hex()}:"
            f"{base64.b64encode(ciphertext).decode('ascii')}"
        )
