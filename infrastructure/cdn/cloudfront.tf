##############################################################################
# CloudFront CDN — C-Address Bridge
# Issue #109: CDN distribution for static API docs, SDK packages, and
#             optional edge caching of dynamic API responses.
##############################################################################

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ─── S3 bucket for static assets (docs + SDK browser builds) ─────────────────

resource "aws_s3_bucket" "cdn_assets" {
  bucket = "${var.project_name}-cdn-assets-${var.environment}"

  tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
    Purpose     = "CDN static assets — API docs and SDK packages"
  }
}

resource "aws_s3_bucket_versioning" "cdn_assets" {
  bucket = aws_s3_bucket.cdn_assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "cdn_assets" {
  bucket                  = aws_s3_bucket.cdn_assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cdn_assets" {
  bucket = aws_s3_bucket.cdn_assets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ─── Origin Access Control (modern OAC, replaces OAI) ────────────────────────

resource "aws_cloudfront_origin_access_control" "cdn_assets" {
  name                              = "${var.project_name}-oac-${var.environment}"
  description                       = "OAC for C-Address Bridge CDN assets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ─── S3 bucket policy — allow only CloudFront ────────────────────────────────

data "aws_iam_policy_document" "cdn_assets_policy" {
  statement {
    sid    = "AllowCloudFrontServicePrincipal"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.cdn_assets.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "cdn_assets" {
  bucket = aws_s3_bucket.cdn_assets.id
  policy = data.aws_iam_policy_document.cdn_assets_policy.json
  # Depends on public access block being applied first
  depends_on = [aws_s3_bucket_public_access_block.cdn_assets]
}

# ─── CloudFront Cache Policies ────────────────────────────────────────────────

# Long-lived cache for static assets with content hash in path/filename
resource "aws_cloudfront_cache_policy" "static_assets" {
  name        = "${var.project_name}-static-assets-${var.environment}"
  comment     = "1-year cache for content-hashed static files"
  default_ttl = 31536000   # 1 year
  min_ttl     = 31536000
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

# Short TTL for dynamic API responses (quote, status endpoints)
resource "aws_cloudfront_cache_policy" "api_dynamic" {
  name        = "${var.project_name}-api-dynamic-${var.environment}"
  comment     = "Short cache for dynamic API responses (quote, status)"
  default_ttl = 30
  min_ttl     = 0
  max_ttl     = 60

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "whitelist"
      headers {
        items = ["Accept", "Authorization"]
      }
    }
    query_strings_config {
      query_string_behavior = "all"
    }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

# No cache for write endpoints (fund, offramp, cex)
resource "aws_cloudfront_cache_policy" "api_no_cache" {
  name        = "${var.project_name}-api-no-cache-${var.environment}"
  comment     = "No caching for write/mutating API endpoints"
  default_ttl = 0
  min_ttl     = 0
  max_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "all"
    }
  }
}

# ─── Origin Request Policy for API ──────────────────────────────────────────

resource "aws_cloudfront_origin_request_policy" "api" {
  name    = "${var.project_name}-api-origin-request-${var.environment}"
  comment = "Forward required headers to API origin"

  cookies_config {
    cookie_behavior = "none"
  }
  headers_config {
    header_behavior = "whitelist"
    headers {
      items = [
        "Accept",
        "Accept-Language",
        "Authorization",
        "Content-Type",
        "X-Api-Key",
        "X-Correlation-Id",
        "X-Forwarded-For",
        "Origin"
      ]
    }
  }
  query_strings_config {
    query_string_behavior = "all"
  }
}

# ─── Response Headers Policy (security headers) ───────────────────────────────

resource "aws_cloudfront_response_headers_policy" "security" {
  name    = "${var.project_name}-security-headers-${var.environment}"
  comment = "Security and CORS headers for C-Address Bridge"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    xss_protection {
      mode_block = true
      protection = true
      override   = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    content_security_policy {
      content_security_policy = "default-src 'none'; script-src 'none'; frame-ancestors 'none';"
      override                = true
    }
  }

  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "public, max-age=31536000, immutable"
      override = false
    }
    items {
      header   = "X-Cache-Version"
      value    = "1"
      override = false
    }
  }
}

# ─── WAF ACL (optional — attach if WAF module deployed) ─────────────────────

# Uncomment and reference your WAF module output:
# data "aws_wafv2_web_acl" "main" {
#   name  = "${var.project_name}-waf-${var.environment}"
#   scope = "CLOUDFRONT"
# }

# ─── CloudFront Distribution ────────────────────────────────────────────────

resource "aws_cloudfront_distribution" "main" {
  comment             = "C-Address Bridge CDN — ${var.environment}"
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  price_class         = var.cloudfront_price_class
  aliases             = var.cdn_domain_aliases
  default_root_object = "index.html"

  # ── Static assets origin (S3) ──────────────────────────────────────
  origin {
    domain_name              = aws_s3_bucket.cdn_assets.bucket_regional_domain_name
    origin_id                = "s3-static-assets"
    origin_access_control_id = aws_cloudfront_origin_access_control.cdn_assets.id
  }

  # ── API origin (ALB / ECS) ─────────────────────────────────────────
  origin {
    domain_name = var.api_origin_domain
    origin_id   = "api-origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]

      origin_keepalive_timeout = 60
      origin_read_timeout      = 30
    }

    custom_header {
      name  = "X-Origin-Verify"
      value = var.origin_verify_secret
    }
  }

  # ── Default behaviour: serve static assets from S3 ────────────────
  default_cache_behavior {
    target_origin_id         = "s3-static-assets"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = aws_cloudfront_cache_policy.static_assets.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
    compress                 = true
  }

  # ── API docs (OpenAPI + Postman) — long cache ──────────────────────
  ordered_cache_behavior {
    path_pattern             = "/docs/*"
    target_origin_id         = "s3-static-assets"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = aws_cloudfront_cache_policy.static_assets.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
    compress                 = true
  }

  # ── SDK browser builds — long cache ───────────────────────────────
  ordered_cache_behavior {
    path_pattern             = "/sdk/*"
    target_origin_id         = "s3-static-assets"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = aws_cloudfront_cache_policy.static_assets.id
    compress                 = true
  }

  # ── Quote / status endpoints — short cache ────────────────────────
  ordered_cache_behavior {
    path_pattern               = "/api/*/quote"
    target_origin_id           = "api-origin"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = aws_cloudfront_cache_policy.api_dynamic.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.api.id
    compress                   = true
  }

  ordered_cache_behavior {
    path_pattern               = "/api/*/status/*"
    target_origin_id           = "api-origin"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = aws_cloudfront_cache_policy.api_dynamic.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.api.id
    compress                   = true
  }

  # ── Health check — no cache ───────────────────────────────────────
  ordered_cache_behavior {
    path_pattern               = "/health"
    target_origin_id           = "api-origin"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = aws_cloudfront_cache_policy.api_no_cache.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.api.id
    compress                   = false
  }

  # ── All other API routes — no cache (write endpoints) ─────────────
  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "api-origin"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = aws_cloudfront_cache_policy.api_no_cache.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.api.id
    compress                   = true
  }

  # ── TLS certificate ───────────────────────────────────────────────
  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  # ── Geo restrictions ──────────────────────────────────────────────
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # ── Access logging ────────────────────────────────────────────────
  dynamic "logging_config" {
    for_each = var.cdn_log_bucket != "" ? [1] : []
    content {
      bucket          = "${var.cdn_log_bucket}.s3.amazonaws.com"
      prefix          = "cloudfront/${var.environment}/"
      include_cookies = false
    }
  }

  # ── WAF (uncomment if deploying WAF) ─────────────────────────────
  # web_acl_id = data.aws_wafv2_web_acl.main.arn

  tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ─── CloudFront monitoring & alarms ──────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "cdn_error_rate" {
  alarm_name          = "${var.project_name}-cdn-error-rate-${var.environment}"
  alarm_description   = "CDN 5xx error rate above 1%"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "5xxErrorRate"
  namespace           = "AWS/CloudFront"
  period              = 300
  statistic           = "Average"
  threshold           = 1.0
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.main.id
    Region         = "Global"
  }

  alarm_actions = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []
  ok_actions    = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []
}

