# WAF v2 Web ACL attached to the ALB.
#
# Rules run in priority order, first match wins:
#   1. AWS managed OWASP baseline (starts in Count mode — flip to Block
#      after a week of clean traffic)
#   2. AWS managed "known bad inputs" (block immediately — very low FP)
#   3. Rate limit on /oauth/* (belt-and-braces on the in-process limiter)
#   4. Body size cap at 1 MB (matches express.json limit, edge-enforced)
#
# Cost: ~AU$15/mo (1 ACL + 4 rules + request inspection at low volume).

resource "aws_wafv2_web_acl" "mcp" {
  name        = "${var.env}-gp-mcp"
  description = "WAF protection for gp-mcp-server ALB"
  scope       = "REGIONAL" # REGIONAL for ALB / API Gateway; CLOUDFRONT is a separate scope

  default_action {
    allow {}
  }

  # ---- Rule 1: AWS common rule set (OWASP top-10) ----------------------

  rule {
    name     = "aws-common-rules"
    priority = 1

    # Starts in Count mode — flip `override_action.count` to `override_action.none`
    # to enable blocking after you've reviewed CloudWatch metrics for a week.
    override_action {
      count {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-common-rules"
      sampled_requests_enabled   = true
    }
  }

  # ---- Rule 2: known bad inputs (Log4Shell etc.) -----------------------

  rule {
    name     = "aws-known-bad-inputs"
    priority = 2

    override_action {
      none {} # enabled in Block mode — these are very high-precision rules
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "aws-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  # ---- Rule 3: rate limit /oauth/* ------------------------------------
  #
  # WAF's minimum rate window is 1 minute. Allow up to 100 requests per
  # 5-minute window to a URI starting with /oauth/ per source IP. That's
  # ~20/min, well above any legitimate client (which registers once + a
  # few auth round-trips), well below a flood.

  rule {
    name     = "rate-limit-oauth"
    priority = 3

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 100
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            field_to_match {
              uri_path {}
            }
            positional_constraint = "STARTS_WITH"
            search_string         = "/oauth/"

            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit-oauth"
      sampled_requests_enabled   = true
    }
  }

  # ---- Rule 4: body size cap ------------------------------------------

  rule {
    name     = "body-size-cap"
    priority = 4

    action {
      block {}
    }

    statement {
      size_constraint_statement {
        field_to_match {
          body {}
        }
        comparison_operator = "GT"
        size                = 1048576 # 1 MB

        text_transformation {
          priority = 0
          type     = "NONE"
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "body-size-cap"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.env}-gp-mcp"
    sampled_requests_enabled   = true
  }

  tags = { Name = "${var.env}-gp-mcp" }
}

# Attach the Web ACL to the ALB.
resource "aws_wafv2_web_acl_association" "mcp" {
  resource_arn = aws_lb.mcp.arn
  web_acl_arn  = aws_wafv2_web_acl.mcp.arn
}
