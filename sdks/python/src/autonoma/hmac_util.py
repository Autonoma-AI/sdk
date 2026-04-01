"""HMAC-SHA256 signing and verification for request authentication."""

import hmac
import hashlib


def sign_body(body: str, secret: str) -> str:
    """Sign a body string with a secret using HMAC-SHA256. Returns 64-char lowercase hex."""
    return hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()


def verify_signature(body: str, signature: str, secret: str) -> bool:
    """Verify a signature using constant-time comparison."""
    expected = sign_body(body, secret)
    return hmac.compare_digest(expected, signature)
