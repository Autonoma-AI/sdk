"""JWT-like teardown token: header.payload.signature using HMAC-SHA256."""

import base64
import hashlib
import hmac
import json

from autonoma.serializer import default_serializer as _default_serializer


def sign_refs(payload: dict, secret: str) -> str:
    """Sign a refs payload into a 3-part token string.

    In v2 the payload carries ``refs`` (whatever the scenario returned),
    ``testRunId``, and ``environment`` (the scenario name, so ``down`` can
    route to the right teardown).
    """
    header = _base64url_encode(json.dumps({"alg": "HS256", "typ": "REFS"}, separators=(",", ":")).encode())
    body = _base64url_encode(json.dumps(payload, separators=(",", ":"), default=_default_serializer).encode())
    signature = _hmac_sign(f"{header}.{body}", secret)
    return f"{header}.{body}.{signature}"


def verify_refs(token: str, secret: str) -> dict:
    """Verify and decode a teardown token. Returns the payload dict or raises."""
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("malformed token")

    header, body, signature = parts
    expected = _hmac_sign(f"{header}.{body}", secret)

    if not hmac.compare_digest(expected, signature):
        raise ValueError("signature mismatch")

    return json.loads(_base64url_decode(body))


def _base64url_encode(data: bytes) -> str:
    """Base64url encode without padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _base64url_decode(data: str) -> bytes:
    """Base64url decode, adding padding back."""
    padding = 4 - len(data) % 4
    if padding != 4:
        data += "=" * padding
    return base64.urlsafe_b64decode(data)


def _hmac_sign(data: str, secret: str) -> str:
    """HMAC-SHA256 sign and return base64url-encoded result without padding."""
    sig = hmac.new(secret.encode(), data.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(sig).rstrip(b"=").decode()
