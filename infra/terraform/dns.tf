# Route 53 — look up the existing hosted zone and point mcp-staging at the
# ALB. Uses an A-record alias (not a CNAME) because aliases are free and
# resolve faster (no extra DNS hop).

data "aws_route53_zone" "main" {
  name         = "${var.route53_zone_name}."
  private_zone = false
}

resource "aws_route53_record" "mcp" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.mcp_hostname
  type    = "A"

  alias {
    name                   = aws_lb.mcp.dns_name
    zone_id                = aws_lb.mcp.zone_id
    evaluate_target_health = true
  }
}
