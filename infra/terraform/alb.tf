# ALB + target group + HTTPS listener + ACM cert.
#
# Flow:
#   internet → ALB (80 redirect→443, 443 TLS) → target group → Fargate tasks
#
# Target type is `ip` (not `instance`) — required when Fargate uses the
# `awsvpc` network mode because tasks don't have EC2 instance IDs.

# ---- ACM certificate (DNS-validated via Route 53) -----------------------

resource "aws_acm_certificate" "mcp" {
  domain_name       = var.mcp_hostname
  validation_method = "DNS"

  lifecycle {
    # ACM requires the old cert to overlap with the new one during rotation.
    create_before_destroy = true
  }

  tags = { Name = var.mcp_hostname }
}

# Automatic DNS validation — drops the CNAME into Route 53 that ACM asks
# for, then waits for ACM to observe it.
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.mcp.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = data.aws_route53_zone.main.zone_id
}

resource "aws_acm_certificate_validation" "mcp" {
  certificate_arn         = aws_acm_certificate.mcp.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# ---- ALB ----------------------------------------------------------------

resource "aws_lb" "mcp" {
  name               = "${var.env}-gp-mcp-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  # Drop idle connections after 60 s — MCP uses SSE streaming but each
  # message is short-lived. 60 s is the AWS default and a sensible floor.
  idle_timeout = 60

  # Access logs disabled for now — flip on + give a bucket when you want
  # audit logs in S3/Athena. Tier B2 in security-todo.md.
  # access_logs {
  #   bucket  = "gp-mcp-alb-logs-${var.aws_account_id}"
  #   prefix  = var.env
  #   enabled = true
  # }

  tags = { Name = "${var.env}-gp-mcp-alb" }
}

# ---- Target group -------------------------------------------------------

resource "aws_lb_target_group" "mcp" {
  name        = "${var.env}-gp-mcp-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.mcp.id
  target_type = "ip"

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # When a task is deregistered, wait 30 s before killing connections so
  # in-flight requests finish. Default is 300 — too slow for deploys.
  deregistration_delay = 30

  tags = { Name = "${var.env}-gp-mcp-tg" }
}

# ---- Listeners ---------------------------------------------------------

# HTTP → HTTPS redirect.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.mcp.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

# HTTPS listener — the real one.
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.mcp.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06" # TLS 1.2+
  certificate_arn   = aws_acm_certificate_validation.mcp.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.mcp.arn
  }
}
