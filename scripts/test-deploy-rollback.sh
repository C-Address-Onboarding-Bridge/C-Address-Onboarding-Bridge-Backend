#!/usr/bin/env bash
# test-deploy-rollback.sh — exercise deploy-api.sh and blue-green-deploy.sh
# against stubbed ssh/docker/curl, so the rollback paths are tested without a
# host, registry or load balancer (#1099).
#
# Usage: bash scripts/test-deploy-rollback.sh   (needs bash >= 4)
#
# Stubs:
#   ssh    — runs the "remote" command locally (`bash -s` reads the heredoc).
#   docker — keeps images/containers in a temp dir. Pulling a tag resolves it
#            to a digest derived from the tag plus FAKE_BUILD (so "rebuilding"
#            a tag yields a new digest); pulling repo@sha256:<d> resolves to <d>.
#   curl   — health checks always succeed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASH_BIN="${BASH:-bash}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

BIN="$WORK/bin"
STATE="$WORK/docker"
mkdir -p "$BIN" "$STATE/refs" "$STATE/containers"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ok   - $*"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $*"; }
expect_eq() { if [[ "$1" == "$2" ]]; then ok "$3"; else fail "$3 (expected '$2', got '$1')"; fi; }

# ── Stubs ──────────────────────────────────────────────────────────────────────

cat > "$BIN/ssh" <<'EOF'
#!/usr/bin/env bash
# Drop ssh options up to and including user@host, run the rest locally.
while [[ $# -gt 0 && "$1" != *@* ]]; do shift; done
shift
exec bash -c "$*"
EOF

cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
S="$FAKE_DOCKER_STATE"
sha() {
  if command -v sha256sum >/dev/null 2>&1; then printf '%s' "$1" | sha256sum | cut -c1-64
  else printf '%s' "$1" | shasum -a 256 | cut -c1-64; fi
}
repo_of() { local r="$1"; r="${r%@*}"; echo "${r%:*}"; }

# Resolve a reference (tag, repo@sha256:d, or sha256:id) to an image id.
resolve() {
  local ref="$1"
  case "$ref" in
    sha256:*) [[ -f "$S/refs/$(sha "$ref")" ]] || [[ -f "$S/ids/${ref#sha256:}" ]] || return 1; echo "$ref" ;;
    *) [[ -f "$S/refs/$(sha "$ref")" ]] || return 1; cat "$S/refs/$(sha "$ref")" ;;
  esac
}

cmd="$1"; shift
case "$cmd" in
  pull)
    ref="$1"
    if [[ "$ref" == *@sha256:* ]]; then d="${ref##*@sha256:}"; else d="$(sha "${ref}${FAKE_BUILD:-}")"; fi
    mkdir -p "$S/ids"
    echo "$(repo_of "$ref")@sha256:$d" > "$S/ids/$d"
    echo "sha256:$d" > "$S/refs/$(sha "$ref")"
    ;;
  image)
    sub="$1"; shift
    [[ "$sub" == inspect ]] || { echo "unsupported: docker image $sub" >&2; exit 2; }
    fmt=""
    if [[ "$1" == --format ]]; then fmt="$2"; shift 2; fi
    id="$(resolve "$1")" || { echo "No such image: $1" >&2; exit 1; }
    case "$fmt" in
      '') echo "[]" ;;
      '{{.Id}}') echo "$id" ;;
      *RepoDigests*) cat "$S/ids/${id#sha256:}" ;;
      *) echo "unsupported format $fmt" >&2; exit 2 ;;
    esac
    ;;
  inspect)
    fmt=""
    if [[ "$1" == --format ]]; then fmt="$2"; shift 2; fi
    f="$S/containers/$1"
    [[ -f "$f" ]] || { echo "No such container: $1" >&2; exit 1; }
    case "$fmt" in
      '') echo "[]" ;;
      '{{.Image}}') cat "$f" ;;
      *) echo "unsupported format $fmt" >&2; exit 2 ;;
    esac
    ;;
  stop) echo "$1" ;;
  rm) rm -f "$S/containers/$1" ;;
  run)
    name=""; image=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        -p|--env-file|--restart) shift 2 ;;
        -d) shift ;;
        *) image="$1"; shift ;;
      esac
    done
    resolve "$image" > "$S/containers/$name"
    ;;
  *) echo "unsupported: docker $cmd" >&2; exit 2 ;;
