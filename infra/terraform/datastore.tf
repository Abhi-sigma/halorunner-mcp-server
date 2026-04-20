# DynamoDB tables + Secrets Manager secret.
#
# Three DDB tables mirror the three OAuth stores in src/auth/stores.dynamo.ts.
# All PAY_PER_REQUEST billing — traffic is spiky and low; on-demand is
# cheaper than any provisioned capacity that could absorb the bursts.
#
# TTL attribute is `ttl_epoch_s`. DynamoDB deletes expired rows within ~48h;
# application code double-checks the timestamp on read so a soon-to-be-
# deleted item never "comes back to life".

# ---- DCR clients (30-day sliding TTL) -----------------------------------

resource "aws_dynamodb_table" "mcp_clients" {
  name         = "${var.env}-mcp-clients"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "client_id"

  attribute {
    name = "client_id"
    type = "S"
  }

  ttl {
    attribute_name = "ttl_epoch_s"
    enabled        = true
  }

  # No PITR on staging — the 5-min / 60-sec / 30-day TTLs mean nothing here
  # is worth rolling back. Flip on for prod.
  point_in_time_recovery {
    enabled = false
  }

  tags = { Name = "${var.env}-mcp-clients" }
}

# ---- Pending auth state (5-minute TTL) ---------------------------------

resource "aws_dynamodb_table" "mcp_pending_auths" {
  name         = "${var.env}-mcp-pending-auths"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "state"

  attribute {
    name = "state"
    type = "S"
  }

  ttl {
    attribute_name = "ttl_epoch_s"
    enabled        = true
  }

  tags = { Name = "${var.env}-mcp-pending-auths" }
}

# ---- Issued codes (60-sec TTL, single-use) -----------------------------

resource "aws_dynamodb_table" "mcp_codes" {
  name         = "${var.env}-mcp-codes"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "code"

  attribute {
    name = "code"
    type = "S"
  }

  ttl {
    attribute_name = "ttl_epoch_s"
    enabled        = true
  }

  tags = { Name = "${var.env}-mcp-codes" }
}

# ---- Secrets Manager secret --------------------------------------------
#
# The secret is created empty. Populate its JSON value manually once,
# after apply — Terraform doesn't manage the secret content, so secrets
# never land in Terraform state. See README § "Populating the secret".

resource "aws_secretsmanager_secret" "mcp" {
  name        = "gp-mcp/${var.env}/env"
  description = "gp-mcp-server runtime secrets (Cognito client ID, API key)"
  # kms_key_id omitted → uses the AWS-managed aws/secretsmanager key.

  tags = { Name = "gp-mcp-${var.env}-env" }
}

# Stub an initial version so the ARN output points to something readable.
# The real values go in via the AWS console or CLI after apply.
resource "aws_secretsmanager_secret_version" "mcp_placeholder" {
  secret_id     = aws_secretsmanager_secret.mcp.id
  secret_string = jsonencode({ _placeholder = "populate via console or aws cli" })

  lifecycle {
    # Let humans update the secret's value without Terraform wanting to
    # revert it on the next apply.
    ignore_changes = [secret_string]
  }
}
