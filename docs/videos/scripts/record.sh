#!/usr/bin/env bash
# Record or re-record an asciinema walkthrough.
# Usage: ./record.sh <name>   e.g. ./record.sh getting-started
set -euo pipefail
NAME="${1:?usage: record.sh <name>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
CAST="$DIR/../casts/${NAME}.cast"
SCRIPT="$DIR/${NAME}.md"

if [[ ! -f "$SCRIPT" ]]; then
  echo "Missing script: $SCRIPT" >&2
  exit 1
fi

echo "Follow the script at $SCRIPT"
echo "Recording to $CAST"
asciinema rec -c "bash -lc 'cat \"$SCRIPT\" | sed -n \"/^\\\`\\\`\\\`bash/,/^\\\`\\\`\\\`/p\" | sed \"1d;\\\$d\" | bash'" "$CAST"
