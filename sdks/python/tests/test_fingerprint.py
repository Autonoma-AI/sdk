"""Tests for fingerprint.py — fingerprint function."""

from autonoma.fingerprint import fingerprint


class TestFingerprint:
    def test_produces_16_char_hex_string(self):
        result = fingerprint({"key": "value"})
        assert len(result) == 16
        int(result, 16)  # valid hex

    def test_order_independent_for_object_keys(self):
        fp1 = fingerprint({"a": 1, "b": 2})
        fp2 = fingerprint({"b": 2, "a": 1})
        assert fp1 == fp2

    def test_different_data_produces_different_fingerprints(self):
        fp1 = fingerprint({"key": "value1"})
        fp2 = fingerprint({"key": "value2"})
        assert fp1 != fp2

    def test_handles_nested_objects(self):
        result = fingerprint({"outer": {"inner": "deep"}})
        assert len(result) == 16

    def test_handles_arrays(self):
        result = fingerprint([1, 2, 3])
        assert len(result) == 16

    def test_handles_strings(self):
        result = fingerprint("hello")
        assert len(result) == 16

    def test_handles_numbers(self):
        result = fingerprint(42)
        assert len(result) == 16
