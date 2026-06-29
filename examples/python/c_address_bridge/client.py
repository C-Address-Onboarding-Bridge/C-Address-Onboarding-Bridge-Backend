"""HTTP client for the C-Address Bridge REST API."""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .errors import BridgeError, NetworkError, parse_http_error

DEFAULT_TIMEOUT = 30


class BridgeClient:
    def __init__(self, base_url: str, api_key: str | None = None, timeout: int = DEFAULT_TIMEOUT) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    @classmethod
    def from_env(cls) -> "BridgeClient":
        base_url = os.environ.get("BRIDGE_BASE_URL", "http://localhost:3099")
        api_key = os.environ.get("BRIDGE_API_KEY")
        return cls(base_url, api_key)

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.api_key:
            headers["X-API-Key"] = self.api_key
        return headers

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        if params:
            url = f"{url}?{urlencode(params)}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = Request(url, data=data, headers=self._headers(), method=method)
        try:
            with urlopen(req, timeout=self.timeout) as resp:
                payload = resp.read().decode("utf-8")
                return json.loads(payload) if payload else {}
        except HTTPError as exc:
            try:
                err_body = json.loads(exc.read().decode("utf-8"))
            except Exception:
                err_body = {"message": exc.reason}
            raise parse_http_error(exc.code, err_body) from exc
        except URLError as exc:
            raise NetworkError(str(exc.reason)) from exc

    def get_quote(self, source_asset: str, amount: str, target_address: str) -> dict[str, Any]:
        return self._request(
            "GET",
            "/api/v1/quote",
            params={"sourceAsset": source_asset, "amount": amount, "targetAddress": target_address},
        )

    def prepare_funding(
        self,
        source_address: str,
        target_address: str,
        token_address: str,
        amount: str,
        memo: str = "",
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/v1/fund/prepare",
            body={
                "sourceAddress": source_address,
                "targetAddress": target_address,
                "tokenAddress": token_address,
                "amount": amount,
                "memo": memo,
            },
        )

    def submit_signed_xdr(self, signed_xdr: str) -> dict[str, Any]:
        return self._request("POST", "/api/v1/fund", body={"signedXdr": signed_xdr})

    def get_status(self, tx_hash: str) -> dict[str, Any]:
        return self._request("GET", f"/api/v1/status/{tx_hash}")

    def create_moonpay_url(self, **params: Any) -> dict[str, str]:
        return self._request("POST", "/api/v1/offramp/moonpay", body=params)

    def create_transak_url(self, **params: Any) -> dict[str, str]:
        return self._request("POST", "/api/v1/offramp/transak", body=params)

    def health(self) -> dict[str, str]:
        return self._request("GET", "/health")