resource "aws_cloudwatch_metric_alarm" "cdn_cache_hit_rate" {
  alarm_name          = "${var.project_name}-cdn-cache-hit-${var.environment}"
  alarm_description   = "CDN cache hit rate below 70% for static assets"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CacheHitRate"
  namespace           = "AWS/CloudFront"
  period              = 300
  statistic           = "Average"
  threshold           = 70.0
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.main.id
    Region         = "Global"
  }

  alarm_actions = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []
}

resource "aws_cloudwatch_metric_alarm" "cdn_origin_latency" {
  alarm_name          = "${var.project_name}-cdn-origin-latency-${var.environment}"
  alarm_description   = "CDN origin latency p99 above 2s"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "OriginLatency"
  namespace           = "AWS/CloudFront"
  period              = 300
  extended_statistic  = "p99"
  threshold           = 2000   # milliseconds
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.main.id
    Region         = "Global"
  }

  alarm_actions = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []
}

# ─── Outputs ─────────────────────────────────────────────────────────────────

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = aws_cloudfront_distribution.main.id
}

output "cloudfront_domain_name" {
  description = "CloudFront distribution domain name"
  value       = aws_cloudfront_distribution.main.domain_name
}

output "cdn_assets_bucket_name" {
  description = "S3 bucket for CDN static assets"
  value       = aws_s3_bucket.cdn_assets.bucket
}

output "cdn_assets_bucket_arn" {
  description = "S3 bucket ARN for CDN static assets"
  value       = aws_s3_bucket.cdn_assets.arn
}
