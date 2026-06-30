# Wallet SDK Integration — Video Script

**Target runtime:** 8 minutes  
**Chapters:** Install → Client → Quote/Prepare → Sign/Submit → Status

## Storyboard

| Scene | Visual | Narration |
|-------|--------|-----------|
| 1 | `npm install @c-address-bridge/sdk` | "Add the TypeScript SDK to your wallet project." |
| 2 | `BridgeClient` constructor | "Point the client at your API URL and pass the API key." |
| 3 | `getQuote` + `prepareFundingTransaction` | "Fetch a fee quote, then prepare an unsigned XDR for the user to sign." |
| 4 | Wallet sign mock | "Hand the instruction to your wallet's sign API." |
| 5 | `submitSignedXdr` + `getStatus` | "Submit the signed envelope and poll until confirmed." |

## Terminal commands

```bash
cd sdk && npm ci && npm run build
node -e "
const { BridgeClient } = require('./dist/index.js');
const c = new BridgeClient({ baseUrl: 'http://localhost:3001', apiKey: 'dev-key' });
(async () => {
  const q = await c.getQuote({ sourceAsset: 'XLM', amount: '10000000', targetAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4' });
  console.log('Quote fee:', q.estimatedFee);
  const prep = await c.prepareFundingTransaction({
    sourceAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    targetAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    tokenAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    amount: '10000000',
  });
  console.log('Prepared instruction length:', prep.instruction.length);
})();
"
```
