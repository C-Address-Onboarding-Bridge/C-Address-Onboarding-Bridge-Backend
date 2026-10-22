"""Minimal Python client for the C-Address Onboarding Bridge API.

Demonstrates funding and CEX routing with idempotency keys so retries of the
same logical request are de-duplicated by the server.
"""

import uuid

import requests

BASE_URL = "http://localhost:8080"


def _idempotency_headers(key):
    return {"Idempotency-Key": key}


def fund(address, amount, asset, idempotency_key=None):
    """POST /api/v1/fund with an idempotency key.

    Pass the same ``idempotency_key`` when retrying the same logical request so
    the server can de-duplicate it. A fresh UUIDv4 is generated otherwise.
    """
    key = idempotency_key or str(uuid.uuid4())
    resp = requests.post(
        f"{BASE_URL}/api/v1/fund",
        json={"address": address, "amount": amount, "asset": asset},
        headers=_idempotency_headers(key),
    )
    resp.raise_for_status()
    return resp.json()


def cex_route(address, amount, asset, idempotency_key=None):
    """POST /api/v1/cex/route with an idempotency key.

    Reuse ``idempotency_key`` across retries of the same logical request.
    """
    key = idempotency_key or str(uuid.uuid4())
    resp = requests.post(
        f"{BASE_URL}/api/v1/cex/route",
        json={"address": address, "amount": amount, "asset": asset},
        headers=_idempotency_headers(key),
    )
    resp.raise_for_status()
    return resp.json()


if __name__ == "__main__":
    # Generate once and reuse on retries of the same logical request.
    fund_key = str(uuid.uuid4())
    print(fund("0xabc...", "1.0", "ETH", idempotency_key=fund_key))

    route_key = str(uuid.uuid4())
    print(cex_route("0xabc...", "1.0", "ETH", idempotency_key=route_key))
