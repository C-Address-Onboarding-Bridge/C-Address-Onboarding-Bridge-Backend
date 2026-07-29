variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
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

variable "cdn_api_origin_domain" {
  description = "Domain name of the API origin (ALB DNS name or ECS service) fronted by the CDN"
  type        = string
}

variable "cdn_origin_verify_secret" {
  description = "Secret value added as X-Origin-Verify header to block direct origin access"
  type        = string
  sensitive   = true
}

variable "db_security_group_id" {
  description = "Security group ID for the RDS instance (must not use the default VPC security group)"
  type        = string
}

variable "db_subnet_group_name" {
  description = "DB subnet group name for the RDS instance"
  type        = string
}
