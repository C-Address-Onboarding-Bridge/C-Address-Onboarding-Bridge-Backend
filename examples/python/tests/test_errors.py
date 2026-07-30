"""Unit tests for client-side HTTP error-mapping logic.

Run from examples/python/:
    python -m unittest discover -s tests
"""

from __future__ import annotations

import unittest

from c_address_bridge.errors import (
    AuthError,
    BridgeError,
    NetworkError,
    NotFoundError,
    RateLimitError,
    ServerError,
    ValidationError,
    parse_http_error,
)


class ParseHttpErrorTests(unittest.TestCase):
    def test_maps_401_and_403_to_auth_error(self) -> None:
        for status in (401, 403):
            err = parse_http_error(status, {"message": "nope"})
            self.assertIsInstance(err, AuthError)
            self.assertEqual(err.status_code, status)
            self.assertEqual(str(err), "nope")

    def test_maps_404_to_not_found(self) -> None:
        err = parse_http_error(404, {"message": "missing"})
        self.assertIsInstance(err, NotFoundError)
        self.assertEqual(err.status_code, 404)
        self.assertEqual(str(err), "missing")

    def test_maps_400_and_422_to_validation_error_with_fields(self) -> None:
        for status in (400, 422):
            err = parse_http_error(status, {"message": "bad input", "fields": ["amount"]})
            self.assertIsInstance(err, ValidationError)
            self.assertEqual(err.status_code, status)
            self.assertEqual(err.fields, ["amount"])

    def test_maps_429_to_rate_limit_with_retry_after_ms(self) -> None:
        err = parse_http_error(429, {"message": "slow down", "retryAfter": 2.5})
        self.assertIsInstance(err, RateLimitError)
        self.assertTrue(err.retryable)
        self.assertEqual(err.retry_after_ms, 2500)

    def test_maps_429_without_retry_after(self) -> None:
        err = parse_http_error(429, {"message": "slow down"})
        self.assertIsInstance(err, RateLimitError)
        self.assertIsNone(err.retry_after_ms)

    def test_maps_5xx_to_server_error(self) -> None:
        for status in (500, 502, 503):
            err = parse_http_error(status, {"message": "boom"})
            self.assertIsInstance(err, ServerError)
            self.assertEqual(err.status_code, status)
            self.assertTrue(err.retryable)

    def test_unknown_status_falls_back_to_base_error(self) -> None:
        err = parse_http_error(418, {"message": "teapot"})
        self.assertIs(type(err), BridgeError)
        self.assertEqual(str(err), "teapot")
        self.assertFalse(err.retryable)

    def test_falls_back_to_default_message_when_missing(self) -> None:
        err = parse_http_error(500, {})
        self.assertEqual(str(err), "Request failed with status 500")

    def test_network_error_is_retryable(self) -> None:
        err = NetworkError("connection reset")
        self.assertTrue(err.retryable)
        self.assertEqual(str(err), "connection reset")


if __name__ == "__main__":
    unittest.main()
