# Lighthouse — Pluggable Deployment Architecture

How the open-source Lighthouse core becomes a deployed enterprise application without leaking enterprise details back to the OS repo.

---

## Repository Model

```
┌─────────────────────────────────────────────────────────────┐
│  GitHub (public): qzyu999/Lighthouse                         │
│  The "upstream" — generic, no enterprise details             │
│                                                              │
│  client/          → React SPA (Vite)                         │
│  backend/         → Express API + Agent orchestrator         │
│  deploy/          → Reference deployment configs             │
│  config.yaml      → Generic defaults + mock data             │
└──────────────────────────────┬──────────────────────────────┘
                               │ fork / mirror
┌──────────────────────────────▼──────────────────────────────┐
│  GitLab (private): enterprise/lighthouse                      │
│  The "downstream" — adds enterprise wiring                   │
│                                                              │
│  .amp/            → AMP Terraform (ALB rules, IAM, etc.)     │
│  config.local.yaml → Enterprise LLM endpoints                │
│  secrets/         → API keys (encrypted/vault)               │
│  infra/           → Enterprise-specific Terraform            │
│  content/         → Enterprise wiki, catalog overrides        │
└─────────────────────────────────────────────────────────────┘
```

**Workflow:**
1. Develop features on GitHub (Lighthouse OS repo)
2. Periodically pull upstream into GitLab fork: `git pull upstream main`
3. Enterprise-specific code lives ONLY in GitLab (never pushed upstream)
4. GitLab CI builds and deploys using AMP pipeline patterns

---

## Plugin Interfaces (Already Implemented)

The core is already pluggable via `config.yaml`:

| Plugin | Interface | Implementations |
|--------|-----------|-----------------|
| **LLM Provider** | OpenAI-compatible chat/completions | Any endpoint (OpenAI, Azure, enterprise proxy) |
| **Wiki** | list, get, search, getContext | Filesystem (YAML/HTML), could add S3/Confluence |
| **Query** | getCatalog, execute, validate | Static (YAML), HTTP proxy, could add Redshift direct |
| **Agent** | investigate (orchestrator) | In-process (current), Lambda (planned) |
| **Storage** | Chat CRUD, investigations | MongoDB/DocumentDB (current), DynamoDB (planned) |

To add a new implementation, you write a provider and reference it in config:

```yaml
plugins:
  query:
    provider: "redshift"          # New provider
    cluster_id: "my-cluster"
    database: "analytics"
    secret_arn: "arn:aws:..."
```

---

## AWS Deployment — The Agentic Coordination Problem

The tricky part: how does a React SPA (S3) + Lambda (stateless) coordinate a multi-step investigation that takes 30-60 seconds with live progress updates?

### Solution: Poll-Based Progress via DynamoDB

```
┌─────────┐     ┌──────────┐     ┌─────────────────┐     ┌──────────┐
│ React   │     │ API GW   │     │ Agent Lambda     │     │ DynamoDB │
│ (S3)    │     │ + Lambda │     │ (15 min timeout) │     │          │
└────┬────┘     └────┬─────┘     └───────┬─────────┘     └────┬─────┘
     │               │                   │                     │
     │  POST /investigate               │                     │
     │──────────────►│                   │                     │
     │               │  Invoke async     │                     │
     │               │──────────────────►│                     │
     │               │                   │  Write: status=running
     │    { taskId } │                   │────────────────────►│
     │◄──────────────│                   │                     │
     │               │                   │                     │
     │  GET /status/:taskId              │  Step 1 complete    │
     │──────────────►│───────────────────│────────────────────►│
     │   { step 1 }  │◄─────────────────────────────────────── │
     │◄──────────────│                   │                     │
     │               │                   │  Step 2 complete    │
     │  GET /status/:taskId              │────────────────────►│
     │──────────────►│───────────────────│                     │
     │   { step 2 }  │◄─────────────────────────────────────── │
     │◄──────────────│                   │                     │
     │               │                   │  Write: status=complete
     │  GET /status/:taskId              │────────────────────►│
     │──────────────►│                   │  + result + artifacts
     │  { complete } │◄─────────────────────────────────────── │
     │◄──────────────│                   │                     │
```

