#!/usr/bin/env bash
# deploy-cdn-assets.sh — Upload static assets to the CDN S3 bucket and
# invalidate the CloudFront cache for changed paths.
#
# Usage:
#   ./scripts/deploy-cdn-assets.sh [--env production|staging] [--invalidate]
#
# Required env vars (or set via Terraform output):
#   CDN_BUCKET   — S3 bucket name (terraform output cdn_assets_bucket_name)
#   CDN_DIST_ID  — CloudFront distribution ID (terraform output cloudfront_distribution_id)

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:-production}"
INVALIDATE=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --invalidate) INVALIDATE=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

: "${CDN_BUCKET:?CDN_BUCKET env var is required}"
: "${CDN_DIST_ID:?CDN_DIST_ID env var is required}"

echo "==> Deploying CDN assets to s3://${CDN_BUCKET} (env: ${ENVIRONMENT})"

# ── API Docs (OpenAPI spec + Postman collection) ────────────────────────────
echo "  Uploading API docs..."
aws s3 sync \
  "${REPO_ROOT}/docs/api-reference/" \
  "s3://${CDN_BUCKET}/docs/" \
  --cache-control "public, max-age=31536000, immutable" \
  --content-type "application/json" \
  --exclude "*.md" \
  --delete

# HTML/Markdown docs with shorter cache
aws s3 sync \
  "${REPO_ROOT}/docs/api-reference/" \
  "s3://${CDN_BUCKET}/docs/" \
  --cache-control "public, max-age=86400" \
  --exclude "*" \
  --include "*.md" \
  --include "*.html"

# ── SDK browser builds ──────────────────────────────────────────────────────
if [[ -d "${REPO_ROOT}/sdk/dist" ]]; then
  echo "  Uploading SDK browser builds..."
  aws s3 sync \
    "${REPO_ROOT}/sdk/dist/" \
    "s3://${CDN_BUCKET}/sdk/" \
    --cache-control "public, max-age=31536000, immutable" \
    --delete
else
  echo "  [skip] sdk/dist not found — run 'npm run build -w sdk' first"
fi

# ── CloudFront invalidation ─────────────────────────────────────────────────
if [[ "${INVALIDATE}" == "true" ]]; then
  echo "  Creating CloudFront invalidation for /docs/* and /sdk/*..."
  INVALIDATION_ID=$(aws cloudfront create-invalidation \
    --distribution-id "${CDN_DIST_ID}" \
    --paths "/docs/*" "/sdk/*" \
    --query 'Invalidation.Id' \
    --output text)
  echo "  Invalidation created: ${INVALIDATION_ID}"
  echo "  Waiting for invalidation to complete..."
  aws cloudfront wait invalidation-completed \
    --distribution-id "${CDN_DIST_ID}" \
    --id "${INVALIDATION_ID}"
  echo "  Invalidation complete."
fi

echo "==> CDN asset deployment done."
