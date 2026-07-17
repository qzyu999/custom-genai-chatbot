# Deployment Guide

Lighthouse is designed to be deployed anywhere — locally via Docker, on AWS, or self-hosted. The core application (`client/` + `backend/`) is deployment-agnostic. This directory contains reference implementations for specific platforms.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Client (React SPA)                                              │
│   Served from S3 / nginx / any static host                      │
└─────────────┬───────────────────────────────────────────────────┘
              │ HTTPS
┌─────────────▼───────────────────────────────────────────────────┐
│ Backend (Express API)                                            │
│   /api/chat/completions  → LLM gateway proxy                    │
│   /api/agent/investigate → Agent orchestrator                    │
│   /api/wiki, /api/query  → Plugin routes                        │
│   Persistence: MongoDB / DocumentDB / DynamoDB                   │
└──────┬──────────────────────┬───────────────────────────────────┘
       │                      │
┌──────▼──────┐    ┌──────────▼──────────┐
│ LLM Provider│    │ Data Sources         │
│ (any OpenAI │    │ - SQL warehouse      │
│  compatible)│    │ - Wiki (filesystem)  │
│             │    │ - Agent sub-tasks    │
└─────────────┘    └─────────────────────┘
```

## Local Development (Docker)

See `deploy/docker/` — Docker Compose setup with:
- MongoDB (persistence)
- Backend (Express, Node 22)
- Client (Vite dev server or nginx for built assets)
- Mock LLM (optional — for testing without a real provider)

```bash
cd deploy/docker
docker compose up --build
```

## AWS Deployment Plan

See `deploy/aws/` for Terraform modules. Target architecture:

### Components

| Component | AWS Service | Purpose |
|-----------|-------------|---------|
| Frontend SPA | S3 + ALB path routing | Serve React build as static assets |
| Backend API | Lambda + API Gateway | Express via serverless-http |
| Agent Orchestrator | Lambda (15 min timeout) | Investigation loop with sub-agents |
| Chat Persistence | DocumentDB or DynamoDB | Chat history + investigation data |
| Artifact Storage | S3 | Charts, CSVs, analysis outputs |
| Progress Updates | DynamoDB | Polled by frontend for live step status |
| Secrets | Secrets Manager | LLM API keys, DB credentials |
| Data Access | Redshift (via IAM) | SQL queries from agent Lambda |

### Agent Lambda Architecture

The investigation agent runs as a single Lambda invocation (max 15 min):

```
Lambda handler:
  1. Receive task + context
  2. Plan (LLM call → decompose into sub-tasks)
  3. Loop: execute each sub-task
     - SQL queries (boto3 → Redshift Data API)
     - Wiki lookups (read from S3 or API)
     - Analysis (LLM reasoning over results)
     - Write progress to DynamoDB after each step
  4. Synthesize (LLM call → combine results)
  5. Write final result to DynamoDB + artifacts to S3
  6. Return summary
```

Frontend polls `GET /api/agent/status/:taskId` which reads from DynamoDB.

### DynamoDB Schema (Single-Table)

```
PK: CHAT#<chatId>    SK: META           → { userId, model, createdAt }
PK: CHAT#<chatId>    SK: MSG#<index>    → { role, text, timestamp }
PK: CHAT#<chatId>    SK: INV#<index>    → { task, status, steps[], result, artifacts[] }
PK: TASK#<taskId>    SK: STATUS         → { phase, currentStep, startedAt }
PK: TASK#<taskId>    SK: STEP#<i>       → { agent, detail, result, artifact }
```

### Networking

- Lambda in VPC (same as Redshift)
- VPC endpoints for DynamoDB (Gateway), S3 (Gateway), Secrets Manager (Interface)
- API Gateway with VPC endpoint (private)
- ALB with path-based listener rules (standard SPA hosting pattern)

### Deployment Pipeline

```
GitLab CI:
  1. Build React SPA → zip → upload to S3
  2. Package Lambda → zip → upload to S3
  3. Terraform apply (infra updates)
  4. Lambda function update (point to new S3 key)
```

## Configuration Layering

```
config.yaml          → Committed (generic defaults, mock data)
config.local.yaml    → Gitignored (enterprise overrides)
secrets/             → Gitignored (API keys)
```

The application auto-merges `config.local.yaml` over `config.yaml` at startup. This keeps the OS repo clean while allowing enterprise customization without code changes.

## Mock Mode

For local testing without real infrastructure:
- `agent.mock_mode: true` in config.yaml — uses synthetic data
- Mock data in `backend/agent/mock-data.js` — realistic dummy datasets
- No LLM calls needed for investigation flow testing
- MongoDB in-memory fallback when no DB is available
