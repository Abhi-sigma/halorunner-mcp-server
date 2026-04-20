# ECR repository for the gp-mcp-server container image.
#
# Lifecycle policy: keep the last 20 images, expire older ones. Balances
# "need a rollback target for a few weeks" against "don't pay storage for
# images nobody remembers".

resource "aws_ecr_repository" "mcp" {
  name                 = "gp-mcp-server"
  image_tag_mutability = "MUTABLE" # allows re-tagging :staging → new digest

  image_scanning_configuration {
    scan_on_push = true # surfaces CVEs in the ECR console on every push
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = { Name = "gp-mcp-server" }
}

resource "aws_ecr_lifecycle_policy" "mcp" {
  repository = aws_ecr_repository.mcp.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 20 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      }
    ]
  })
}
