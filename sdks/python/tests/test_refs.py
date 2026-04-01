"""Tests for refs.py — sign_refs and verify_refs."""

import pytest

from autonoma.refs import sign_refs, verify_refs


class TestRefs:
    def test_round_trip(self):
        payload = {"testRunId": "abc-123", "refs": {"User": [{"id": 1}]}}
        token = sign_refs(payload, "signing-secret")
        decoded = verify_refs(token, "signing-secret")
        assert decoded == payload

    def test_token_has_three_dot_separated_parts(self):
        token = sign_refs({"foo": "bar"}, "secret")
        parts = token.split(".")
        assert len(parts) == 3

    def test_rejects_wrong_secret(self):
        token = sign_refs({"data": 1}, "correct-secret")
        with pytest.raises(ValueError, match="signature mismatch"):
            verify_refs(token, "wrong-secret")

    def test_rejects_tampered_token(self):
        token = sign_refs({"data": 1}, "secret")
        parts = token.split(".")
        # Tamper with payload
        tampered = parts[0] + "." + parts[1] + "X" + "." + parts[2]
        with pytest.raises(ValueError):
            verify_refs(tampered, "secret")
