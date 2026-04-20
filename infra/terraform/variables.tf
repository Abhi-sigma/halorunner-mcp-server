# All env-specific knobs live here. Copy staging.tfvars → prod.tfvars when
# adding a second environment.

variable "env" {
  description = "Environment name — used as a prefix for most resources"
  type        = string
  default     = "staging"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-southeast-2"
}

variable "aws_account_id" {
  description = "AWS account ID (for IAM policy conditions + ARN construction)"
  type        = string
  default     = "702767218796"
}

# ---- Networking ----------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR for the MCP VPC. Must not overlap any peered VPC (default VPC is 172.31.0.0/16)."
  type        = string
  default     = "10.10.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Two /24 public subnets across two AZs (ALB needs 2 AZs)"
  type        = list(string)
  default     = ["10.10.1.0/24", "10.10.2.0/24"]
}

variable "availability_zones" {
  description = "AZs for the public subnets — must match length of public_subnet_cidrs"
  type        = list(string)
  default     = ["ap-southeast-2a", "ap-southeast-2b"]
}

# ---- DNS + cert ----------------------------------------------------------

variable "route53_zone_name" {
  description = "Hosted zone (without trailing dot)"
  type        = string
  default     = "ygpapp.com"
}

variable "mcp_hostname" {
  description = "Fully-qualified hostname Claude will hit"
  type        = string
  default     = "mcp-staging.ygpapp.com"
}

# ---- App config (non-secret) --------------------------------------------

variable "upstream_api_base_url" {
  description = "The .NET API Gateway URL the MCP server calls"
  type        = string
  default     = "https://api.staging.ygpapp.com/web"
}

variable "cognito_user_pool_id" {
  description = "Existing Cognito user pool ID"
  type        = string
  default     = "ap-southeast-2_7AEltCLXS"
}

variable "cognito_client_id" {
  description = "Existing Cognito app client ID"
  type        = string
  default     = "7c3delbo3qpf0n5ek1bu37itmc"
}

variable "cognito_hosted_ui_domain" {
  description = "Cognito hosted UI domain"
  type        = string
  default     = "https://ap-southeast-27aeltclxs.auth.ap-southeast-2.amazoncognito.com"
}

variable "cors_allowed_origins" {
  description = "Comma-separated list of origins allowed to hit /mcp"
  type        = string
  default     = "https://claude.ai,https://app.claude.ai"
}

# ---- Fargate sizing ------------------------------------------------------

variable "fargate_cpu" {
  description = "CPU units (256=0.25vCPU, 512=0.5vCPU, 1024=1vCPU)"
  type        = number
  default     = 512
}

variable "fargate_memory" {
  description = "Memory in MB. Valid pairs with cpu — see AWS docs."
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Number of Fargate tasks in the service. 2 = HA across AZs."
  type        = number
  default     = 2
}

# ---- GitHub OIDC --------------------------------------------------------

variable "github_repo" {
  description = "GitHub repo in the form owner/repo — restricts OIDC trust"
  type        = string
  default     = "Abhi-sigma/halorunner-mcp-server"
}
