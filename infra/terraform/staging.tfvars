# Values for the staging workspace. Pass with:
#   terraform apply -var-file=staging.tfvars
#
# Everything here already matches the defaults in variables.tf — kept in a
# .tfvars file so you can diff staging vs prod later at a glance.

env                = "staging"
aws_region         = "ap-southeast-2"
aws_account_id     = "702767218796"

vpc_cidr            = "10.10.0.0/16"
public_subnet_cidrs = ["10.10.1.0/24", "10.10.2.0/24"]
availability_zones  = ["ap-southeast-2a", "ap-southeast-2b"]

route53_zone_name = "ygpapp.com"
mcp_hostname      = "mcp-staging.ygpapp.com"

upstream_api_base_url    = "https://api.staging.ygpapp.com/web"
cognito_user_pool_id     = "ap-southeast-2_7AEltCLXS"
cognito_client_id        = "7c3delbo3qpf0n5ek1bu37itmc"
cognito_hosted_ui_domain = "https://ap-southeast-27aeltclxs.auth.ap-southeast-2.amazoncognito.com"
cors_allowed_origins     = "https://claude.ai,https://app.claude.ai"

fargate_cpu    = 512
fargate_memory = 1024
desired_count  = 2

github_repo = "Abhi-sigma/halorunner-mcp-server"
