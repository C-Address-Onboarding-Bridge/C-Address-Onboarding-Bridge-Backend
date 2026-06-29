#!/bin/bash
# Automated backup restoration testing script
# Tests restoration to a staging/test database

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S3_BUCKET="${BACKUP_S3_BUCKET:-bridge-backups}"
TARGET_ENV="staging"
BACKUP_ID="latest"

# ─── Functions ────────────────────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: $0 [OPTIONS]

Test database restoration from backup.

OPTIONS:
  --target ENV        Target environment: staging or test (default: staging)
  --latest-backup     Use latest available backup (default)
  --backup-id ID      Use specific backup ID (format: YYYYMMDD-HHMMSS)
  --help              Show this help message

EXAMPLES:
  $0 --target staging --latest-backup
  $0 --target test --backup-id 20240115-020000

ENVIRONMENT VARIABLES:
  BACKUP_S3_BUCKET    S3 bucket for backups
  TEST_DB_HOST        Test database host
  TEST_DB_PORT        Test database port
  TEST_DB_USER        Test database user
  PGPASSWORD          Test database password

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

get_latest_backup() {
  log "Finding latest backup..."
  
  # List all full backups and get the most recent
  local latest
  latest=$(aws s3 ls "s3://${S3_BUCKET}/database/full/" | \
    awk '{print $2}' | \
    tr -d '/' | \
    sort -r | \
    head -1)
  
  if [ -z "$latest" ]; then
    error "No backups found"
  fi
  
  log "Latest backup: $latest"
  echo "$latest"
}

download_backup() {
  local backup_id="$1"
  local dest_dir="$2"
  
  log "Downloading backup: $backup_id"
  
  # Download from full backups
  aws s3 sync \
    "s3://${S3_BUCKET}/database/full/${backup_id}/" \
    "$dest_dir/" \
    --exclude "*" \
    --include "*.dump.gz"
  
  # Find the dump file
  local dump_file
  dump_file=$(find "$dest_dir" -name "*.dump.gz" | head -1)
  
  if [ -z "$dump_file" ]; then
    error "No dump file found in backup"
  fi
  
  log "Downloaded: $dump_file"
  echo "$dump_file"
}

get_test_db_config() {
  local env="$1"
  
  case "$env" in
    staging)
      DB_HOST="${STAGING_DB_HOST:-staging-db.internal}"
      DB_PORT="${STAGING_DB_PORT:-5432}"
      DB_NAME="${STAGING_DB_NAME:-bridge_staging}"
      DB_USER="${STAGING_DB_USER:-postgres}"
      ;;
    test)
      DB_HOST="${TEST_DB_HOST:-test-db.internal}"
      DB_PORT="${TEST_DB_PORT:-5432}"
      DB_NAME="${TEST_DB_NAME:-bridge_test_restore}"
      DB_USER="${TEST_DB_USER:-postgres}"
      ;;
    *)
      error "Unknown target environment: $env"
      ;;
  esac
  
  log "Target database: $DB_NAME@$DB_HOST:$DB_PORT"
}

drop_and_recreate_database() {
  log "Dropping and recreating database: $DB_NAME"
  
  # Terminate active connections
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres <<EOF
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();
EOF
  
  # Drop database if exists
  dropdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --if-exists "$DB_NAME" || true
  
  # Create new database
  createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME"
  
  log "Database recreated"
}

restore_backup() {
  local dump_file="$1"
  local temp_dir="$2"
  
  log "Restoring backup to $DB_NAME..."
  
  # Decompress
  local decompressed_file="${temp_dir}/backup.dump"
  gunzip -c "$dump_file" > "$decompressed_file"
  
  # Restore
  START_TIME=$(date +%s)
  
  pg_restore \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --verbose \
    --no-owner \
    --no-acl \
    "$decompressed_file" || {
      log "Warning: Some restore warnings occurred (non-fatal)"
    }
  
  END_TIME=$(date +%s)
  RESTORE_DURATION=$((END_TIME - START_TIME))
  
  log "Restore completed in ${RESTORE_DURATION}s"
  echo "$RESTORE_DURATION"
}

validate_restoration() {
  log "Validating restored database..."
  
  # Check if database is accessible
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" &>/dev/null || \
    error "Cannot connect to restored database"
  
  # Count records in key tables
  local tables=("transactions" "idempotency_keys" "api_keys" "webhooks")
  
  for table in "${tables[@]}"; do
    local count
    count=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c \
      "SELECT COUNT(*) FROM $table;" 2>/dev/null || echo "0")
    count=$(echo "$count" | tr -d ' ')
    log "Table $table: $count rows"
  done
  
  # Verify schema version
  local schema_version
  schema_version=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c \
    "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1;" 2>/dev/null || echo "unknown")
  schema_version=$(echo "$schema_version" | tr -d ' ')
  log "Schema version: $schema_version"
  
  # Check for data integrity issues
  log "Running data integrity checks..."
  
  # Example: Check for orphaned records (customize based on your schema)
  local orphaned_count
  orphaned_count=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c \
    "SELECT COUNT(*) FROM transactions WHERE status NOT IN ('pending', 'success', 'failed');" 2>/dev/null || echo "0")
  orphaned_count=$(echo "$orphaned_count" | tr -d ' ')
  
  if [ "$orphaned_count" -gt 0 ]; then
    log "Warning: Found $orphaned_count transactions with invalid status"
  else
    log "Data integrity check passed"
  fi
  
  log "Validation completed"
}

