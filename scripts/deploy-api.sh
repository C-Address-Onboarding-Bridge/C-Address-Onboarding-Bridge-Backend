#!/usr/bin/env bash
# deploy-api.sh — Ship the API application Docker image to a remote host over SSH.
#
# This is the counterpart to scripts/deploy.sh (which deploys the Soroban
# smart contract, not the API app). This script does the actual work implied
# by deploy.yml / rollback.yml: pull the freshly built image from GHCR onto
# DEPLOY_HOST and run it as the API container, with a single-hop rollback to
# whatever image was running before the last deploy.
#
# Usage:
#   IMAGE_TAG=sha-abc123 bash scripts/deploy-api.sh
#   bash scripts/deploy-api.sh --rollback
#
# Options:
#   --rollback   redeploy the image that was running before the last deploy
#                on this host, ignoring IMAGE_TAG
#
# Required env vars:
#   DEPLOY_HOST   — SSH host to deploy to
#   DEPLOY_USER   — SSH user
#   DEPLOY_KEY    — SSH private key (PEM content, not a path)
#   IMAGE_TAG     — Docker tag to deploy (not required with --rollback)
#
# Optional env vars:
#   IMAGE_REPO       — full image repo, default ghcr.io/$GITHUB_REPOSITORY
#   DEPLOY_PORT       — SSH port (default 22)
#   CONTAINER_NAME    — Docker container name (default c-address-bridge-api)
#   REMOTE_APP_DIR    — remote state directory (default /opt/c-address-bridge)
#   REMOTE_ENV_FILE   — env file passed to `docker run --env-file` on the host
#                       (default $REMOTE_APP_DIR/.env)
#   HOST_PORT         — host port to publish (default 3001)
#   CONTAINER_PORT    — container port the app listens on (default 3001)
#   SSH_OPTS          — extra ssh/scp options

set -euo pipefail

ROLLBACK=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rollback) ROLLBACK=true; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

DEPLOY_HOST="${DEPLOY_HOST:?DEPLOY_HOST is required}"
DEPLOY_USER="${DEPLOY_USER:?DEPLOY_USER is required}"
DEPLOY_KEY="${DEPLOY_KEY:?DEPLOY_KEY is required}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
IMAGE_REPO="${IMAGE_REPO:-ghcr.io/${GITHUB_REPOSITORY:-}}"
CONTAINER_NAME="${CONTAINER_NAME:-c-address-bridge-api}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/opt/c-address-bridge}"
REMOTE_ENV_FILE="${REMOTE_ENV_FILE:-${REMOTE_APP_DIR}/.env}"
HOST_PORT="${HOST_PORT:-3001}"
CONTAINER_PORT="${CONTAINER_PORT:-3001}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=accept-new -o ConnectTimeout=10}"

log()  { echo "[$(date -u +%H:%M:%SZ)] $*"; }
warn() { echo "[$(date -u +%H:%M:%SZ)] WARN: $*" >&2; }
err()  { echo "[$(date -u +%H:%M:%SZ)] ERROR: $*" >&2; exit 1; }

KEY_FILE="$(mktemp)"
cleanup() { rm -f "$KEY_FILE"; }
trap cleanup EXIT

printf '%s\n' "$DEPLOY_KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"

# shellcheck disable=SC2086
ssh_run() {
  ssh $SSH_OPTS -p "$DEPLOY_PORT" -i "$KEY_FILE" "${DEPLOY_USER}@${DEPLOY_HOST}" "$@"
}

# Runs the given image as $CONTAINER_NAME on the remote host, recording the
# previously-running image (if any) to REMOTE_APP_DIR/previous-image.txt so a
# later --rollback can put it back.
remote_run_image() {
  local image="$1"
  ssh_run bash -s <<REMOTE_SCRIPT
set -euo pipefail
mkdir -p "${REMOTE_APP_DIR}"
touch "${REMOTE_ENV_FILE}"

echo "Pulling ${image}..."
docker pull "${image}"

if docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  CURRENT_IMAGE=\$(docker inspect --format '{{.Config.Image}}' "${CONTAINER_NAME}")
  if [[ "\$CURRENT_IMAGE" != "${image}" ]]; then
    echo "\$CURRENT_IMAGE" > "${REMOTE_APP_DIR}/previous-image.txt"
  fi
  echo "Stopping existing container ${CONTAINER_NAME}..."
  docker stop "${CONTAINER_NAME}" >/dev/null
  docker rm "${CONTAINER_NAME}" >/dev/null
fi

echo "Starting ${CONTAINER_NAME} from ${image}..."
docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  --env-file "${REMOTE_ENV_FILE}" \
  "${image}"

echo "${image}" > "${REMOTE_APP_DIR}/current-image.txt"

echo "Waiting for container to become healthy..."
for i in \$(seq 1 30); do
  if curl -sf "http://localhost:${HOST_PORT}/health" >/dev/null 2>&1; then
    echo "Container is healthy."
    exit 0
  fi
  sleep 2
done
echo "Container did not become healthy in time." >&2
exit 1
REMOTE_SCRIPT
}

deploy() {
  local image_tag="${IMAGE_TAG:?IMAGE_TAG is required}"
  [[ -n "$IMAGE_REPO" ]] || err "IMAGE_REPO is required (or set GITHUB_REPOSITORY)"
  local image="${IMAGE_REPO}:${image_tag}"

  log "Deploying ${image} to ${DEPLOY_HOST}:${DEPLOY_PORT} as ${CONTAINER_NAME}..."
  remote_run_image "$image"
  log "Deployment complete. DEPLOYED_IMAGE=${image}"
}

rollback() {
  log "Rolling back ${CONTAINER_NAME} on ${DEPLOY_HOST}..."
  local prev_image
  prev_image=$(ssh_run "cat '${REMOTE_APP_DIR}/previous-image.txt' 2>/dev/null" || true)
  [[ -n "$prev_image" ]] || err "No previous image recorded on ${DEPLOY_HOST}. Manual rollback required."

  log "Redeploying previous image: ${prev_image}"
  remote_run_image "$prev_image"
  log "Rollback complete. DEPLOYED_IMAGE=${prev_image}"
}

if $ROLLBACK; then
  rollback
else
  deploy
fi
