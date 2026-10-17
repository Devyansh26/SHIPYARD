"""Independent reference implementation of the platform ``secretRef`` format.

This module deliberately does **not** import ``app.services.encryption_service``
(or any app helper): it re-implements ``enc:v1:<iv_hex>:<tag_hex>:<base64>``
AES-256-GCM from the docs (docs/02 §5, docs/03) so that CMS decryption is tested
for *compatibility* with the platform, not self-consistency with its own
``encrypt`` helper.

Key derivation matches the docs and the Control API:
``Buffer.from(ENCRYPTION_KEY, 'hex')`` -> 32 raw bytes (no KDF).
"""

from __future__ import annotations

import base64
import os
from typing import Optional, Tuple

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_IV_BYTES = 12
_TAG_BYTES = 16
_KEY_BYTES = 32
_PREFIX = "enc:v1:"


def reference_key(hex_key: str) -> bytes:
    """Decode a 64-char hex master key into 32 raw bytes (docs behaviour)."""
    key = bytes.fromhex(hex_key)
    if len(key) != _KEY_BYTES:
        raise ValueError("reference key must decode to 32 bytes")
    return key


def reference_encrypt(
    plaintext: str, hex_key: str, *, iv: Optional[bytes] = None
) -> str:
    """Encrypt ``plaintext`` into a docs-compliant ``enc:v1:`` secretRef."""
    key = reference_key(hex_key)
    nonce = iv if iv is not None else os.urandom(_IV_BYTES)
    if len(nonce) != _IV_BYTES:
        raise ValueError("iv must be 12 bytes")
    ciphertext_and_tag = AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), None)
    ciphertext, tag = (
        ciphertext_and_tag[:-_TAG_BYTES],
        ciphertext_and_tag[-_TAG_BYTES:],
    )
    return (
        f"{_PREFIX}{nonce.hex()}:{tag.hex()}:"
        f"{base64.b64encode(ciphertext).decode('ascii')}"
    )


def reference_decrypt(secret_ref: str, hex_key: str) -> str:
    """Decrypt a docs-compliant ``enc:v1:`` secretRef (used to double-check)."""
    if not secret_ref.startswith(_PREFIX):
        raise ValueError("not a v1 secretRef")
    iv_hex, tag_hex, ct_b64 = secret_ref[len(_PREFIX):].split(":")
    key = reference_key(hex_key)
    data = base64.b64decode(ct_b64) + bytes.fromhex(tag_hex)
    return AESGCM(key).decrypt(bytes.fromhex(iv_hex), data, None).decode("utf-8")


def split_ref(secret_ref: str) -> Tuple[str, str, str, str]:
    """Split ``enc:v1:<iv>:<tag>:<ct>`` into its four segments."""
    prefix, version, iv_hex, tag_hex, ct = secret_ref.split(":")
    return prefix, version, iv_hex, tag_hex, ct


def tamper_ciphertext(secret_ref: str, hex_key: str) -> str:
    """Flip one byte of the ciphertext so GCM authentication must fail."""
    _, version, iv_hex, tag_hex, ct_b64 = split_ref(secret_ref)
    raw = bytearray(base64.b64decode(ct_b64))
    raw[0] ^= 0xFF
    encoded = base64.b64encode(bytes(raw)).decode("ascii")
    return f"enc:{version}:{iv_hex}:{tag_hex}:{encoded}"


__all__ = [
    "reference_key",
    "reference_encrypt",
    "reference_decrypt",
    "split_ref",
    "tamper_ciphertext",
]
