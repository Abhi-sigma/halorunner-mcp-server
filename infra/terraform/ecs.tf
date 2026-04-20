# ECS cluster, Fargate task definition, service, and the two IAM roles
# that Fargate needs.
#
# Two IAM roles (common source of confusion):
#
#   1. Task EXECUTION role
#        Used by the Fargate agent (AWS's infra, not your code) to pull
#        the image from ECR and write container stdout to CloudWatch.
#        Needs ecr:* pull perms + logs:Create/PutLogEvents.
#
#   2. Task role
#        Used by YOUR code running inside the container. This is what
#        AWS SDK calls inside src/auth/stores.dynamo.ts and src/lib/secrets.ts
#        authenticate as. Needs DynamoDB CRUD + Secrets Manager read.
#
# Getting these confused is the #1 gotcha when first doing ECS. Remember:
# execution role = AWS's side, task role = your app's side.

# ---- CloudWatch log group ----------------------------------------------

resource "aws_cloudwatch_log_group" "mcp" {
  name              = "/ecs/${var.env}-gp-mcp"
  retention_in_days = 30
  tags              = { Name = "${var.env}-gp-mcp" }
}

# ---- ECS cluster -------------------------------------------------------

resource "aws_ecs_cluster" "mcp" {
  name = "${var.env}-gp-mcp"

  setting {
    name  = "containerInsights"
    value = "disabled" # ~$3/mo/cluster — flip on when you want metrics
  }

  tags = { Name = "${var.env}-gp-mcp" }
}

# ---- Task execution role (AWS's side) ----------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.env}-gp-mcp-task-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = { Name = "${var.env}-gp-mcp-task-exec" }
}

# AWS-managed policy covering ECR pulls + log stream writes.
resource "aws_iam_role_policy_attachment" "task_execution_basic" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ---- Task role (your app's side) ---------------------------------------

resource "aws_iam_role" "task" {
  name               = "${var.env}-gp-mcp-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = { Name = "${var.env}-gp-mcp-task" }
}

data "aws_iam_policy_document" "task_perms" {
  # DynamoDB CRUD on just our three tables. Least-privilege — no wildcard.
  statement {
    sid = "DynamoDBStores"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    ]
    resources = [
      aws_dynamodb_table.mcp_clients.arn,
      aws_dynamodb_table.mcp_pending_auths.arn,
      aws_dynamodb_table.mcp_codes.arn,
    ]
  }

  # Read the runtime secret. Only the one secret — no wildcard.
  statement {
    sid       = "SecretsManagerRead"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.mcp.arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${var.env}-gp-mcp-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_perms.json
}

# ---- Task definition ---------------------------------------------------
#
# Container image is a placeholder here — GitHub Actions overrides it at
# deploy time via render-task-definition + deploy-task-definition. The
# :latest tag just ensures the initial deploy has something to land on
# (or you can bootstrap with an `aws ecs update-service --force-new-deployment`
# after the first docker push).

resource "aws_ecs_task_definition" "mcp" {
  family                   = "${var.env}-gp-mcp"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.fargate_cpu)
  memory                   = tostring(var.fargate_memory)
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "gp-mcp"
      image     = "${aws_ecr_repository.mcp.repository_url}:latest"
      essential = true

      portMappings = [
        {
          containerPort = 3000
          hostPort      = 3000
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV",                     value = "production" },
        { name = "PORT",                         value = "3000" },
        { name = "LOG_LEVEL",                    value = "info" },
        { name = "API_BASE_URL",                 value = var.upstream_api_base_url },
        { name = "PUBLIC_BASE_URL",              value = "https://${var.mcp_hostname}" },
        { name = "COGNITO_REGION",               value = var.aws_region },
        { name = "COGNITO_USER_POOL_ID",         value = var.cognito_user_pool_id },
        { name = "COGNITO_CLIENT_ID",            value = var.cognito_client_id },
        { name = "COGNITO_HOSTED_UI_DOMAIN",     value = var.cognito_hosted_ui_domain },
        { name = "COGNITO_SCOPES",               value = "openid email phone profile" },
        { name = "CORS_ALLOWED_ORIGINS",         value = var.cors_allowed_origins },
        { name = "STORE_DRIVER",                 value = "dynamo" },
        { name = "DDB_CLIENTS_TABLE",            value = aws_dynamodb_table.mcp_clients.name },
        { name = "DDB_PENDING_TABLE",            value = aws_dynamodb_table.mcp_pending_auths.name },
        { name = "DDB_CODES_TABLE",              value = aws_dynamodb_table.mcp_codes.name },
        { name = "SECRETS_MANAGER_SECRET_ID",    value = aws_secretsmanager_secret.mcp.arn },
      ]

      # ECS integrates logs with CloudWatch via this driver.
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.mcp.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }

      # Docker-level health check — used by ECS to decide if the task is
      # healthy, in addition to the ALB target group's check. Both must
      # pass. Gives faster failure detection on the ECS side.
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
  ])

  tags = { Name = "${var.env}-gp-mcp" }
}

# ---- ECS service -------------------------------------------------------

resource "aws_ecs_service" "mcp" {
  name            = "gp-mcp"
  cluster         = aws_ecs_cluster.mcp.id
  task_definition = aws_ecs_task_definition.mcp.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.fargate.id]
    assign_public_ip = true # required because tasks live in public subnets + no NAT
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.mcp.arn
    container_name   = "gp-mcp"
    container_port   = 3000
  }

  # Rolling deploys with room for overlap — always keep 100% healthy, allow
  # 200% during the flip.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # Auto-rollback if 3 consecutive task starts fail.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Give new tasks 45 s to start responding on /health before the ALB
  # declares them unhealthy. Node boot ~10s + JWKS fetch ~2s + buffer.
  health_check_grace_period_seconds = 45

  # Let the GitHub Actions deploy flow update the task-definition revision
  # without Terraform fighting it on next apply.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.https]

  tags = { Name = "${var.env}-gp-mcp" }
}
