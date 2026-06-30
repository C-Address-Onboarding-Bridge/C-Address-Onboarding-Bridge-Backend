"""C-Address Bridge HTTP client for Python."""

from .client import BridgeClient
from .errors import (
    AuthError,
    BridgeError,
    NetworkError,
    NotFoundError,
    RateLimitError,
    ServerError,
    ValidationError,
    parse_http_error,
)

__all__ = [
    "BridgeClient",
    "BridgeError",
    "AuthError",
    "ValidationError",
    "RateLimitError",
    "ServerError",
    "NotFoundError",
    "NetworkError",
    "parse_http_error",
]

__version__ = "0.1.0"
