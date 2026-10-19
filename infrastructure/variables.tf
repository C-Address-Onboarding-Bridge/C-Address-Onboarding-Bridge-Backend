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

variable "db_security_group_id" {
  description = "VPC security group ID for the RDS instance"
  type        = string
}

variable "db_subnet_group_name" {
  description = "DB subnet group name for the RDS instance"
  type        = string
}

variable "redis_auth_token" {
  description = "Auth token for Redis replication group"
  type        = string
  sensitive   = true
}

variable "redis_subnet_group_name" {
  description = "Cache subnet group name for the Redis replication group"
  type        = string
}

variable "redis_security_group_id" {
  description = "VPC security group ID for the Redis replication group"
  type        = string
}

variable "cdn_api_origin_domain" {
  description = "API origin domain for CloudFront CDN"
  type        = string
}

variable "cdn_origin_verify_secret" {
  description = "Origin verification secret for CloudFront CDN"
  type        = string
  sensitive   = true
}