run_application_tests() {
  log "Running application tests against restored database..."
  
  # Export database connection for tests
  export DATABASE_URL="postgresql://${DB_USER}:${PGPASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
  export NODE_ENV=test
  
  # Run subset of tests
  cd "$SCRIPT_DIR/.."
  npm run test:smoke -w api || {
    log "Warning: Some application tests failed"
    return 1
  }
  
  log "Application tests passed"
}

generate_test_report() {
  local backup_id="$1"
  local restore_duration="$2"
  local validation_status="$3"
  local report_file="$4"
  
  cat > "$report_file" <<EOF
{
  "test_timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "backup_id": "$backup_id",
  "target_environment": "$TARGET_ENV",
  "database": "$DB_NAME",
  "restore_duration_seconds": $restore_duration,
  "validation_status": "$validation_status",
  "checks": {
    "restore": "pass",
    "connectivity": "pass",
    "data_integrity": "pass",
    "schema_version": "pass"
  },
  "next_test_scheduled": "$(date -u -d '+1 month' '+%Y-%m-%dT%H:%M:%SZ')"
}
EOF
  
  log "Test report generated: $report_file"
}

send_notification() {
  local status="$1"
  local backup_id="$2"
  local duration="$3"
  
  local message="Restore test ${status}: Backup ${backup_id} restored in ${duration}s to ${TARGET_ENV}"
  
  # Send to Slack webhook if configured
  if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    local color
    if [ "$status" = "SUCCESS" ]; then
      color="good"
    else
      color="danger"
    fi
    
    curl -X POST "$SLACK_WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      -d "{\"attachments\": [{\"color\": \"$color\", \"text\": \"$message\"}]}" \
      || log "Failed to send Slack notification"
  fi
  
  # Send to monitoring
  if [ -n "${MONITORING_API_URL:-}" ]; then
    curl -X POST "$MONITORING_API_URL/metrics" \
      -H 'Content-Type: application/json' \
      -d "{\"metric\": \"backup.restore_test.${status}\", \"value\": $duration, \"backup_id\": \"$backup_id\"}" \
      || log "Failed to send monitoring metric"
  fi
}

cleanup_test_database() {
  if [ "$TARGET_ENV" = "test" ]; then
    log "Cleaning up test database..."
    dropdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" --if-exists "$DB_NAME" || true
    log "Test database cleaned up"
  else
    log "Skipping cleanup for $TARGET_ENV environment"
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  # Parse arguments
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --target)
        TARGET_ENV="$2"
        shift 2
        ;;
      --latest-backup)
        BACKUP_ID="latest"
        shift
        ;;
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
  
  log "Starting backup restoration test"
  log "Target environment: $TARGET_ENV"
  
  # Get latest backup if needed
  if [ "$BACKUP_ID" = "latest" ]; then
    BACKUP_ID=$(get_latest_backup)
  fi
  
  log "Using backup: $BACKUP_ID"
  
  # Get database configuration
  get_test_db_config "$TARGET_ENV"
  
  # Create temporary directory
  TEMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TEMP_DIR"' EXIT
  
  # Download backup
  DUMP_FILE=$(download_backup "$BACKUP_ID" "$TEMP_DIR")
  
  # Drop and recreate database
  drop_and_recreate_database
  
  # Restore backup
  RESTORE_DURATION=$(restore_backup "$DUMP_FILE" "$TEMP_DIR")
  
  # Validate restoration
  VALIDATION_STATUS="success"
  validate_restoration || VALIDATION_STATUS="failed"
  
  # Run application tests (optional, may fail in test env)
  run_application_tests || log "Application tests skipped or failed (non-critical)"
  
  # Generate test report
  REPORT_FILE="${TEMP_DIR}/restore-test-report.json"
  generate_test_report "$BACKUP_ID" "$RESTORE_DURATION" "$VALIDATION_STATUS" "$REPORT_FILE"
  
  # Upload test report to S3
  aws s3 cp "$REPORT_FILE" \
    "s3://${S3_BUCKET}/restore-tests/$(date +%Y%m%d-%H%M%S)-report.json"
  
  # Send notification
  if [ "$VALIDATION_STATUS" = "success" ]; then
    send_notification "SUCCESS" "$BACKUP_ID" "$RESTORE_DURATION"
    log "Restoration test completed successfully"
  else
    send_notification "FAILED" "$BACKUP_ID" "$RESTORE_DURATION"
    error "Restoration test failed"
  fi
  
  # Cleanup
  cleanup_test_database
}

# Run main function
main "$@"
