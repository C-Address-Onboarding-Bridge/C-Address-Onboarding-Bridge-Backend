# Video Walkthroughs

Visual guides for common C-Address Bridge integration flows. Each walkthrough includes a **script** (for accuracy review), a **self-hosted asciinema recording**, and chapter markers for navigation.

> **Accessibility:** All recordings include closed-caption tracks (`.vtt`) synced to the terminal output. Re-record with `docs/videos/scripts/record.sh <name>` after major version bumps.

---

## 1. Getting started in 5 minutes

Clone the repo, start Docker, and hit the health endpoint.

| | |
|---|---|
| **Duration** | ~5 min |
| **Chapters** | 0:00 Clone · 1:30 Docker up · 3:00 Health check · 4:30 Next steps |
| **Script** | [getting-started.md](videos/scripts/getting-started.md) |
| **Recording** | [getting-started.cast](videos/casts/getting-started.cast) |
| **Captions** | [getting-started.vtt](videos/captions/getting-started.vtt) |

```bash
asciinema play docs/videos/casts/getting-started.cast
```

<asciinema-player src="videos/casts/getting-started.cast" cols="100" rows="24" preload="true" speed="1.25"></asciinema-player>

---

## 2. Integrating the SDK into a wallet

Wire `BridgeClient` into a wallet app: quote → prepare → sign → submit → poll status.

| | |
|---|---|
| **Duration** | ~8 min |
| **Chapters** | 0:00 Install SDK · 1:00 Client setup · 3:00 Quote & prepare · 5:30 Sign & submit · 7:00 Status polling |
| **Script** | [wallet-integration.md](videos/scripts/wallet-integration.md) |
| **Recording** | [wallet-integration.cast](videos/casts/wallet-integration.cast) |
| **Captions** | [wallet-integration.vtt](videos/captions/wallet-integration.vtt) |

See also: [wallet-integration.md](wallet-integration.md)

```bash
asciinema play docs/videos/casts/wallet-integration.cast
```

<asciinema-player src="videos/casts/wallet-integration.cast" cols="100" rows="24" preload="true"></asciinema-player>

---

## 3. Setting up MoonPay fiat on-ramp

Configure MoonPay env vars and generate widget URLs for C-address funding.

| | |
|---|---|
| **Duration** | ~6 min |
| **Chapters** | 0:00 Env vars · 2:00 API key setup · 3:30 Widget URL · 5:00 Webhook verify |
| **Script** | [moonpay-onramp.md](videos/scripts/moonpay-onramp.md) |
| **Recording** | [moonpay-onramp.cast](videos/casts/moonpay-onramp.cast) |
| **Captions** | [moonpay-onramp.vtt](videos/captions/moonpay-onramp.vtt) |

```bash
asciinema play docs/videos/casts/moonpay-onramp.cast
```

<asciinema-player src="videos/casts/moonpay-onramp.cast" cols="100" rows="24" preload="true"></asciinema-player>

---

## 4. Configuring CEX withdrawals

Route exchange withdrawals to a C-address with memo correlation.

| | |
|---|---|
| **Duration** | ~7 min |
| **Chapters** | 0:00 Overview · 1:30 Route API · 4:00 Memo format · 6:00 Status tracking |
| **Script** | [cex-withdrawals.md](videos/scripts/cex-withdrawals.md) |
| **Recording** | [cex-withdrawals.cast](videos/casts/cex-withdrawals.cast) |
| **Captions** | [cex-withdrawals.vtt](videos/captions/cex-withdrawals.vtt) |

```bash
asciinema play docs/videos/casts/cex-withdrawals.cast
```

<asciinema-player src="videos/casts/cex-withdrawals.cast" cols="100" rows="24" preload="true"></asciinema-player>

---

## 5. Running the API server locally

Start Postgres, Redis, Soroban quickstart, and the API with hot reload.

| | |
|---|---|
| **Duration** | ~6 min |
| **Chapters** | 0:00 Prerequisites · 1:00 setup-dev.sh · 3:00 docker compose · 5:00 Smoke test |
| **Script** | [local-api-server.md](videos/scripts/local-api-server.md) |
| **Recording** | [local-api-server.cast](videos/casts/local-api-server.cast) |
| **Captions** | [local-api-server.vtt](videos/captions/local-api-server.vtt) |

See also: [developer-setup.md](developer-setup.md)

```bash
asciinema play docs/videos/casts/local-api-server.cast
```

<asciinema-player src="videos/casts/local-api-server.cast" cols="100" rows="24" preload="true"></asciinema-player>

---

## Recording new walkthroughs

```bash
# Install asciinema: https://asciinema.org/docs/installation
./docs/videos/scripts/record.sh getting-started
```

Upload to YouTube for a wider audience, then add the embed URL to the script front-matter `youtube:` field.

## Keeping videos current

Re-record when any of these change:

- SDK major version (`@c-address-bridge/sdk`)
- API route paths or auth headers
- Docker Compose service names/ports
- MoonPay / Transak integration env vars

Mark outdated casts with `<!-- stale: v0.x -->` in the script until re-recorded.
