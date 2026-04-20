# VPC, subnets, internet gateway, security groups.
#
# Shape (intentionally minimal):
#   - One VPC, two public subnets in two AZs.
#   - IGW attached. Default route 0.0.0.0/0 → IGW.
#   - No NAT gateway (tasks use their own public IPs for egress).
#   - No private subnets — everything runs public + SG-locked.
#
# Why no private subnets?
#   Private subnets require NAT (AU$50/mo) or VPC endpoints for every AWS
#   service used. For this workload (ALB in front, tasks call public AWS
#   endpoints + Cognito + API Gateway), public subnets with strict SGs give
#   the same security posture for a fraction of the cost. The tasks have
#   public IPs but nothing answers on them — SG blocks all inbound except
#   port 3000 from the ALB SG.

# ---- VPC -----------------------------------------------------------------

resource "aws_vpc" "mcp" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.env}-gp-mcp-vpc"
  }
}

# ---- Public subnets ------------------------------------------------------

resource "aws_subnet" "public" {
  count                   = length(var.public_subnet_cidrs)
  vpc_id                  = aws_vpc.mcp.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.env}-gp-mcp-public-${var.availability_zones[count.index]}"
    Tier = "public"
  }
}

# ---- Internet Gateway + route --------------------------------------------

resource "aws_internet_gateway" "mcp" {
  vpc_id = aws_vpc.mcp.id
  tags   = { Name = "${var.env}-gp-mcp-igw" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.mcp.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.mcp.id
  }

  tags = { Name = "${var.env}-gp-mcp-public-rt" }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ---- DynamoDB gateway endpoint (free, keeps DDB traffic off the IGW) -----
#
# Gateway endpoints for S3 and DynamoDB are free to use. Adding this lets
# Fargate talk to DynamoDB without going through the internet gateway and
# without needing a NAT. Skip it and traffic still works via the IGW —
# this is pure "nice to have".

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.mcp.id
  service_name      = "com.amazonaws.${var.aws_region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id]

  tags = { Name = "${var.env}-gp-mcp-ddb-endpoint" }
}

# ---- Security groups ----------------------------------------------------

# ALB SG: open to the internet on 443.
resource "aws_security_group" "alb" {
  name        = "${var.env}-gp-mcp-alb"
  description = "Internet to ALB on 443/80"
  vpc_id      = aws_vpc.mcp.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS from internet"
  }

  # Redirect-only HTTP:80 → ALB rewrites to HTTPS. Most WAF managed rules
  # assume HTTP listener exists; keeping it here for the redirect listener.
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTP for redirect-to-HTTPS"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Outbound to Fargate tasks + anywhere"
  }

  tags = { Name = "${var.env}-gp-mcp-alb" }
}

# Fargate SG: inbound only from the ALB SG on 3000. Outbound open so the
# app can reach Cognito (JWKS), Secrets Manager, ECR, the API Gateway, and
# DynamoDB (via gateway endpoint).
resource "aws_security_group" "fargate" {
  name        = "${var.env}-gp-mcp-fargate"
  description = "ALB to Fargate on 3000"
  vpc_id      = aws_vpc.mcp.id

  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
    description     = "ALB forwards /mcp traffic"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Cognito JWKS, ECR, Secrets Manager, API Gateway, etc."
  }

  tags = { Name = "${var.env}-gp-mcp-fargate" }
}
