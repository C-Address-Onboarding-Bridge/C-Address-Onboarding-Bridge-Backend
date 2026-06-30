variable "project_name" {
  description = "Project name used as a prefix for all resource names"
  type        = string
  default     = "c-address-bridge"
}

variable "environment" {
  description = "Deployment environment (e.g. production, staging)"
  type        = string
  default     = "production"
}

variable "aws_region" {
  description = "AWS region for regional resources (us-east-1 required for ACM certs used by CloudFront)"
  type        = string
  default     = "us-east-1"
}

variable "api_origin_domain" {
  description = "Domain name of the API origin (ALB DNS name or ECS service)"
  type        = string
}

variable "cdn_domain_aliases" {
  description = "Custom domain aliases for the CloudFront distribution (e.g. cdn.c-address-bridge.io)"
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ARN of the ACM certificate for the custom domain aliases (must be in us-east-1)"
  type        = string
  default     = ""
}

variable "cloudfront_price_class" {
  description = "CloudFront price class: PriceClass_All | PriceClass_200 | PriceClass_100"
  type        = string
  default     = "PriceClass_100"
}

variable "origin_verify_secret" {
  description = "Secret value added as X-Origin-Verify header to block direct origin access"
  type        = string
  sensitive   = true
}

variable "cdn_log_bucket" {
  description = "S3 bucket name for CloudFront access logs (leave empty to disable logging)"
  type        = string
  default     = ""
}

variable "alarm_sns_topic_arn" {
  description = "SNS topic ARN for CloudWatch alarm notifications (leave empty to disable)"
  type        = string
  default     = ""
}