### API Design

```
POST /api/agent/investigate
  Body: { task, chatId, context }
  Response: { taskId }  (immediate — fires and forgets to Lambda)

GET /api/agent/status/:taskId
  Response: { 
    status: "running" | "complete" | "failed",
    phase: "planning" | "executing" | "synthesizing",
    steps: [{ type, detail, artifact? }],
    result?: { summary, artifacts }
  }
```

Frontend polls every 1-2 seconds while status is "running".

### Lambda Implementation

```python
# agent_lambda/handler.py

import boto3
import json

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(os.environ['TASKS_TABLE'])

def handler(event, context):
    task_id = event['taskId']
    task = event['task']
    chat_context = event['context']
    
    # Update status: planning
    update_status(task_id, 'running', 'planning')
    
    # Step 1: Plan
    plan = call_llm(PLANNER_PROMPT, task, chat_context)
    update_status(task_id, 'running', 'executing', steps=[
        {'type': 'plan', 'detail': f"{len(plan['subtasks'])} sub-tasks identified"}
    ])
    
    # Step 2: Execute each sub-task
    results = []
    for i, subtask in enumerate(plan['subtasks']):
        update_step(task_id, i, 'executing', subtask['description'])
        
        if subtask['agent'] == 'sql_analyst':
            result = run_sql_agent(subtask, chat_context)
        elif subtask['agent'] == 'researcher':
            result = run_researcher(subtask, chat_context)
        elif subtask['agent'] == 'data_analyst':
            result = run_analyst(subtask, results)
        
        results.append(result)
        update_step(task_id, i, 'complete', subtask['description'], result.get('artifact'))
    
    # Step 3: Synthesize
    update_status(task_id, 'running', 'synthesizing')
    synthesis = call_llm(SYNTHESIZER_PROMPT, task, results)
    
    # Store artifacts in S3
    artifact_urls = store_artifacts(task_id, synthesis.get('artifacts', []))
    
    # Final update
    update_status(task_id, 'complete', 'done', result={
        'summary': synthesis['summary'],
        'artifacts': artifact_urls,
        'duration': elapsed_ms()
    })
    
    return {'statusCode': 200}


def run_sql_agent(subtask, context):
    """Generate SQL and execute against Redshift."""
    # LLM generates the query
    sql = call_llm(SQL_AGENT_PROMPT, subtask['description'], context['schema'])
    
    # Execute via Redshift Data API (async, but we wait)
    client = boto3.client('redshift-data')
    response = client.execute_statement(
        ClusterIdentifier=os.environ['REDSHIFT_CLUSTER'],
        Database=os.environ['REDSHIFT_DATABASE'],
        SecretArn=os.environ['REDSHIFT_SECRET_ARN'],
        Sql=sql
    )
    
    # Poll for completion (Redshift Data API is async)
    statement_id = response['Id']
    while True:
        status = client.describe_statement(Id=statement_id)
        if status['Status'] in ('FINISHED', 'FAILED', 'ABORTED'):
            break
        time.sleep(1)
    
    if status['Status'] == 'FINISHED':
        result = client.get_statement_result(Id=statement_id)
        return format_result(sql, result)
    else:
        return {'error': status.get('Error', 'Query failed')}
```

### DynamoDB Schema for Tasks

```
Table: LighthouseTasks
  PK: taskId (String)
  Attributes:
    chatId: String
    status: String (running|complete|failed)
    phase: String (planning|executing|synthesizing|done)
    steps: List<Map>  (updated in-place as steps complete)
    result: Map (summary, artifacts, duration)
    createdAt: Number (epoch)
    ttl: Number (auto-delete after 24 hours)
```

---

## Terraform Module Structure (Enterprise GitLab Repo)