esac
EOF
chmod +x "$BIN"/*

export PATH="$BIN:$PATH"
export FAKE_DOCKER_STATE="$STATE"

# ── deploy-api.sh ─────────────────────────────────────────────────────────────

echo "deploy-api.sh"
REMOTE="$WORK/remote"
export DEPLOY_HOST=fake-host DEPLOY_USER=deploy DEPLOY_KEY=dummy-key
export IMAGE_REPO=ghcr.io/example/api REMOTE_APP_DIR="$REMOTE" CONTAINER_NAME=api
deploy_api() { "$BASH_BIN" "$ROOT/scripts/deploy-api.sh" "$@" >"$WORK/out.log" 2>&1; }
running_id() { cat "$STATE/containers/api"; }

IMAGE_TAG=sha-aaa deploy_api
ID_A="$(running_id)"
[[ ! -f "$REMOTE/previous-image.txt" ]] && ok "first deploy records no previous image" || fail "first deploy wrote previous-image.txt"

IMAGE_TAG=sha-bbb deploy_api
ID_B="$(running_id)"
[[ "$ID_A" != "$ID_B" ]] && ok "second deploy runs a different image" || fail "second deploy did not change the image"
expect_eq "$(cat "$REMOTE/previous-image.txt")" "ghcr.io/example/api@sha256:${ID_A#sha256:}" \
  "previous image is recorded by registry digest"

deploy_api --rollback
expect_eq "$(running_id)" "$ID_A" "--rollback restores the previous build"

if IMAGE_TAG=main deploy_api; then
  fail "mutable tag 'main' was deployed"
else
  grep -q "Refusing to deploy mutable tag 'main'" "$WORK/out.log" \
    && ok "mutable tag 'main' is refused" || fail "mutable tag refused with an unexpected message"
fi

# A moving tag rebuilt under the same name: with ALLOW_MUTABLE_TAG the
# previous build is still recorded because image IDs (not names) are compared.
IMAGE_TAG=main ALLOW_MUTABLE_TAG=true FAKE_BUILD=1 deploy_api
ID_M1="$(running_id)"
IMAGE_TAG=main ALLOW_MUTABLE_TAG=true FAKE_BUILD=2 deploy_api
expect_eq "$(cat "$REMOTE/previous-image.txt")" "ghcr.io/example/api@sha256:${ID_M1#sha256:}" \
  "rebuilt tag with the same name still records the previous digest"
deploy_api --rollback
expect_eq "$(running_id)" "$ID_M1" "--rollback after a same-name rebuild restores the earlier build"

IMAGE_DIGEST="sha256:${ID_B#sha256:}" deploy_api
expect_eq "$(running_id)" "$ID_B" "IMAGE_DIGEST deploys repo@sha256:<digest>"

# ── blue-green-deploy.sh ──────────────────────────────────────────────────────

echo "blue-green-deploy.sh"
LOG="$WORK/bg.log"
SMOKE="$WORK/smoke-ok.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SMOKE"
bg() {
  : > "$LOG"
  env BLUE_URL=https://blue.test GREEN_URL=https://green.test \
    BLUE_GREEN_STATE_FILE="$WORK/bg-state.txt" \
    DEPLOY_COMMAND="echo deploy {{color}} >> '$LOG'" \
    SMOKE_TEST_SCRIPT="$SMOKE" WARMUP_WINDOW_SECONDS=0 DRAIN_GRACE_SECONDS=0 \
    "$@" "$BASH_BIN" "$ROOT/scripts/blue-green-deploy.sh" >"$WORK/bg-out.log" 2>&1
}

echo blue > "$WORK/bg-state.txt"
if bg SWITCH_TRAFFIC_COMMAND=; then
  fail "deploy without SWITCH_TRAFFIC_COMMAND succeeded"
else
  grep -q "SWITCH_TRAFFIC_COMMAND is required" "$WORK/bg-out.log" && ok "missing SWITCH_TRAFFIC_COMMAND fails" \
    || fail "missing SWITCH_TRAFFIC_COMMAND failed with an unexpected message"
  [[ ! -s "$LOG" ]] && ok "nothing is deployed when the switch command is missing" || fail "deployed despite missing switch command"
fi

echo blue > "$WORK/bg-state.txt"
env BLUE_URL=https://blue.test GREEN_URL=https://green.test BLUE_GREEN_STATE_FILE="$WORK/bg-state.txt" \
  "$BASH_BIN" "$ROOT/scripts/blue-green-deploy.sh" --dry-run >/dev/null 2>&1 \
  && ok "--dry-run is still allowed without a switch command" || fail "--dry-run failed without a switch command"

echo blue > "$WORK/bg-state.txt"
if bg SWITCH_TRAFFIC_COMMAND="echo switch {{color}} >> '$LOG'" POST_SWITCH_CHECK_COMMAND="false"; then
  fail "failed post-switch check reported success"
else
  expect_eq "$(grep -c '^switch' "$LOG")" "2" "failed post-switch check switches twice (forward, then back)"
  expect_eq "$(grep '^switch' "$LOG" | tail -1)" "switch blue" "traffic is switched back to the previous color"
  expect_eq "$(tr -d '[:space:]' < "$WORK/bg-state.txt")" "blue" "state file records the previous color after rollback"
fi

echo blue > "$WORK/bg-state.txt"
bg SWITCH_TRAFFIC_COMMAND="echo switch {{color}} >> '$LOG'" POST_SWITCH_CHECK_COMMAND="true" \
  && ok "successful blue/green deploy exits 0" || fail "successful blue/green deploy failed"
expect_eq "$(grep '^switch' "$LOG")" "switch green" "traffic is switched to the new color"
expect_eq "$(tr -d '[:space:]' < "$WORK/bg-state.txt")" "green" "state file records the new active color"

echo
echo "passed: $PASS, failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
