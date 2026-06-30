"""Typed errors mirroring the TypeScript SDK."""

from __future__ import annotations

from typing import Any


class BridgeError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: str | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.retryable = retryable


class AuthError(BridgeError):
    def __init__(self, message: str = "Unauthorized", **kwargs: Any) -> None:
        super().__init__(message, status_code=kwargs.get("status_code", 401), retryable=False)


class ValidationError(BridgeError):
    def __init__(self, message: str, **kwargs: Any) -> None:
        super().__init__(
            message,
            status_code=kwargs.get("status_code", 400),
            code=kwargs.get("code"),
            retryable=False,
        )
        self.fields = kwargs.get("fields")


class RateLimitError(BridgeError):
    def __init__(self, message: str = "Too many requests", **kwargs: Any) -> None:
        super().__init__(message, status_code=429, code=kwargs.get("code"), retryable=True)
        self.retry_after_ms = kwargs.get("retry_after_ms")


class ServerError(BridgeError):
    def __init__(self, message: str, **kwargs: Any) -> None:
        super().__init__(
            message,
            status_code=kwargs.get("status_code", 500),
            code=kwargs.get("code"),
            retryable=True,
        )


class NotFoundError(BridgeError):
    def __init__(self, message: str = "Not found", **kwargs: Any) -> None:
        super().__init__(message, status_code=404, code=kwargs.get("code"), retryable=False)


class NetworkError(BridgeError):
    def __init__(self, message: str = "Network error", **kwargs: Any) -> None:
        super().__init__(message, code=kwargs.get("code"), retryable=True)


def parse_http_error(status: int, body: dict[str, Any]) -> BridgeError:
    msg = body.get("message") or f"Request failed with status {status}"
    code = body.get("code")
    if status in (401, 403):
        return AuthError(msg, status_code=status, code=code)
    if status == 404:
        return NotFoundError(msg, code=code)
    if status in (400, 422):
        return ValidationError(msg, status_code=status, code=code, fields=body.get("fields"))
    if status == 429:
        retry_after = body.get("retryAfter")
        retry_ms = int(retry_after * 1000) if retry_after is not None else None
        return RateLimitError(msg, code=code, retry_after_ms=retry_ms)
    if status >= 500:
        return ServerError(msg, status_code=status, code=code)
    return BridgeError(msg, status_code=status, code=code, retryable=False)
