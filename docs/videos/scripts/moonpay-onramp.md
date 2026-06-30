# MoonPay Fiat On-Ramp — Video Script

**Target runtime:** 6 minutes

## Storyboard

| Scene | Visual | Narration |
|-------|--------|-----------|
| 1 | `.env` MoonPay keys | "Set MOONPAY_API_KEY and MOONPAY_SECRET_KEY in your environment." |
| 2 | API server logs | "Restart the API so it picks up the new secrets." |
| 3 | `createMoonpayUrl` curl | "Call the off-ramp endpoint with wallet address and fiat amount." |
| 4 | Browser widget preview | "Open the returned URL in a WebView or browser tab." |

## Terminal commands

```bash
grep MOONPAY .env.local.example
curl -s -X POST http://localhost:3001/api/v1/offramp/moonpay \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: dev-key' \
  -d '{"walletAddress":"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4","currencyCode":"xlm","walletNetwork":"stellar","baseCurrencyAmount":100,"baseCurrencyCode":"USD"}' | jq .
```
