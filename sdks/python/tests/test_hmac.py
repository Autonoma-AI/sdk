"""Tests for hmac_util.py — sign_body and verify_signature."""

from autonoma.hmac_util import sign_body, verify_signature


class TestSignBody:
    def test_signs_deterministically(self):
        sig1 = sign_body("hello", "secret")
        sig2 = sign_body("hello", "secret")
        assert sig1 == sig2

    def test_empty_body(self):
        sig = sign_body("", "secret")
        assert isinstance(sig, str)
        assert len(sig) == 64

    def test_different_secrets_produce_different_signatures(self):
        sig1 = sign_body("body", "secret1")
        sig2 = sign_body("body", "secret2")
        assert sig1 != sig2

    def test_produces_64_char_hex_string(self):
        sig = sign_body("test body", "test secret")
        assert len(sig) == 64
        # Verify it's a valid hex string
        int(sig, 16)


class TestVerifySignature:
    def test_verifies_valid_signature(self):
        sig = sign_body("payload", "mysecret")
        assert verify_signature("payload", sig, "mysecret") is True

    def test_rejects_invalid_signature(self):
        assert verify_signature("payload", "bad_signature", "mysecret") is False
