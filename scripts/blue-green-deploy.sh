#!/usr/bin/env bash
# Blue-green deployment orchestrator for zero-downtime releases.
#
# Example:
#   BLUE_URL=https://blue.example.com \
#   GREEN_URL=https://green.example.com \
#   DEPLOY_GREEN_COMMAND='bash ./scripts/deploy.sh --network testnet' \
#   SWITCH_TRAFFIC_COMMAND='echo "switch to {{color}}"' \
#   bash ./scripts/blue-green-deploy.sh

set -euo pipefail

STATE_FILE="${BLUE_GREEN_STATE_FILE:-deployments/blue-green-state.txt}"
DRAIN_GRACE_SECONDS="${DRAIN_GRACE_SECONDS:-30}"
WARMUP_WINDOW_SECONDS="${WARMUP_WINDOW_SECONDS:-900}"
ROLLBACK_ON_ERROR="${ROLLBACK_ON_ERROR:-true}"
SMOKE_TEST_SCRIPT="${SMOKE_TEST_SCRIPT:-scripts/smoke-test.sh}"
SESSION_PERSISTENCE_MODE="${SESSION_PERSISTENCE_MODE:-sticky}"
ACTIVE_COLOR="${ACTIVE_COLOR:-}"
TARGET_COLOR="${TARGET_COLOR:-}"
BLUE_URL="${BLUE_URL:-}"
GREEN_URL="${GREEN_URL:-}"
DEPLOY_BLUE_COMMAND="${DEPLOY_BLUE_COMMAND:-}"
DEPLOY_GREEN_COMMAND="${DEPLOY_GREEN_COMMAND:-}"
DEPLOY_COMMAND="${DEPLOY_COMMAND:-}"
SWITCH_TRAFFIC_COMMAND="${SWITCH_TRAFFIC_COMMAND:-}"
DRAIN_COMMAND="${DRAIN_COMMAND:-}"
ROLLBACK_COMMAND="${ROLLBACK_COMMAND:-}"
SESSION_PERSISTENCE_COMMAND="${SESSION_PERSISTENCE_COMMAND:-}"
POST_SWITCH_CHECK_COMMAND="${POST_SWITCH_CHECK_COMMAND:-}"
SMOKE_API_KEY="${SMOKE_API_KEY:-}"
DRY_RUN="${DRY_RUN:-false}"

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
warn() { echo "[$(date -u +%H:%M:%SZ)] WARN: $*" >&2; }
err() { echo "[$(date -u +%H:%M:%SZ)] ERROR: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: bash ./scripts/blue-green-deploy.sh [options]

Options:
  --target-color <blue|green>   Override the target color to deploy.
  --active-color <blue|green>   Override the current active color.
  --state-file <path>           Override the state file location.
  --dry-run                     Print the plan without executing it.
  -h, --help                    Show this help message.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-color)
      TARGET_COLOR="$2"
      shift 2
      ;;
    --active-color)
      ACTIVE_COLOR="$2"
      shift 2
      ;;
    --state-file)
      STATE_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      ;;
  esac
done

require_color_url() {
  local color="$1"
  local url_var="$2"
  local url="${!url_var:-}"
  [[ -n "$url" ]] || err "${url_var} is required for ${color} traffic"
  echo "$url"
}

resolve_command() {
  local template="$1"
  local color="$2"
  local url="$3"
  local active="$4"
  local rendered="$template"
  rendered="${rendered//\{\{color\}\}/$color}"
  rendered="${rendered//\{\{url\}\}/$url}"
  rendered="${rendered//\{\{active\}\}/$active}"
  echo "$rendered"
}

load_active_color() {
  if [[ -n "$ACTIVE_COLOR" ]]; then
    echo "$ACTIVE_COLOR"
    return 0
  fi

  if [[ -f "$STATE_FILE" ]]; then
    local color
    color=$(tr -d '[:space:]' < "$STATE_FILE")
    if [[ -n "$color" ]]; then
      echo "$color"
      return 0
    fi
  fi

  echo "blue"
}

save_active_color() {
  mkdir -p "$(dirname "$STATE_FILE")"
  printf '%s\n' "$1" > "$STATE_FILE"
}

select_target_color() {
  local current="$1"
  if [[ -n "$TARGET_COLOR" ]]; then
    echo "$TARGET_COLOR"
    return 0
  fi
  case "$current" in
    blue) echo "green" ;;
    green) echo "blue" ;;
    *) err "Unsupported active color '$current'" ;;
  esac
}

run_command() {
  local cmd="$1"
  log "Executing: $cmd"
  if [[ "$DRY_RUN" == "true" ]]; then
    return 0
  fi
  bash -c "$cmd"
}

