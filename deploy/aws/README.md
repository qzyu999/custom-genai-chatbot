# AWS Deployment (Terraform)

Reference Terraform modules for deploying Lighthouse on AWS.

## Status: Planned

This directory will contain:

```
aws/
├── lambda/           → Lambda handler wrappers
│   ├── api/          → Express backend via serverless-http
│   └── agent/        → Investigation orchestrator Lambda
├── infra/            → Core infrastructure
│   ├── dynamodb.tf   → Chat + investigation persistence
│   ├── s3.tf         → Artifact storage + SPA hosting
│   ├── api-gw.tf     → Private API Gateway
│   ├── lambda.tf     → Lambda functions + layers
│   ├── iam.tf        → Roles and policies
│   └── vpc.tf        → VPC endpoints (DynamoDB, S3, Secrets Manager)
├── variables.tf      → Input variables
├── outputs.tf        → Exported values
└── README.md         → This file
```

## Prerequisites

- AWS account with VPC and private subnets
- Terraform >= 1.5
- S3 bucket for Terraform state
- Secrets Manager secret for LLM API key

## Usage

```hcl
module "lighthouse" {
  source = "./deploy/aws/infra"

  app_name    = "lighthouse"
  environment = "sandbox"
  vpc_id      = "vpc-xxxxx"
  subnet_ids  = ["subnet-aaa", "subnet-bbb"]
  
  # LLM provider
  llm_secret_arn = "arn:aws:secretsmanager:us-gov-west-1:xxx:secret:lighthouse-llm-key"
  
  # Optional: Redshift for SQL agent
  redshift_cluster_id = "my-cluster"
  redshift_database   = "analytics"
}
```

## Architecture Notes

- Frontend: React SPA built and synced to S3, served via ALB path routing (`/lighthouse/*`)
- Backend API: Express wrapped in `serverless-http`, deployed as Lambda behind API Gateway
- Agent: Separate Lambda with 15-min timeout for investigation orchestration
- Persistence: DynamoDB single-table design (chats, messages, investigations)
- Artifacts: S3 bucket with pre-signed URL generation for downloads
- Progress: Agent writes steps to DynamoDB; frontend polls for updates
