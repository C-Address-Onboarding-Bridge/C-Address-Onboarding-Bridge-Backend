variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (e.g. dev, staging, production). Used to namespace resource identifiers and prevent state collisions across environments."
  type        = string
  default     = "production"
}

variable "db_username" {
  description = "Database administrator username"
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "Database administrator password"
  type        = string
  sensitive   = true
}

variable "db_instance_class" {
  description = "RDS instance class (e.g. db.t3.micro for dev, db.t3.medium for staging/production)"
  type        = string
  default     = "db.t3.micro"
}

variable "redis_node_type" {
  description = "ElastiCache node type (e.g. cache.t3.micro for dev, cache.t3.small for staging/production)"
  type        = string
  default     = "cache.t3.micro"
}

variable "redis_subnet_group_name" {
  description = "ElastiCache subnet group name for the Redis replication group"
  type        = string
}

variable "redis_security_group_id" {
  description = "VPC security group ID for Redis access"
  type        = string
}

variable "redis_auth_token" {
  description = "Redis AUTH token (transit encryption is enabled). ElastiCache requires 16-128 printable characters, excluding '/', '\"' and '@'."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.redis_auth_token) >= 16 && length(var.redis_auth_token) <= 128
    error_message = "redis_auth_token must be between 16 and 128 characters long."
  }

  validation {
    condition     = can(regex("^[!#-.0-?A-~]+$", var.redis_auth_token))
    error_message = "redis_auth_token may only contain printable ASCII characters other than space, '/', '\"' and '@'."
  }
}

variable "db_security_group_id" {
  description = "VPC security group ID for RDS database access"
  type        = string
}

variable "db_subnet_group_name" {
  description = "DB subnet group name for RDS"
  type        = string
}

variable "cdn_api_origin_domain" {
  description = "API origin domain for CDN distribution"
  type        = string
  sensitive   = true
}

variable "cdn_origin_verify_secret" {
  description = "Shared secret for CDN origin request verification"
  type        = string
  sensitive   = true
}
