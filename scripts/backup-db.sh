#!/bin/bash
# Database backup script with retention management
# Supports both incremental and full backups

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_TYPE="full"
RETENTION="30d"
S3_BUCKET="${BACKUP_S3_BUCKET:-bridge-backups}"
DB_HOST="${DATABASE_HOST:-localhost}"
DB_PORT="${DATABASE_PORT:-5432}"
DB_NAME="${DATABASE_NAME:-bridge}"
DB_USER="${DATABASE_USER:-postgres}"

# ─── Functions ────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: $0 [OPTIONS]

Database backup script for C-Address Onboarding Bridge.

OPTIONS:
  --type TYPE         Backup type: full or incremental (default: full)
  --retention TIME    Retention period (e.g., 24h, 30d, 90d) (default: 30d)
  --help              Show this help message

EXAMPLES:
  $0 --type full --retention 30d
  $0 --type incremental --retention 24h

ENVIRONMENT VARIABLES:
  BACKUP_S3_BUCKET    S3 bucket for backups (default: bridge-backups)
  DATABASE_HOST       Database host (default: localhost)
  DATABASE_PORT       Database port (default: 5432)
  DATABASE_NAME       Database name (default: bridge)
  DATABASE_USER       Database user (default: postgres)
  PGPASSWORD          Database password (required)

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

check_dependencies() {
  log "Checking dependencies..."
  
  for cmd in pg_dump pg_dumpall aws; do
    if ! command -v "$cmd" &>/dev/null; then
      error "Required command not found: $cmd"
    fi
  done
  
  if [ -z "${PGPASSWORD:-}" ]; then
    error "PGPASSWORD environment variable is not set"
  fi
  
  log "All dependencies satisfied"
}

create_backup() {
  local backup_file="$1"
  
  log "Creating $BACKUP_TYPE backup..."
  
  if [ "$BACKUP_TYPE" = "full" ]; then
    # Full database dump
    pg_dump \
      -h "$DB_HOST" \
      -p "$DB_PORT" \
      -U "$DB_USER" \
      -d "$DB_NAME" \
      -Fc \
      -f "$backup_file" \
      --verbose
  else
    # Incremental backup using pg_dump with specific tables that changed
    # Note: PostgreSQL doesn't have native incremental backup, 
    # so we implement a simple version by backing up specific tables
    pg_dump \
      -h "$DB_HOST" \
      -p "$DB_PORT" \
      -U "$DB_USER" \
      -d "$DB_NAME" \
      -Fc \
      -f "$backup_file" \
      --table="transactions" \
      --table="idempotency_keys" \
      --verbose
  fi
  
  log "Backup created: $backup_file"
}

compress_backup() {
  local backup_file="$1"
  local compressed_file="${backup_file}.gz"
  
  log "Compressing backup..."
  gzip -9 "$backup_file"
  
  log "Backup compressed: $compressed_file"
  echo "$compressed_file"
}

upload_to_s3() {
  local file="$1"
  local s3_path="s3://${S3_BUCKET}/database/${BACKUP_TYPE}/${TIMESTAMP}/$(basename "$file")"
  
  log "Uploading to S3: $s3_path"
  
  aws s3 cp "$file" "$s3_path" \
    --storage-class STANDARD_IA \
    --metadata "backup-type=${BACKUP_TYPE},timestamp=${TIMESTAMP},database=${DB_NAME}"
  
  log "Upload completed: $s3_path"
  echo "$s3_path"
}

generate_checksum() {
  local file="$1"
  
  log "Generating checksum..."
  sha256sum "$file" | awk '{print $1}' | tee "${file}.sha256"
}

upload_checksum() {
  local checksum_file="$1"
  local s3_path="s3://${S3_BUCKET}/database/${BACKUP_TYPE}/${TIMESTAMP}/$(basename "$checksum_file")"
  
  log "Uploading checksum to S3..."
  aws s3 cp "$checksum_file" "$s3_path"
}

