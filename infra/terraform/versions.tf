# Terraform + provider version pins.
#
# Why pin: unpinned versions mean `terraform init` can pull a provider
# with a breaking change on a Tuesday and your apply fails. A pessimistic
# constraint (~>) allows patch/minor updates but not major.

terraform {
  required_version = "~> 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # State backend — uncomment once you've created the S3 bucket + DynamoDB
  # lock table. Until then state lives locally in terraform.tfstate.
  #
  # backend "s3" {
  #   bucket         = "gp-mcp-tfstate-702767218796"
  #   key            = "staging/terraform.tfstate"
  #   region         = "ap-southeast-2"
  #   dynamodb_table = "gp-mcp-tfstate-lock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "gp-mcp-server"
      Environment = var.env
      ManagedBy   = "terraform"
    }
  }
}
