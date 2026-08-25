variable "project_name" {
  description = "Project name used as a prefix for all resource names"
  type        = string
  default     = "c-address-bridge"
}

variable "environment" {
  description = "Deployment environment (e.g. production, staging)"
  type        =rtificate for the custom domain aliases (must be in us-east-1)"
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
