#!/bin/bash
# Backup verification script
# Verifies backup integrity and restorability

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S3_BUCKET="${BACKUP_S3_BUCKET:-bridge-backups}"
BACKUP_ID=""

# ─── Functions ────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: $0 --backup-id BACKUP_ID

Verify backup integrity and metadata.

OPTIONS:
  --backup-id ID      Backup identifier (timestamp format: YYYYMMDD-HHMMSS)
  --help              Show this help message

EXAMPLES:
  $0 --backup-id 20240115-020000

EOF
  exit 1
}

log() {
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*"
}

error() {
  log "ERROR: $*" >&2
  exit 1
}

verify_backup_exists() {
  local backup_id="$1"
  
  log "Checking if backup exists: $backup_id"
  
  # List backups in both full and incremental directories
  local found=false
  for backup_type in full incremental; do
    if aws s3 ls "s3://${S3_BUCKET}/database/${backup_type}/${backup_id}/" &>/dev/null; then
      log "Found backup in ${backup_type} directory"
      echo "$backup_type"
      found=true
      return 0
    fi
  done
  
  if [ "$found" = false ]; then
    error "Backup not found: $backup_id"
  fi
}

download_backup() {
  local backup_id="$1"
  local backup_type="$2"
  local dest_dir="$3"
  
  log "Downloading backup files..."
  
  aws s3 sync \
    "s3://${S3_BUCKET}/database/${backup_type}/${backup_id}/" \
    "$dest_dir/" \
    --exclude "*" \
    --include "*.dump.gz" \
    --include "*.sha256" \
    --include "metadata.json"
  
  # Find the dump file
  local dump_file
  dump_file=$(find "$dest_dir" -name "*.dump.gz" | head -1)
  
  if [ -z "$dump_file" ]; then
    error "No dump file found in backup"
  fi
  
  echo "$dump_file"
}

verify_checksum() {
  local file="$1"
  local checksum_file="${file}.sha256"
  
  log "Verifying checksum..."
  
  if [ ! -f "$checksum_file" ]; then
    error "Checksum file not found: $checksum_file"
  fi
  
  local expected_checksum
  expected_checksum=$(cat "$checksum_file")
  
  local actual_checksum
  actual_checksum=$(sha256sum "$file" | awk '{print $1}')
  
  if [ "$expected_checksum" != "$actual_checksum" ]; then
    error "Checksum mismatch! Expected: $expected_checksum, Got: $actual_checksum"
  fi
  
  log "Checksum verified: $actual_checksum"
}

verify_metadata() {
  local metadata_file="$1"
  
  log "Verifying metadata..."
  
  if [ ! -f "$metadata_file" ]; then
    log "Warning: metadata.json not found"
    return 0
  fi
  
  # Parse and display metadata
  if command -v jq &>/dev/null; then
    log "Backup metadata:"
    jq '.' "$metadata_file"
  else
    log "Backup metadata (raw):"
    cat "$metadata_file"
  fi
}

test_decompress() {
  local compressed_file="$1"
  
  log "Testing decompression..."
  
  # Test gunzip without extracting
  if gzip -t "$compressed_file" 2>/dev/null; then
    log "Decompression test passed"
  else
    error "Decompression test failed"
  fi
}

test_restore_dry_run() {
  local dump_file="$1"
  local temp_dir="$2"
  
  log "Testing restore (dry-run)..."
  
  # Decompress
  local decompressed_file="${temp_dir}/backup.dump"
  gunzip -c "$dump_file" > "$decompressed_file"
  
  # List contents without restoring
  if pg_restore --list "$decompressed_file" &>/dev/null; then
    log "Restore dry-run passed"
    
    # Count tables
    local table_count
    table_count=$(pg_restore --list "$decompressed_file" | grep -c "TABLE DATA" || true)
    log "Backup contains $table_count tables"
  else
    error "Restore dry-run failed"
  fi
}

generate_report() {
  local backup_id="$1"
  local backup_type="$2"
  local report_file="$3"
  
  cat > "$report_file" <<EOF
{
  "verification_timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "backup_id": "$backup_id",
  "backup_type": "$backup_type",
  "status": "verified",
  "checks": {
    "exists": "pass",
    "checksum": "pass",
    "decompress": "pass",
    "restore_dry_run": "pass"
  }
}
EOF
  
  log "Verification report generated: $report_file"
}

send_notification() {
  local status="$1"
  local backup_id="$2"
  
  # Send to Slack webhook if configured
  if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    curl -X POST "$SLACK_WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      -d "{\"text\": \"Backup Verification ${status}: ${backup_id}\"}" \
      || log "Failed to send Slack notification"
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --backup-id)
        BACKUP_ID="$2"
        shift 2
        ;;
      --help)
        usage
        ;;
      *)
        error "Unknown option: $1"
        ;;
    esac
  done
  
  if [ -z "$BACKUP_ID" ]; then
    error "Missing required argument: --backup-id"
  fi
  
  log "Starting backup verification"
  log "Backup ID: $BACKUP_ID"
  
  # Create temporary directory
  TEMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TEMP_DIR"' EXIT
  
  # Verify backup exists and get type
  BACKUP_TYPE=$(verify_backup_exists "$BACKUP_ID")
  
  # Download backup
  DUMP_FILE=$(download_backup "$BACKUP_ID" "$BACKUP_TYPE" "$TEMP_DIR")
  
  # Verify checksum
  verify_checksum "$DUMP_FILE"
  
  # Verify metadata
  METADATA_FILE="${TEMP_DIR}/metadata.json"
  verify_metadata "$METADATA_FILE"
  
  # Test decompression
  test_decompress "$DUMP_FILE"
  
  # Test restore (dry-run)
  test_restore_dry_run "$DUMP_FILE" "$TEMP_DIR"
  
  # Generate verification report
  REPORT_FILE="${TEMP_DIR}/verification-report.json"
  generate_report "$BACKUP_ID" "$BACKUP_TYPE" "$REPORT_FILE"
  
  # Upload verification report to S3
  aws s3 cp "$REPORT_FILE" \
    "s3://${S3_BUCKET}/database/${BACKUP_TYPE}/${BACKUP_ID}/verification-report.json"
  
  log "Backup verification completed successfully"
  
  # Send success notification
  send_notification "SUCCESS" "$BACKUP_ID"
}

# Run main function
main "$@"