```
infra/
├── main.tf                 → Module composition
├── variables.tf            → Inputs (VPC, subnets, secrets ARNs)
├── outputs.tf              → ALB DNS, API URL, S3 bucket
│
├── modules/
│   ├── frontend/           → S3 bucket + ALB listener rule for /lighthouse/*
│   │   ├── main.tf
│   │   └── variables.tf
│   │
│   ├── api/                → API Gateway + Lambda (Express backend)
│   │   ├── main.tf         → API GW, VPC endpoint, Lambda
│   │   ├── iam.tf          → Execution role, DynamoDB/Secrets access
│   │   └── variables.tf
│   │
│   ├── agent/              → Agent Lambda (investigation orchestrator)
│   │   ├── main.tf         → Lambda (15 min timeout), IAM, triggers
│   │   ├── iam.tf          → Redshift Data API, DynamoDB, S3, Secrets access
│   │   └── variables.tf
│   │
│   ├── storage/            → DynamoDB tables (Chats + Tasks)
│   │   ├── main.tf
│   │   └── variables.tf
│   │
│   └── artifacts/          → S3 bucket for investigation artifacts
│       ├── main.tf
│       └── variables.tf
│
├── environments/
│   ├── sandbox.tfvars      → Sandbox settings (smaller instances, etc.)
│   └── production.tfvars   → Prod settings
│
└── .amp/
    ├── project_config.json → AMP pipeline configuration
    └── build.yml           → GitLab CI (build SPAs, package Lambdas)
```

---

## CI/CD Pipeline (GitLab)

```yaml
stages:
  - build
  - package
  - deploy

build_frontend:
  stage: build
  script:
    - cd client && npm install && npm run build
    - zip -r lighthouse-ui.zip build/

build_api_lambda:
  stage: build
  script:
    - cd backend && npm install --omit=dev
    - zip -r lighthouse-api.zip .

build_agent_lambda:
  stage: build
  script:
    - cd backend/agent && pip install -r requirements.txt -t .
    - zip -r lighthouse-agent.zip .

package:
  stage: package
  script:
    - aws s3 cp lighthouse-ui.zip s3://$ARTIFACTS_BUCKET/ui/
    - aws s3 cp lighthouse-api.zip s3://$ARTIFACTS_BUCKET/api/
    - aws s3 cp lighthouse-agent.zip s3://$ARTIFACTS_BUCKET/agent/

deploy:
  stage: deploy
  script:
    - cd infra && terraform apply -var-file=environments/$ENV.tfvars -auto-approve
```

---

## Migration Path (Current → Production)

### Phase 1: Current (Done)
- Express backend (local Node process)
- MongoDB with in-memory fallback
- Mock agent (canned data from JSON)
- React SPA served by Vite dev server

### Phase 2: Docker Compose (For team testing)
- MongoDB container
- Backend container
- Client nginx container (built assets)
- Real LLM calls (mock_mode: false)
- Static query plugin (no live DB)

### Phase 3: AWS Sandbox
- S3 + ALB for frontend
- Lambda for API (serverless-http wraps Express)
- DynamoDB for persistence
- Agent Lambda with mock data (validates infra)
- Secrets Manager for LLM key

### Phase 4: AWS Production
- Agent Lambda connected to Redshift (real queries)
- DocumentDB or DynamoDB for chat persistence
- S3 for artifacts (charts, CSVs)
- CloudWatch for monitoring
- EventBridge for scheduled analyses (optional)

---

## Key Design Decisions

1. **Poll, don't push** — Frontend polls DynamoDB for progress. Simpler than WebSockets, works with Lambda/API Gateway, no persistent connections needed.

2. **Single Lambda, internal loop** — The agent orchestrator is one Lambda that runs the full investigation loop (plan → execute → synthesize). Simpler than Step Functions for now. If sub-tasks need parallelism later, refactor to Step Functions.

3. **DynamoDB TTL for tasks** — Investigation progress records auto-delete after 24 hours. Permanent results are stored on the Chat document itself.

4. **Artifacts in S3** — Large outputs (charts, CSVs, notebooks) go to S3 with pre-signed URLs. Small outputs (SQL, insights) are stored inline in DynamoDB.

5. **Config-driven, not code-driven** — Everything configurable via YAML. Enterprise wiring never touches application code. New providers are added by implementing an interface and referencing in config.

6. **Fork workflow** — GitHub upstream stays clean. Enterprise GitLab repo adds infra + config. Periodic `git pull upstream main` brings new features without merge conflicts (enterprise code lives in separate directories).