cleanup_old_backups() {
  log "Cleaning up old backups (retention: $RETENTION)..."
  
  # Convert retention to seconds
  local retention_seconds
  case "$RETENTION" in
    *h) retention_seconds=$((${RETENTION%h} * 3600)) ;;
    *d) retention_seconds=$((${RETENTION%d} * 86400)) ;;
    *w) retention_seconds=$((${RETENTION%w} * 604800)) ;;
    *) error "Invalid retention format: $RETENTION" ;;
  esac
  
  local cutoff_date
  cutoff_date=$(date -u -d "@$(($(date +%s) - retention_seconds))" '+%Y%m%d')
  
  # List and delete old backups
  aws s3 ls "s3://${S3_BUCKET}/database/${BACKUP_TYPE}/" | while read -r line; do
    local dir_date
    dir_date=$(echo "$line" | awk '{print $2}' | tr -d '/')
    
    if [ -n "$dir_date" ] && [ "$dir_date" -lt "$cutoff_date" ]; then
      log "Deleting old backup: $dir_date"
      aws s3 rm "s3://${S3_BUCKET}/database/${BACKUP_TYPE}/${dir_date}/" --recursive
    fi
  done
  
  log "Cleanup completed"
}

send_notification() {
  local status="$1"
  local message="$2"
  
  # Send to Slack webhook if configured
  if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    curl -X POST "$SLACK_WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      -d "{\"text\": \"Database Backup ${status}: ${message}\"}" \
      || log "Failed to send Slack notification"
  fi
  
  # Send to monitoring system
  if [ -n "${MONITORING_API_URL:-}" ]; then
    curl -X POST "$MONITORING_API_URL/metrics" \
      -H 'Content-Type: application/json' \
      -d "{\"metric\": \"backup.${BACKUP_TYPE}.${status}\", \"timestamp\": \"$TIMESTAMP\", \"message\": \"$message\"}" \
      || log "Failed to send monitoring metric"
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --type)
        BACKUP_TYPE="$2"
        shift 2
        ;;
      --retention)
        RETENTION="$2"
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
  
  # Validate backup type
  if [ "$BACKUP_TYPE" != "full" ] && [ "$BACKUP_TYPE" != "incremental" ]; then
    error "Invalid backup type: $BACKUP_TYPE (must be 'full' or 'incremental')"
  fi
  
  log "Starting database backup"
  log "Type: $BACKUP_TYPE"
  log "Retention: $RETENTION"
  log "Database: $DB_NAME@$DB_HOST:$DB_PORT"
  
  # Check dependencies
  check_dependencies
  
  # Create temporary directory
  TEMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TEMP_DIR"' EXIT
  
  BACKUP_FILE="${TEMP_DIR}/bridge-${BACKUP_TYPE}-${TIMESTAMP}.dump"
  
  # Create backup
  START_TIME=$(date +%s)
  create_backup "$BACKUP_FILE"
  
  # Compress backup
  COMPRESSED_FILE=$(compress_backup "$BACKUP_FILE")
  
  # Generate checksum
  CHECKSUM=$(generate_checksum "$COMPRESSED_FILE")
  CHECKSUM_FILE="${COMPRESSED_FILE}.sha256"
  
  # Upload to S3
  S3_PATH=$(upload_to_s3 "$COMPRESSED_FILE")
  upload_checksum "$CHECKSUM_FILE"
  
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  
  # Get backup size
  BACKUP_SIZE=$(stat -f%z "$COMPRESSED_FILE" 2>/dev/null || stat -c%s "$COMPRESSED_FILE")
  BACKUP_SIZE_MB=$((BACKUP_SIZE / 1024 / 1024))
  
  log "Backup completed successfully"
  log "Duration: ${DURATION}s"
  log "Size: ${BACKUP_SIZE_MB}MB"
  log "Checksum: $CHECKSUM"
  log "S3 Path: $S3_PATH"
  
  # Cleanup old backups
  cleanup_old_backups
  
  # Send success notification
  send_notification "SUCCESS" "Backup completed in ${DURATION}s (${BACKUP_SIZE_MB}MB)"
  
  # Create metadata file
  cat > "${TEMP_DIR}/metadata.json" <<EOF
{
  "backup_type": "$BACKUP_TYPE",
  "timestamp": "$TIMESTAMP",
  "database": "$DB_NAME",
  "host": "$DB_HOST",
  "duration_seconds": $DURATION,
  "size_bytes": $BACKUP_SIZE,
  "size_mb": $BACKUP_SIZE_MB,
  "checksum": "$CHECKSUM",
  "s3_path": "$S3_PATH",
  "retention": "$RETENTION"
}
EOF
  
  # Upload metadata
  aws s3 cp "${TEMP_DIR}/metadata.json" \
    "s3://${S3_BUCKET}/database/${BACKUP_TYPE}/${TIMESTAMP}/metadata.json"
  
  log "Backup process completed"
}

# Run main function
main "$@"
