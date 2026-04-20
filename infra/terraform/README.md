# gp-mcp-server — Terraform (staging)

Provisions everything the server needs to run on AWS: VPC, ALB, Fargate, DynamoDB, Secrets Manager, WAF, ECR, IAM, DNS.

---

## File tour

Each `.tf` file is a single topic so you can read them in any order.

| File | Resource group |
|---|---|
| [versions.tf](versions.tf) | Terraform + provider version pins, default tags, S3 backend placeholder |
| [variables.tf](variables.tf) | Every knob the stack takes (with defaults) |
| [staging.tfvars](staging.tfvars) | Staging-specific values. Copy → `production.tfvars` to add a second env |
| [outputs.tf](outputs.tf) | Values Terraform spits out — ECR URI, ALB DNS, secret ARN, GitHub OIDC role |
| [network.tf](network.tf) | VPC, public subnets, IGW, DDB gateway endpoint, two security groups |
| [ecr.tf](ecr.tf) | Container image repository with scan-on-push + 20-image retention |
| [datastore.tf](datastore.tf) | 3 DynamoDB tables (TTL-enabled) + Secrets Manager secret (empty at create) |
| [alb.tf](alb.tf) | ALB, HTTP→HTTPS redirect, HTTPS listener, ACM cert (DNS validated) |
| [dns.tf](dns.tf) | Route 53 A-record alias to the ALB |
| [ecs.tf](ecs.tf) | ECS cluster, task def, service, task role + execution role, log group |
| [waf.tf](waf.tf) | WAF v2 web ACL with managed OWASP + rate limit + body-size rules |
| [iam_github_oidc.tf](iam_github_oidc.tf) | GitHub Actions OIDC provider + deploy role |

---

## First-time apply

### 0. Prereqs

- Terraform 1.10+
- AWS credentials: `aws-vault exec app-dashboard -- <your command>`
- Route 53 hosted zone `ygpapp.com` already exists (it does — account `702767218796`)

### 1. Plan

```bash
cd infra/terraform

aws-vault exec app-dashboard -- terraform init
aws-vault exec app-dashboard -- terraform plan -var-file=staging.tfvars
```

Review carefully. Expected resource count: **~35 resources** — VPC bits, two SGs, ALB + 2 listeners, ACM + 2 validation records, target group, 3 DDB tables, 1 secret + version, ECR repo + lifecycle policy, ECS cluster + task def + service + 2 IAM roles + 2 policy attachments, log group, WAF ACL + association, Route 53 record, OIDC provider + role + policy.

### 2. Apply

```bash
aws-vault exec app-dashboard -- terraform apply -var-file=staging.tfvars
```

Takes ~3 minutes (the ACM DNS validation wait is the slow step).

### 3. Populate the Secrets Manager secret

Terraform creates the secret but intentionally doesn't write its contents (secret values should never live in TF state). Populate once:

```bash
aws-vault exec app-dashboard -- aws secretsmanager put-secret-value \
  --secret-id gp-mcp/staging/env \
  --secret-string '{
    "COGNITO_CLIENT_ID":"7c3delbo3qpf0n5ek1bu37itmc",
    "COGNITO_USER_POOL_ID":"ap-southeast-2_7AEltCLXS",
    "COGNITO_HOSTED_UI_DOMAIN":"https://ap-southeast-27aeltclxs.auth.ap-southeast-2.amazoncognito.com",
    "API_KEY":""
  }'
```

Adjust to include any API key or future secrets.

### 4. Update Cognito callback URL

Add `https://mcp-staging.ygpapp.com/oauth/callback` to the existing app client — Terraform doesn't manage Cognito here because the client is shared with other apps.

```bash
aws-vault exec app-dashboard -- aws cognito-idp update-user-pool-client \
  --region ap-southeast-2 \
  --user-pool-id ap-southeast-2_7AEltCLXS \
  --client-id 7c3delbo3qpf0n5ek1bu37itmc \
  --callback-urls \
    http://localhost:3000 \
    http://localhost:3000/oauth/callback \
    http://localhost:3001 \
    https://dashboard.ygpapp.com \
    https://gilbert-practice-character-open.trycloudflare.com/oauth/callback \
    https://messaging.ygpapp.com \
    https://planning.ygpapp.com \
    https://staging.messaging.ygpapp.com \
    https://staging.payments.ygpapp.com \
    https://staging.planning.ygpapp.com \
    https://mcp-staging.ygpapp.com/oauth/callback
```

(Keep the existing URLs — this command replaces the full list.)

### 5. Wire the GitHub Actions workflow

Terraform output `github_actions_role_arn` gives you the role. Replace the placeholder in [../../.github/workflows/deploy-staging.yml](../../.github/workflows/deploy-staging.yml):

```yaml
role-to-assume: arn:aws:iam::<ACCOUNT_ID>:role/github-actions-gp-mcp-deploy-staging
```

→ becomes the value from `terraform output github_actions_role_arn`.

### 6. First deploy

The ECS service starts with `desired_count=2` but no valid image yet. Push the first image through GitHub Actions:

```bash
git push  # triggers .github/workflows/deploy-staging.yml
```

Or manually for the first time:

```bash
aws-vault exec app-dashboard -- aws ecr get-login-password --region ap-southeast-2 \
  | docker login --username AWS --password-stdin 702767218796.dkr.ecr.ap-southeast-2.amazonaws.com
docker build -t gp-mcp-server:first .
docker tag gp-mcp-server:first 702767218796.dkr.ecr.ap-southeast-2.amazonaws.com/gp-mcp-server:latest
docker push 702767218796.dkr.ecr.ap-southeast-2.amazonaws.com/gp-mcp-server:latest

aws-vault exec app-dashboard -- aws ecs update-service \
  --cluster staging-gp-mcp --service gp-mcp --force-new-deployment
```

