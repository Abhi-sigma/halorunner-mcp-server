# GitHub Actions → AWS via OIDC.
#
# This is the modern alternative to storing long-lived AWS access keys as
# GitHub secrets. GitHub signs a short-lived JWT for each workflow run,
# AWS STS verifies it against this OIDC provider, and hands back session
# credentials scoped to whichever IAM role the workflow asked to assume.
#
# The trust policy restricts WHO can assume the role:
#   - must be GitHub (the OIDC provider)
#   - must be THIS specific repo
#   - must be from one of the allowed refs (main branch, tags, release
#     workflows, etc.) — prevents a PR from a fork from deploying to prod
#
# Set up once per AWS account. Safe to `terraform import` if an OIDC
# provider already exists (e.g. another project already registered one).

data "tls_certificate" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github.certificates[0].sha1_fingerprint]

  tags = { Name = "github-actions-oidc" }
}

# ---- Trust policy -------------------------------------------------------

data "aws_iam_policy_document" "github_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Restricted to main branch only. Expand this list when you add release
    # tags or a production workflow.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repo}:ref:refs/heads/main",
        "repo:${var.github_repo}:environment:production", # for future prod env
      ]
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  name               = "github-actions-gp-mcp-deploy-${var.env}"
  assume_role_policy = data.aws_iam_policy_document.github_trust.json
  description        = "GitHub Actions OIDC role for deploying gp-mcp-server to ${var.env}"

  tags = { Name = "github-actions-gp-mcp-deploy-${var.env}" }
}

# ---- Permissions --------------------------------------------------------

data "aws_iam_policy_document" "github_deploy" {
  # ECR auth + push to our repo only (not the entire account's ECR).
  statement {
    sid     = "EcrAuth"
    actions = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # GetAuthorizationToken doesn't support resource-level perms
  }

  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.mcp.arn]
  }

  # ECS deploy: register new task defs + update the service.
  statement {
    sid = "EcsDeploy"
    actions = [
      "ecs:RegisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
      "ecs:DescribeServices",
      "ecs:UpdateService",
      "ecs:ListTasks",
      "ecs:DescribeTasks",
    ]
    resources = ["*"] # ecs:RegisterTaskDefinition doesn't support resource-level
  }

  # Pass the task roles when registering a new task definition.
  statement {
    sid     = "PassTaskRoles"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.task.arn,
      aws_iam_role.task_execution.arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy"
  role   = aws_iam_role.github_actions_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}

# tls provider (for the OIDC thumbprint fetch above) is declared in versions.tf.
