# CEX Withdrawal Routing — Video Script

**Target runtime:** 7 minutes

## Storyboard

| Scene | Visual | Narration |
|-------|--------|-----------|
| 1 | Architecture diagram | "Exchanges withdraw on-chain; the bridge correlates via memo." |
| 2 | `routeCexWithdrawal` curl | "Call POST /api/v1/cex/route with exchange, asset, and C-address." |
| 3 | Memo format | "Use the returned memo on the exchange withdrawal form." |
| 4 | Status polling | "Track withdrawalId until funds arrive at the C-address." |

## Terminal commands

```bash
curl -s -X POST http://localhost:3001/api/v1/cex/route \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: dev-key' \
  -d '{"exchange":"binance","sourceAsset":"XLM","amount":"10000000","targetCAddress":"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4","targetNetwork":"stellar","memo":"bridge:binance:DEMO1234"}' | jq .
```
