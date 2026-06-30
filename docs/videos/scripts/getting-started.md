# Getting Started in 5 Minutes — Video Script

**Target runtime:** 5 minutes  
**Chapters:** Clone → Docker → Health → Next steps

## Storyboard

| Scene | Visual | Narration |
|-------|--------|-----------|
| 1 | Terminal: git clone | "Clone the monorepo and enter the project directory." |
| 2 | `./scripts/setup-dev.sh` scrolling | "The bootstrap script installs deps, copies .env, and builds packages." |
| 3 | `docker compose up -d` + service table | "Start the local stack: API, Postgres, Redis, and Soroban quickstart." |
| 4 | `curl localhost:3001/health` | "Confirm the API is healthy before integrating." |
| 5 | Link to SDK docs | "Next: install the SDK or try a multi-language example." |

## Terminal commands

```bash
git clone https://github.com/C-Address-Onboarding-Bridge/C-Address-Onboarding-Bridge-Backend.git
cd C-Address-Onboarding-Bridge-Backend
./scripts/setup-dev.sh
docker compose up -d
curl -s http://localhost:3001/health | jq .
echo "Ready — see docs/developer-setup.md and examples/"
```
