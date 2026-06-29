# Disaster Recovery Runbook

> Comprehensive disaster recovery (DR) documentation and procedures for the C-Address Onboarding Bridge infrastructure.

---

## Table of Contents

1. [Overview](#overview)
2. [Recovery Objectives](#recovery-objectives)
3. [Disaster Scenarios](#disaster-scenarios)
4. [Infrastructure Overview](#infrastructure-overview)
5. [Backup Strategy](#backup-strategy)
6. [Recovery Procedures](#recovery-procedures)
7. [Automated Testing](#automated-testing)
8. [DR Drill Schedule](#dr-drill-schedule)
9. [Contact Information](#contact-information)

---

## Overview

This runbook provides step-by-step procedures for recovering from various disaster scenarios that could affect the C-Address Onboarding Bridge service. All procedures are designed to be executed under high-pressure situations and should be practiced regularly through DR drills.

**Last Updated**: 2024-01-15  
**Version**: 1.0.0  
**Maintained By**: Infrastructure Team

---

## Recovery Objectives

### RTO (Recovery Time Objective)

**Target: < 1 hour**

Maximum acceptable time between service disruption and service restoration.

### RPO (Recovery Point Objective)

**Target: < 5 minutes**

Maximum acceptable amount of data loss measured in time.

### Service Level Targets

| Component         | RTO        | RPO             | Priority |
| ----------------- | ---------- | --------------- | -------- |
| API Server        | 30 minutes | 5 minutes       | Critical |
| Database          | 45 minutes | 5 minutes       | Critical |
| Smart Contract    | 1 hour     | N/A (immutable) | High     |
| Monitoring/Alerts | 15 minutes | N/A             | High     |
| Documentation     | 4 hours    | 24 hours        | Medium   |

---

## Disaster Scenarios

### Scenario 1: Single Instance Failure

**Symptoms**:

- Health check failures
- 503 Service Unavailable errors
- Single availability zone down
- Instance terminated or unreachable

**Impact**: Partial service degradation if running multiple instances

**Recovery Time**: 10-15 minutes (automatic with auto-scaling)

---

### Scenario 2: Regional Outage

**Symptoms**:

- All instances in one region unreachable
- Cloud provider status page shows regional issue
- Multiple availability zones affected simultaneously
- Network connectivity loss to entire region

**Impact**: Complete service outage if single-region deployment

**Recovery Time**: 45-60 minutes (requires manual failover)

---

### Scenario 3: Database Corruption

**Symptoms**:

- Data inconsistency errors
- Database connection failures
- Failed integrity checks
- Corrupted indexes or tables

**Impact**: Service degradation or complete outage

**Recovery Time**: 30-45 minutes (restore from backup)

---

### Scenario 4: Secret/Key Compromise

**Symptoms**:

- Unauthorized access detected
- Suspicious API activity
- Security alert triggered
- Leaked credentials in public repository

**Impact**: Security breach, potential data exposure

**Recovery Time**: 15-30 minutes (rotate secrets)

---

### Scenario 5: Smart Contract Vulnerability

**Symptoms**:

- Unexpected contract behavior
- Security audit finding critical vulnerability
- Exploit detected in the wild
- Abnormal fee accumulation

**Impact**: Financial loss, service unavailable

**Recovery Time**: 1-4 hours (requires contract upgrade)

---

## Infrastructure Overview

### Architecture Components

```
┌─────────────────────────────────────────────────────────────┐
│                         Production                           │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐         ┌──────────────┐                  │
│  │  Load         │────────▶│  API Server  │                  │
│  │  Balancer     │         │  (Primary)   │                  │
│  └──────────────┘         └──────────────┘                  │
│         │                         │                           │
│         │                  ┌──────────────┐                  │
│         └─────────────────▶│  API Server  │                  │
│                            │  (Secondary) │                  │
│                            └──────────────┘                  │
│                                   │                           │
│                            ┌──────────────┐                  │
│                            │  PostgreSQL  │                  │
│                            │  (Primary)   │◀────────────────┐│
│                            └──────────────┘                 ││
│                                   │                          ││
│                            ┌──────────────┐                 ││
│                            │  PostgreSQL  │                 ││
│                            │  (Replica)   │─────────────────┘│
│                            └──────────────┘                  │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                 Stellar Soroban Network                 │ │
│  │               (External - Not Controlled)               │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Critical Dependencies

| Dependency    | Type     | Failure Impact        | Mitigation              |
| ------------- | -------- | --------------------- | ----------------------- |
| Soroban RPC   | External | Service unavailable   | Multiple RPC endpoints  |
| PostgreSQL    | Internal | Data operations fail  | Read replicas + backups |
| Redis         | Internal | Cache miss (degraded) | Graceful degradation    |
| Load Balancer | Internal | Traffic routing fails | Multi-region setup      |

---

## Backup Strategy

### Database Backups

#### Automated Backup Schedule

```bash
# Hourly incremental backups (retained for 24 hours)
0 * * * * /scripts/backup-db.sh --type incremental --retention 24h

# Daily full backups (retained for 30 days)
0 2 * * * /scripts/backup-db.sh --type full --retention 30d

# Weekly full backups (retained for 90 days)
0 3 * * 0 /scripts/backup-db.sh --type full --retention 90d
```

#### Backup Storage

- **Primary**: S3 bucket with versioning enabled
- **Secondary**: Cross-region replication to backup region
- **Tertiary**: Weekly backups copied to cold storage (Glacier)

#### Backup Verification

Automated integrity checks run after each backup:

```bash
# Verify backup integrity
/scripts/verify-backup.sh --backup-id <id>

# Test restore to staging environment (daily)
/scripts/test-restore.sh --target staging --latest-backup
```

### Configuration Backups

- **Infrastructure as Code (IaC)**: All configuration in Git repository
- **Secrets**: Encrypted backups in separate secure S3 bucket
- **Application Config**: Version controlled, tagged releases

### Smart Contract Backups

- **Source Code**: Version controlled in Git
- **Compiled WASM**: Stored with deployment records
- **Contract State**: Cannot be backed up (on-chain), but all operations are logged

---

## Recovery Procedures

### Procedure 1: Single Instance Failure Recovery

**Prerequisites**: Access to AWS console or CLI

**Steps**:

1. **Detect and Verify Failure**

   ```bash
   # Check instance health
   aws ec2 describe-instance-status --instance-ids <instance-id>

   # Verify health check endpoint
   curl -f https://api.bridge.example.com/health || echo "Health check failed"
   ```

2. **Check Auto-Scaling Response**

   ```bash
   # Verify auto-scaling group is launching replacement
   aws autoscaling describe-auto-scaling-groups \
     --auto-scaling-group-names bridge-api-asg
   ```

3. **Manual Intervention (if auto-scaling fails)**

   ```bash
   # Terminate failed instance
   aws ec2 terminate-instances --instance-ids <failed-instance-id>

   # Increase desired capacity
   aws autoscaling set-desired-capacity \
     --auto-scaling-group-name bridge-api-asg \
     --desired-capacity 2
   ```

4. **Verify Recovery**

   ```bash
   # Wait for new instance to be healthy
   aws ec2 wait instance-running --instance-ids <new-instance-id>

   # Test API endpoint
   curl -f https://api.bridge.example.com/health
   ```

5. **Post-Recovery**
   - Review logs to determine root cause
   - Update incident report
   - Check if similar instances need attention

**Expected Duration**: 10-15 minutes

---

### Procedure 2: Regional Outage Recovery

**Prerequisites**:

- Multi-region setup configured
- DNS failover configured
- Access to Route 53 or equivalent

**Steps**:

1. **Confirm Regional Outage**

   ```bash
   # Check AWS status page
   curl https://status.aws.amazon.com/

   # Verify primary region is down
   aws ec2 describe-regions --region us-east-1 || echo "Region unavailable"
   ```

2. **Initiate Failover to Secondary Region**

   ```bash
   # Update Route 53 health check to force failover
   aws route53 change-resource-record-sets \
     --hosted-zone-id <zone-id> \
     --change-batch file://failover-config.json
   ```

3. **Promote Secondary Database to Primary**

   ```bash
   # Promote read replica to primary
   aws rds promote-read-replica \
     --db-instance-identifier bridge-db-replica-us-west-2

   # Wait for promotion to complete
   aws rds wait db-instance-available \
     --db-instance-identifier bridge-db-replica-us-west-2
   ```

4. **Update Application Configuration**

   ```bash
   # Update API servers to point to new primary database
   kubectl set env deployment/bridge-api \
     DATABASE_URL=postgresql://user:pass@new-primary-db:5432/bridge

   # Rolling restart of API servers
   kubectl rollout restart deployment/bridge-api
   ```

5. **Verify Service in New Region**

   ```bash
   # Check health endpoint
   curl -f https://api.bridge.example.com/health

   # Run smoke tests
   npm run test:smoke
   ```

6. **Update Monitoring and Alerts**
   - Update dashboards to reflect new region
   - Verify alerts are triggering correctly
   - Notify team of failover completion

7. **Post-Outage Recovery**
   - When primary region recovers, restore original configuration
   - Recreate read replicas
   - Validate data consistency

**Expected Duration**: 45-60 minutes

---

### Procedure 3: Database Corruption Recovery

**Prerequisites**: Recent backup available, access to database credentials

**Steps**:

1. **Detect Corruption**

   ```bash
   # Check database integrity
   psql -h <db-host> -U <user> -d bridge -c "SELECT * FROM pg_stat_database;"

   # Run integrity checks
   psql -h <db-host> -U <user> -d bridge -c "VACUUM FULL VERBOSE;"
   ```

2. **Stop Application Traffic to Database**

   ```bash
   # Scale down API servers or enable maintenance mode
   kubectl scale deployment/bridge-api --replicas=0

   # Verify no active connections
   psql -h <db-host> -U <user> -c \
     "SELECT COUNT(*) FROM pg_stat_activity WHERE datname='bridge';"
   ```

3. **Identify Latest Good Backup**

   ```bash
   # List available backups
   aws s3 ls s3://bridge-backups/database/ --recursive | sort -r | head -20

   # Verify backup integrity
   ./scripts/verify-backup.sh --backup-id <backup-id>
   ```

4. **Restore from Backup**

   ```bash
   # Download backup
   aws s3 cp s3://bridge-backups/database/<backup-file> /tmp/

   # Drop corrupted database (CAUTION!)
   dropdb -h <db-host> -U <user> bridge

   # Create new database
   createdb -h <db-host> -U <user> bridge

   # Restore from backup
   pg_restore -h <db-host> -U <user> -d bridge /tmp/<backup-file>
   ```

5. **Run Migrations (if needed)**

   ```bash
   # Apply any pending migrations
   npm run migrate -w api
   ```

6. **Verify Data Integrity**

   ```bash
   # Run data validation scripts
   npm run validate:data -w api

   # Check row counts
   psql -h <db-host> -U <user> -d bridge -c \
     "SELECT COUNT(*) FROM transactions;"
   ```

7. **Restart Application**

   ```bash
   # Scale up API servers
   kubectl scale deployment/bridge-api --replicas=3

   # Verify health
   curl -f https://api.bridge.example.com/health
   ```

8. **Post-Recovery Validation**
   - Run end-to-end tests
   - Review logs for errors
   - Document data loss (if any)
   - Update incident report

**Expected Duration**: 30-45 minutes

---

### Procedure 4: Secret/Key Compromise Recovery

**Prerequisites**: Access to secret management system, new key generation capability

**Steps**:

1. **Identify Compromised Secrets**
   - Review security alerts
   - Check GitHub secret scanning alerts
   - Identify which secrets were exposed

2. **Revoke Compromised Credentials**

   ```bash
   # Revoke API keys
   curl -X DELETE https://api.bridge.example.com/api/v1/admin/keys/<key-id> \
     -H "Authorization: Bearer <admin-token>"

   # Disable compromised service accounts
   aws iam update-access-key \
     --access-key-id <key-id> \
     --status Inactive
   ```

3. **Generate New Secrets**

   ```bash
   # Generate new API keys
   openssl rand -hex 32

   # Generate new database password
   openssl rand -base64 32
   ```

4. **Update Secret Management System**

   ```bash
   # Update secrets in AWS Secrets Manager
   aws secretsmanager put-secret-value \
     --secret-id bridge/api-key \
     --secret-string "<new-secret>"

   # Update Kubernetes secrets
   kubectl create secret generic bridge-secrets \
     --from-literal=api-key=<new-key> \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

5. **Rolling Update of Applications**

   ```bash
   # Restart pods to pick up new secrets
   kubectl rollout restart deployment/bridge-api

   # Wait for rollout to complete
   kubectl rollout status deployment/bridge-api
   ```

6. **Notify Affected Users** (if customer-facing secrets)
   - Send email notifications
   - Update documentation
   - Provide migration timeline

7. **Audit and Investigation**
   - Review access logs
   - Identify how compromise occurred
   - Implement additional security measures

8. **Post-Recovery**
   - Update runbook with lessons learned
   - Implement secret scanning in CI/CD
   - Schedule security review

**Expected Duration**: 15-30 minutes

---

### Procedure 5: Smart Contract Vulnerability Recovery

**Prerequisites**: Updated contract WASM, admin keys, understanding of upgrade mechanism

**Steps**:

1. **Assess Vulnerability Impact**
   - Review security audit report
   - Determine if exploit is active
   - Calculate potential financial impact

2. **Prepare Contract Upgrade**

   ```bash
   # Build updated contract
   cd contracts/onboarding-bridge
   cargo build --target wasm32-unknown-unknown --release

   # Test updated contract
   cargo test

   # Verify fix addresses vulnerability
   cargo audit
   ```

3. **Deploy Updated Contract** (if upgradeable)

   ```bash
   # Upload new WASM
   soroban contract deploy \
     --wasm target/wasm32-unknown-unknown/release/onboarding_bridge.wasm \
     --source <admin-secret> \
     --rpc-url <soroban-rpc-url> \
     --network-passphrase "<network-passphrase>"
   ```

4. **OR Migrate to New Contract** (if not upgradeable)

   ```bash
   # Deploy new contract
   NEW_CONTRACT_ID=$(soroban contract deploy \
     --wasm target/wasm32-unknown-unknown/release/onboarding_bridge.wasm \
     --source <admin-secret> \
     --rpc-url <soroban-rpc-url> \
     --network-passphrase "<network-passphrase>")

   # Initialize new contract
   soroban contract invoke \
     --id $NEW_CONTRACT_ID \
     --source <admin-secret> \
     -- initialize \
     --admin <admin-address> \
     --fee_bps 30
   ```

5. **Withdraw Funds from Old Contract** (if migrating)

   ```bash
   # Withdraw accumulated fees
   soroban contract invoke \
     --id <old-contract-id> \
     --source <admin-secret> \
     -- withdraw_fees \
     --to <admin-address> \
     --token <token-address> \
     --amount <total-fees>
   ```

6. **Update API Configuration**

   ```bash
   # Update environment variables
   kubectl set env deployment/bridge-api \
     BRIDGE_CONTRACT_ID=$NEW_CONTRACT_ID

   # Rolling restart
   kubectl rollout restart deployment/bridge-api
   ```

7. **Communicate with Users**
   - Post status update
   - Provide new contract address
   - Explain mitigation steps

8. **Monitor for Issues**
   - Watch contract events
   - Monitor error rates
   - Verify funds are not at risk

**Expected Duration**: 1-4 hours

---

## Automated Testing

### Backup Restoration Testing

**Frequency**: Monthly (automated)

**Script**: `/scripts/dr-test-backup-restore.sh`

```bash
#!/bin/bash
# Automated backup restoration test
# Runs monthly to verify backups are restorable

set -e

echo "Starting backup restoration test..."

# Get latest backup
LATEST_BACKUP=$(aws s3 ls s3://bridge-backups/database/ --recursive | sort -r | head -1 | awk '{print $4}')

echo "Testing backup: $LATEST_BACKUP"

# Create test database
createdb -h test-db-host -U postgres bridge_test_restore

# Restore backup
aws s3 cp s3://bridge-backups/database/$LATEST_BACKUP /tmp/test-restore.dump
pg_restore -h test-db-host -U postgres -d bridge_test_restore /tmp/test-restore.dump

# Verify restoration
ROW_COUNT=$(psql -h test-db-host -U postgres -d bridge_test_restore -t -c "SELECT COUNT(*) FROM transactions;")

echo "Restored $ROW_COUNT transaction records"

# Cleanup
dropdb -h test-db-host -U postgres bridge_test_restore
rm /tmp/test-restore.dump

echo "Backup restoration test completed successfully"

# Send notification
curl -X POST https://api.slack.com/webhooks/... \
  -H 'Content-Type: application/json' \
  -d "{\"text\": \"DR Test: Backup restoration successful. $ROW_COUNT records restored.\"}"
```

### Infrastructure Recreation Test

**Frequency**: Quarterly

**Script**: `/scripts/dr-test-infrastructure-recreation.sh`

```bash
#!/bin/bash
# Test infrastructure recreation from IaC
# Verifies Terraform configuration is complete and functional

set -e

echo "Starting infrastructure recreation test..."

# Create test environment
cd infrastructure
terraform workspace new dr-test || terraform workspace select dr-test

# Plan infrastructure
terraform plan -out=dr-test.plan

# Apply (with approval gate)
echo "Review plan above. Proceed? (yes/no)"
read APPROVAL

if [ "$APPROVAL" = "yes" ]; then
  terraform apply dr-test.plan

  echo "Infrastructure created. Testing endpoints..."

  # Test health endpoint
  sleep 30 # Wait for services to start
  curl -f https://dr-test-api.bridge.example.com/health

  echo "Infrastructure recreation test completed successfully"

  # Cleanup
  echo "Destroying test infrastructure..."
  terraform destroy -auto-approve

  terraform workspace select default
  terraform workspace delete dr-test
else
  echo "Test cancelled"
  exit 1
fi
```

### DR Test Results Log

Test results are logged to `/var/log/dr-tests/` and sent to monitoring dashboard.

**Expected Test Output Format**:

```json
{
  "test_id": "dr-2024-01-15-backup-restore",
  "test_type": "backup_restoration",
  "timestamp": "2024-01-15T10:30:00Z",
  "status": "success",
  "duration_seconds": 245,
  "backup_file": "bridge-backup-2024-01-15-02-00.dump",
  "records_restored": 125000,
  "errors": [],
  "next_scheduled": "2024-02-15T02:00:00Z"
}
```

---

## DR Drill Schedule

### Quarterly Full DR Drills

**Purpose**: Validate complete recovery capability

**Schedule**: Last Saturday of each quarter, 10:00 AM - 2:00 PM UTC

**Drill Scenarios** (rotate each quarter):

1. **Q1**: Regional failover + database restore
2. **Q2**: Complete infrastructure recreation from IaC
3. **Q3**: Multi-component failure (database + API servers)
4. **Q4**: Security incident response + secret rotation

**Participants**:

- Infrastructure Team (required)
- Development Team (required)
- Security Team (required)
- Product Manager (optional)

**Drill Procedure**:

1. **Pre-Drill** (30 minutes)
   - Review runbook
   - Verify access credentials
   - Set up communication channels

2. **Execution** (2 hours)
   - Simulate disaster scenario
   - Execute recovery procedures
   - Document times and issues

3. **Post-Drill** (1 hour)
   - Debrief session
   - Document lessons learned
   - Update runbook with improvements

4. **Follow-up**
   - Create tickets for identified issues
   - Update documentation
   - Schedule next drill

### DR Drill Checklist

- [ ] All participants notified 2 weeks in advance
- [ ] Test environment prepared
- [ ] Backup of production data available
- [ ] Communication channels established (Slack, Zoom)
- [ ] Runbook printed/accessible
- [ ] Monitoring dashboards visible
- [ ] Timers/stopwatches ready
- [ ] Screen recording enabled
- [ ] Note-taker assigned
- [ ] Post-drill survey prepared

---

## Contact Information

### On-Call Rotation

| Role                | Primary     | Secondary      | Phone       |
| ------------------- | ----------- | -------------- | ----------- |
| Infrastructure Lead | John Doe    | Jane Smith     | +1-555-0101 |
| Database Admin      | Bob Johnson | Alice Williams | +1-555-0102 |
| Security Lead       | Carol Brown | David Lee      | +1-555-0103 |
| Engineering Manager | Emily Davis | Frank Wilson   | +1-555-0104 |

### Escalation Path

1. **Level 1**: On-call engineer (respond within 15 minutes)
2. **Level 2**: Team lead (escalate if no resolution in 30 minutes)
3. **Level 3**: Engineering manager (escalate if critical and not resolved in 1 hour)
4. **Level 4**: VP Engineering (escalate if customer-impacting and not resolved in 2 hours)

### Communication Channels

- **Slack**: `#incident-response` (primary)
- **PagerDuty**: Bridge service
- **Status Page**: https://status.bridge.example.com
- **Zoom**: Emergency bridge line (always on)

### External Contacts

| Vendor  | Purpose        | Contact          | Support Portal                         |
| ------- | -------------- | ---------------- | -------------------------------------- |
| AWS     | Infrastructure | AWS Support      | https://console.aws.amazon.com/support |
| Stellar | Soroban RPC    | Discord #soroban | https://stellar.org/developers         |
| DataDog | Monitoring     | Support ticket   | https://help.datadoghq.com             |

---

## Appendix

### Improvement Areas (from past drills)

**Last Updated**: 2024-01-15

| Issue                                  | Impact | Status      | Owner    |
| -------------------------------------- | ------ | ----------- | -------- |
| Backup restore time > target           | Medium | In Progress | DBA team |
| Missing DNS failover automation        | High   | Completed   | DevOps   |
| Secret rotation documentation outdated | Low    | Backlog     | Security |

### Related Documents

- [Infrastructure Runbook](./infrastructure-runbook.md)
- [Security Incident Response Plan](./security-incident-response.md)
- [Monitoring and Alerting Guide](./monitoring-guide.md)
- [Database Administration Guide](./database-admin.md)

---

**Document Review Schedule**: Quarterly  
**Next Review Date**: 2024-04-15  
**Document Owner**: Infrastructure Team Lead