run_deploy() {
  local color="$1"
  local url="$2"
  local command_template=""

  if [[ "$color" == "blue" ]]; then
    command_template="${DEPLOY_BLUE_COMMAND:-${DEPLOY_COMMAND:-}}"
  else
    command_template="${DEPLOY_GREEN_COMMAND:-${DEPLOY_COMMAND:-}}"
  fi

  [[ -n "$command_template" ]] || err "No deployment command configured for ${color}. Set DEPLOY_${color^^}_COMMAND or DEPLOY_COMMAND."

  local resolved
  resolved=$(resolve_command "$command_template" "$color" "$url" "$ACTIVE_COLOR")
  run_command "$resolved"
}

run_smoke_tests() {
  local url="$1"
  local cmd="env APP_URL='$url'"
  if [[ -n "$SMOKE_API_KEY" ]]; then
    cmd+=" SMOKE_API_KEY='$SMOKE_API_KEY'"
  fi
  cmd+=" bash '$SMOKE_TEST_SCRIPT'"
  run_command "$cmd"
}

run_session_persistence() {
  if [[ -z "$SESSION_PERSISTENCE_COMMAND" ]]; then
    log "Session persistence mode '$SESSION_PERSISTENCE_MODE' is assumed to be enabled via sticky sessions or an external session store."
    return 0
  fi

  local resolved
  resolved=$(resolve_command "$SESSION_PERSISTENCE_COMMAND" "$1" "$2" "$ACTIVE_COLOR")
  run_command "$resolved"
}

switch_traffic() {
  local color="$1"
  local url="$2"
  [[ -n "$SWITCH_TRAFFIC_COMMAND" ]] || {
    log "No traffic switch command configured; marking $color as active in state only."
    return 0
  }

  local resolved
  resolved=$(resolve_command "$SWITCH_TRAFFIC_COMMAND" "$color" "$url" "$ACTIVE_COLOR")
  run_command "$resolved"
}

draining_rollback_target() {
  local color="$1"
  local url="$2"
  if [[ -n "$DRAIN_COMMAND" ]]; then
    local resolved
    resolved=$(resolve_command "$DRAIN_COMMAND" "$color" "$url" "$ACTIVE_COLOR")
    run_command "$resolved"
    return 0
  fi

  if (( DRAIN_GRACE_SECONDS > 0 )); then
    log "Draining connections for ${color} for ${DRAIN_GRACE_SECONDS}s before decommissioning."
    if [[ "$DRY_RUN" != "true" ]]; then
      sleep "$DRAIN_GRACE_SECONDS"
    fi
  fi
}

run_post_switch_check() {
  local color="$1"
  local url="$2"
  [[ -n "$POST_SWITCH_CHECK_COMMAND" ]] || return 0

  local resolved
  resolved=$(resolve_command "$POST_SWITCH_CHECK_COMMAND" "$color" "$url" "$ACTIVE_COLOR")
  run_command "$resolved"
}

rollback_to_previous() {
  local previous_color="$1"
  local previous_url="$2"
  warn "Rolling traffic back to $previous_color after a failed deployment step."

  if [[ -n "$ROLLBACK_COMMAND" ]]; then
    local resolved
    resolved=$(resolve_command "$ROLLBACK_COMMAND" "$previous_color" "$previous_url" "$ACTIVE_COLOR")
    run_command "$resolved"
  else
    switch_traffic "$previous_color" "$previous_url"
  fi

  save_active_color "$previous_color"
}

main() {
  if [[ -z "$BLUE_URL" || -z "$GREEN_URL" ]]; then
    err "BLUE_URL and GREEN_URL must be set for blue-green deployment."
  fi

  local current_color
  current_color=$(load_active_color)
  local target_color
  target_color=$(select_target_color "$current_color")
  local target_url
  target_url=$(require_color_url "$target_color" "${target_color^^}_URL")
  local previous_color="$current_color"
  local previous_url
  previous_url=$(require_color_url "$previous_color" "${previous_color^^}_URL")

  log "Current active color: $current_color"
  log "Deploying to target color: $target_color"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "Dry run only. Skipped deploy, smoke test, and traffic switch."
    exit 0
  fi

  run_deploy "$target_color" "$target_url"
  run_session_persistence "$target_color" "$target_url"
  run_smoke_tests "$target_url"

  if (( WARMUP_WINDOW_SECONDS > 0 )); then
    log "Keeping $previous_color warm for rollback for ${WARMUP_WINDOW_SECONDS}s."
    sleep "$WARMUP_WINDOW_SECONDS"
  fi

  switch_traffic "$target_color" "$target_url"

  if ! run_post_switch_check "$target_color" "$target_url"; then
    if [[ "$ROLLBACK_ON_ERROR" == "true" ]]; then
      rollback_to_previous "$previous_color" "$previous_url"
      err "Post-switch verification failed; rollback completed."
    fi
    err "Post-switch verification failed."
  fi

  save_active_color "$target_color"
  draining_rollback_target "$previous_color" "$previous_url"
  log "Blue-green deployment completed successfully. Active color: $target_color"
}

main "$@"
