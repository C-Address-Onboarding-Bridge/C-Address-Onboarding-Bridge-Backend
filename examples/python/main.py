#!/usr/bin/env python3
"""Runnable C-Address Bridge integration example (Python)."""

from __future__ import annotations

import os
import sys

from c_address_bridge import BridgeClient, BridgeError

MOCK_C_ADDRESS = "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU"
MOCK_G_ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU"
MOCK_TOKEN_ADDRESS = "CATOKEN7ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMN"


def main() -> int:
    client = BridgeClient.from_env()
    print(f"Bridge client → {client.base_url}")

    try:
        health = client.health()
        print(f"Health: {health['status']}")

        quote = client.get_quote("XLM", "10000000", MOCK_C_ADDRESS)
        print(f"Quote fee: {quote['estimatedFee']} stroops, receive: {quote['expectedReceive']}")

        prepared = client.prepare_funding(
            MOCK_G_ADDRESS, MOCK_C_ADDRESS, MOCK_TOKEN_ADDRESS, "10000000", memo="onboarding"
        )
        print(f"Funding prepared: {prepared['instruction'][:40]}...")

        funded = client.submit_signed_xdr("AAAAAgAAAABexampleSignedTransactionXdr")
        print(f"Fund submitted: {funded['status']} hash={funded['hash'][:16]}...")

        status = client.get_status(funded["hash"])
        print(f"Transaction status: {status['status']}")

        moonpay = client.create_moonpay_url(
            walletAddress=MOCK_C_ADDRESS,
            currencyCode="xlm",
            walletNetwork="stellar",
            baseCurrencyAmount=100,
            baseCurrencyCode="USD",
        )
        print(f"MoonPay URL: {moonpay['url'][:60]}...")

        transak = client.create_transak_url(
            walletAddress=MOCK_C_ADDRESS,
            network="stellar",
            fiatCurrency="USD",
            cryptoCurrency="XLM",
            fiatAmount=100,
        )
        print(f"Transak URL: {transak['url'][:60]}...")

        print("All flows completed successfully.")
        return 0
    except BridgeError as exc:
        print(f"Bridge error ({exc.status_code}): {exc}", file=sys.stderr)
        if exc.retryable:
            print("Hint: this error is retryable — back off and try again.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
