terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "s3" {
    bucket         = "c-address-terraform-state"
    region         = "us-east-1"
    dynamodb_table = "terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region
}

# ECS Cluster
resource "aws_ecs_cluster" "main" {
  name = "c-address-cluster-${var.environment}"
}

# RDS PostgreSQL
resource "aws_db_instance" "postgres" {
  identifier          = "c-address-db-${var.environment}"
  engine              = "postgres"
  instance_class      = var.db_instance_class
  allocated_storage   = 20
  db_name             = "caddress"
  username            = var.db_username
  password            = var.db_password
  skip_final_snapshot = var.environment != "production"
  # Static name: a timestamp() here changed on every plan, so production never
  # showed a clean plan. Rename or delete an old snapshot before reusing it.
  final_snapshot_identifier = var.environment == "production" ? "c-address-db-${var.environment}-final" : null

  deletion_protection = var.environment == "production"

  storage_encrypted       = true
  backup_retention_period = 7
  vpc_security_group_ids  = [var.db_security_group_id]
  db_subnet_group_name    = var.db_subnet_group_name
}

locals {
  # Production runs Redis with automatic failover, which needs a replica.
  redis_failover_enabled = var.environment == "production"
}

# Redis ElastiCache (replication group with encryption)
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "c-address-redis-${var.environment}"
  description                = "c-address Redis cache for ${var.environment}"
  automatic_failover_enabled = local.redis_failover_enabled
  multi_az_enabled           = local.redis_failover_enabled
  # Automatic failover requires at least two cache clusters (primary + replica).
  num_cache_clusters         = local.redis_failover_enabled ? 2 : 1
  auto_minor_version_upgrade = true
  node_type                  = var.redis_node_type
  port                       = 6379
  subnet_group_name          = var.redis_subnet_group_name
  security_group_ids         = [var.redis_security_group_id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = var.redis_auth_token
}

# CloudFront CDN
module "cdn" {
  source               = "./cdn"
  api_origin_domain    = var.cdn_api_origin_domain
  origin_verify_secret = var.cdn_origin_verify_secret
  environment          = var.environment
  aws_region           = var.aws_region
}

# Secrets Manager
resource "aws_secretsmanager_secret" "api_secrets" {
  name = "c-address-api-secrets-${var.environment}"
}
