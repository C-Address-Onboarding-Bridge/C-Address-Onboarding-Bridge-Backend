terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "s3" {
    bucket         = "c-address-terraform-state"
    key            = "global/s3/terraform.tfstate"
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
  name = "c-address-cluster"
}

# RDS PostgreSQL
resource "aws_db_instance" "postgres" {
  identifier           = "c-address-db"
  engine               = "postgres"
  instance_class       = "db.t3.micro"
  allocated_storage    = 20
  db_name              = "caddress"
  username             = var.db_username
  password             = var.db_password
  skip_final_snapshot  = true
}

# Redis ElastiCache
resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "c-address-redis"
  engine               = "redis"
  node_type            = "cache.t3.micro"
  num_cache_nodes      = 1
  port                 = 6379
}

# CloudFront CDN & Load Balancer placeholder
# ...

# Secrets Manager
resource "aws_secretsmanager_secret" "api_secrets" {
  name = "c-address-api-secrets"
}