### 7. Verify

```bash
curl https://mcp-staging.ygpapp.com/health
# → {"status":"ok","ts":"..."}

curl https://mcp-staging.ygpapp.com/.well-known/oauth-authorization-server | jq .
# → OAuth metadata JSON
```

Connect Claude Desktop / claude.ai to `https://mcp-staging.ygpapp.com/mcp`.

---

## Rollback

### Roll back the app only

```bash
aws-vault exec app-dashboard -- aws ecs update-service \
  --cluster staging-gp-mcp --service gp-mcp \
  --task-definition <previous-task-def-arn>
```

Or redeploy a previous image SHA via the GitHub Actions workflow input.

### Tear down the infra entirely

```bash
aws-vault exec app-dashboard -- terraform destroy -var-file=staging.tfvars
```

Takes ~5 min. DynamoDB tables with PITR disabled (staging default) delete immediately. The Secrets Manager secret goes into a 7-30 day recovery window by default — Terraform schedules deletion but AWS holds the name. To force-delete:

```bash
aws-vault exec app-dashboard -- aws secretsmanager delete-secret \
  --secret-id gp-mcp/staging/env --force-delete-without-recovery
```

---

## Learning notes

A few Terraform patterns worth picking up from this stack:

### 1. `lifecycle` blocks for ignored drift

[ecs.tf](ecs.tf) — the ECS service has:

```hcl
lifecycle {
  ignore_changes = [task_definition, desired_count]
}
```

Why: the GitHub Actions deploy pipeline updates `task_definition` with the new image SHA on every push. Without `ignore_changes`, Terraform would revert the deployment to whatever image was in state on the next `terraform apply`. This is the canonical "Terraform vs CI/CD split ownership" pattern.

Same idea in [datastore.tf](datastore.tf) on `aws_secretsmanager_secret_version` — keeps humans/scripts in charge of the secret's actual value.

### 2. `create_before_destroy` for zero-downtime swaps

[alb.tf](alb.tf) — the ACM cert uses `create_before_destroy = true`. If a cert attribute changes (e.g. subject alternative names), Terraform would normally destroy-then-create, which breaks the HTTPS listener for the duration. `create_before_destroy` inverts the order — new cert is created and validated, listener flipped, old cert removed.

### 3. Separate trust policy from permissions

[iam_github_oidc.tf](iam_github_oidc.tf) — every IAM role has two policy documents:

- **Trust policy** (`assume_role_policy`): *who* can assume this role. Restricted by OIDC claims (repo + branch).
- **Permission policy** (`iam_role_policy`): *what* the assumed role can do.

These are independent concerns. The trust policy's `StringLike` on `token.actions.githubusercontent.com:sub` is what prevents a fork's PR from being able to deploy — it restricts assumption to commits from main branch of the canonical repo.

### 4. Why `target_type = "ip"` on the target group

[alb.tf](alb.tf) — Fargate tasks don't have EC2 instance IDs because they're not EC2. The ALB target group must target IPs directly. This is Fargate's fundamental constraint: no `instance` targets, no classic/legacy load balancer types.

### 5. `count` vs `for_each`

[network.tf](network.tf) uses `count = length(var.public_subnet_cidrs)` for subnets — indexed by position. [alb.tf](alb.tf) uses `for_each` for ACM validation records — keyed by domain name. Rule of thumb:

- **count**: when the list is fixed-length and order doesn't matter if you swap values.
- **for_each**: when items have natural stable keys (like domain names) — avoids index shifts breaking state when you insert/remove.

### 6. Data sources are read-only lookups

[dns.tf](dns.tf) uses `data "aws_route53_zone" "main"` — this reads the existing hosted zone without managing it. You'd use a `resource "aws_route53_zone"` if you owned the zone in this Terraform, but it already exists and is shared, so a data source is correct.

---

## Extending to production later

When you're ready to add prod:

1. Copy [staging.tfvars](staging.tfvars) → `production.tfvars`.
2. Change `env = "production"`, `vpc_cidr = "10.20.0.0/16"` (disjoint), `mcp_hostname = "mcp.ygpapp.com"`, `upstream_api_base_url` to the prod .NET API URL.
3. Create a separate Terraform workspace or directory so state doesn't collide:
   ```bash
   terraform workspace new production
   terraform apply -var-file=production.tfvars
   ```
4. Flip `point_in_time_recovery.enabled = true` on the DDB tables for prod. Either add a `var.enable_pitr` or duplicate the tables with different lifecycle in a prod-only file.
5. In [iam_github_oidc.tf](iam_github_oidc.tf), the trust policy already allows `environment:production` — make sure the GitHub environment exists with approvers configured.

---

## Cost — expected monthly bill

| | Monthly |
|---|---|
| Fargate (2 × 0.5 vCPU × 1 GB) | ~AU$35 |
| ALB | ~AU$25 |
| WAF | ~AU$15 |
| DynamoDB on-demand | <AU$5 |
| Secrets Manager | AU$1 |
| CloudWatch logs (30 d retention, 1 GB/mo) | AU$2 |
| Route 53 + ACM | AU$2 |
| **Total** | **~AU$85** |

Zero NAT, zero VPC endpoints beyond the free DDB gateway endpoint.
