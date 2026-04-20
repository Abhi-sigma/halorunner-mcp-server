# Values worth exporting — useful for CI, for documenting the stack, and
# for other Terraform modules that might reference this one later.

output "alb_dns_name" {
  description = "ALB DNS name. CNAME/Alias target for mcp-staging.ygpapp.com."
  value       = aws_lb.mcp.dns_name
}

output "mcp_url" {
  description = "Public URL Claude will hit"
  value       = "https://${var.mcp_hostname}"
}

output "ecr_repo_url" {
  description = "ECR repository URL — used by the GitHub Actions workflow for docker push"
  value       = aws_ecr_repository.mcp.repository_url
}

output "ecs_cluster_name" {
  description = "Cluster name — used by GitHub Actions deploy step"
  value       = aws_ecs_cluster.mcp.name
}

output "ecs_service_name" {
  description = "Service name — used by GitHub Actions deploy step"
  value       = aws_ecs_service.mcp.name
}

output "secrets_manager_secret_arn" {
  description = "ARN of the secret — populate its JSON value via the AWS console or CLI"
  value       = aws_secretsmanager_secret.mcp.arn
}

output "dynamodb_tables" {
  description = "DDB table names for STORE_DRIVER=dynamo"
  value = {
    clients = aws_dynamodb_table.mcp_clients.name
    pending = aws_dynamodb_table.mcp_pending_auths.name
    codes   = aws_dynamodb_table.mcp_codes.name
  }
}

output "github_actions_role_arn" {
  description = "IAM role ARN to paste into .github/workflows/deploy-staging.yml"
  value       = aws_iam_role.github_actions_deploy.arn
}

output "cognito_callback_url_to_add" {
  description = "Add this to the Cognito app client's callback URLs (manual, see README)"
  value       = "https://${var.mcp_hostname}/oauth/callback"
}
