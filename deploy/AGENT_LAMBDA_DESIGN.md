# Agent Lambda — MAS Loop Design

Distilled from ContainerClaw's multi-agent system into a simple Lambda-compatible serial loop. Each agent is a **persona with tools** that sees all prior work and builds on it.

---

## Core Loop (Single Lambda Invocation)

```python
"""
Lighthouse Investigation Lambda — simplified ContainerClaw pattern.

Key simplifications vs ContainerClaw:
- No election (fixed roster, serial execution)
- No Fluss event log (DynamoDB for progress)
- No persistent containers (Lambda ephemeral /tmp workspace)
- Same tools for all agents (everyone can query, read, write, compute)
- Shared context accumulates in-memory (no external message bus)
"""

import json, os, time, subprocess, tempfile
import boto3

# ─── Config ───────────────────────────────────────────────────────
MAX_TOOL_ROUNDS = 5          # Per agent: max tool call iterations
WORKSPACE = '/tmp/workspace'  # Agent scratch space
AGENTS = [
    {"id": "researcher",  "icon": "🔍", "persona": RESEARCHER_PERSONA},
    {"id": "analyst",     "icon": "📊", "persona": ANALYST_PERSONA},
    {"id": "engineer",    "icon": "🛠️", "persona": ENGINEER_PERSONA},
    {"id": "reviewer",    "icon": "💼", "persona": REVIEWER_PERSONA},
]

# ─── Handler ──────────────────────────────────────────────────────
def handler(event, context):
    task_id = event['taskId']
    task = event['task']
    schema_context = event.get('schemaContext', '')
    wiki_context = event.get('wikiContext', '')
    
    # Initialize workspace
    os.makedirs(WORKSPACE, exist_ok=True)
    
    # Shared context — every agent sees all prior outputs
    shared_log = [
        f"TASK: {task}",
        f"SCHEMA:\n{schema_context}",
    ]
    
    update_progress(task_id, 'running', 'starting')
    
    # ─── Serial Agent Loop ────────────────────────────────────────
    for i, agent_cfg in enumerate(AGENTS):
        agent_id = agent_cfg['id']
        persona = agent_cfg['persona']
        
        update_progress(task_id, 'running', agent_id, step=i+1, total=len(AGENTS))
        
        # Build this agent's context: persona + shared log + tools
        output = run_agent_turn(
            agent_id=agent_id,
            persona=persona,
            shared_log=shared_log,
            task=task,
        )
        
        # Append output to shared log (next agent sees it)
        shared_log.append(f"\n--- [{agent_id.upper()}] ---\n{output['text']}")
        
        # Store any artifacts produced
        if output.get('artifacts'):
            for artifact in output['artifacts']:
                store_artifact(task_id, artifact)
        
        update_progress(task_id, 'running', agent_id, step=i+1, 
                       total=len(AGENTS), status='complete',
                       detail=output['text'][:200])
    
    # ─── Final Result ─────────────────────────────────────────────
    # The reviewer's output IS the final summary
    final_output = shared_log[-1]
    
    update_progress(task_id, 'complete', 'done', result={
        'summary': final_output,
        'shared_log': shared_log,
    })
    
    return {'statusCode': 200, 'summary': final_output}
```

---

## Agent Turn (Tool-Calling Loop)

Each agent gets multiple tool-calling rounds — identical to ContainerClaw's `execute_with_tools`:

```python
def run_agent_turn(agent_id, persona, shared_log, task):
    """Run one agent's full turn with tool calling.
    
    Pattern from ContainerClaw:
      1. Call LLM with persona + context + tools (tool_choice="required" first round)
      2. If LLM returns tool_calls → execute tools → send results back
      3. Repeat until LLM returns text (no more tool calls) or max rounds hit
    """
    
    # Build messages
    system_prompt = build_system_prompt(agent_id, persona, task)
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "\n".join(shared_log)},
    ]
    
    # Tool definitions (same for all agents)
    tools = get_tool_definitions()
    
    accumulated_text = ""
    api_turns = []  # Multi-turn tool calling buffer
    
    for round_num in range(MAX_TOOL_ROUNDS):
        # First round: force tool use. Subsequent: auto (model can choose text or tools)
        tool_choice = "required" if round_num == 0 else "auto"
        
        response = call_llm(
            messages=messages,
            tools=tools,
            tool_choice=tool_choice,
            extra_turns=api_turns,
        )
        
        text = response.get('text', '')
        tool_calls = response.get('tool_calls', [])
        
        if text:
            accumulated_text += text + "\n"
        
        # If no tool calls, agent is done thinking
        if not tool_calls:
            break
        
        # Store assistant message for multi-turn
        api_turns.append({"role": "assistant", "tool_calls": tool_calls, "content": text})
        
        # Execute each tool call
        for call in tool_calls:
            result = execute_tool(agent_id, call['name'], call['args'])
            
            # Append tool result for next LLM round
            api_turns.append({
                "role": "tool",
                "tool_call_id": call['id'],
                "name": call['name'],
                "content": result['output'][:4000],  # Truncate for context
            })
    
    return {
        "text": accumulated_text.strip(),
        "artifacts": collect_workspace_artifacts(),
    }
```

---

## Tools (Same for All Agents)

Every agent gets the same toolbox. They self-select what to use based on their persona:

```python
TOOLS = [
    {
        "name": "query_sql",
        "description": "Execute a SQL query against the data warehouse. Returns rows as JSON.",
        "parameters": {
            "type": "object",
            "properties": {
                "sql": {"type": "string", "description": "The SQL query to execute"},
                "limit": {"type": "integer", "description": "Max rows to return (default 100)"}
            },
            "required": ["sql"]
        }
    },
    {
        "name": "wiki_search",
        "description": "Search documentation wiki for relevant pages. Returns matched snippets.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"}
            },
            "required": ["query"]
        }
    },
    {
        "name": "wiki_read",
        "description": "Read a specific wiki page by ID. Returns full content.",
        "parameters": {
            "type": "object",
            "properties": {
                "page_id": {"type": "string", "description": "Wiki page identifier"}
            },
            "required": ["page_id"]
        }
    },
    {
        "name": "python_exec",
        "description": "Execute Python code in the workspace. Use for data analysis, statistics, chart generation. Has pandas, numpy, matplotlib available. Write output files to /tmp/workspace/artifacts/",
        "parameters": {
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "Python code to execute"},
                "description": {"type": "string", "description": "What this code does (for logging)"}
            },
            "required": ["code"]
        }
    },
    {
        "name": "write_file",
        "description": "Write content to a file in the workspace. Use for saving analysis results, SQL scripts, or reports.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path relative to workspace (e.g., 'artifacts/report.md')"},
                "content": {"type": "string", "description": "File content to write"}
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "read_file",
        "description": "Read a file from the workspace. Use to review artifacts from prior agents.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path relative to workspace"}
            },
            "required": ["path"]
        }
    },
    {
        "name": "shell",
        "description": "Execute a shell command in the workspace. Use for data processing, file manipulation, etc.",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to run"},
                "timeout": {"type": "integer", "description": "Timeout in seconds (default 30)"}
            },
            "required": ["command"]
        }
    }
]
```

---

## Tool Execution

```python
def execute_tool(agent_id, tool_name, args):
    """Execute a tool and return structured result."""
    
    if tool_name == "query_sql":
        return execute_sql(args['sql'], args.get('limit', 100))
    
    elif tool_name == "wiki_search":
        return search_wiki(args['query'])
    
    elif tool_name == "wiki_read":
        return read_wiki_page(args['page_id'])
    
    elif tool_name == "python_exec":
        return execute_python(args['code'])
    
    elif tool_name == "write_file":
        path = os.path.join(WORKSPACE, args['path'])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            f.write(args['content'])
        return {"success": True, "output": f"Written to {args['path']}"}
    
    elif tool_name == "read_file":
        path = os.path.join(WORKSPACE, args['path'])
        if os.path.exists(path):
            content = open(path).read()[:8000]
            return {"success": True, "output": content}
        return {"success": False, "output": f"File not found: {args['path']}"}
    
    elif tool_name == "shell":
        return execute_shell(args['command'], args.get('timeout', 30))
    
    return {"success": False, "output": f"Unknown tool: {tool_name}"}


def execute_python(code):
    """Run Python in a subprocess with pandas/numpy available."""
    script_path = os.path.join(WORKSPACE, '_exec.py')
    with open(script_path, 'w') as f:
        f.write(code)
    
    try:
        result = subprocess.run(
            ['python', script_path],
            capture_output=True, text=True,
            cwd=WORKSPACE, timeout=60
        )
        output = result.stdout + (f"\nSTDERR: {result.stderr}" if result.stderr else "")
        return {
            "success": result.returncode == 0,
            "output": output[:4000]
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "output": "Execution timed out (60s)"}
    except Exception as e:
        return {"success": False, "output": str(e)}


def execute_sql(sql, limit=100):
    """Execute SQL via Redshift Data API."""
    client = boto3.client('redshift-data')
    try:
        resp = client.execute_statement(
            ClusterIdentifier=os.environ['REDSHIFT_CLUSTER'],
            Database=os.environ['REDSHIFT_DATABASE'],
            SecretArn=os.environ['REDSHIFT_SECRET_ARN'],
            Sql=f"{sql} LIMIT {limit}" if 'LIMIT' not in sql.upper() else sql,
        )
        # Poll for completion
        stmt_id = resp['Id']
        while True:
            status = client.describe_statement(Id=stmt_id)
            if status['Status'] in ('FINISHED', 'FAILED', 'ABORTED'):
                break
            time.sleep(0.5)
        
        if status['Status'] == 'FINISHED':
            result = client.get_statement_result(Id=stmt_id)
            columns = [col['name'] for col in result['ColumnMetadata']]
            rows = [[field.get('stringValue', field.get('longValue', '')) 
                     for field in row] for row in result['Records'][:limit]]
            return {
                "success": True,
                "output": json.dumps({"columns": columns, "rows": rows, "row_count": len(rows)})
            }
        else:
            return {"success": False, "output": status.get('Error', 'Query failed')}
    except Exception as e:
        return {"success": False, "output": str(e)}
```

---

## Agent Personas (Context Engineering)

Each agent gets a system prompt that defines their role. The key insight from ContainerClaw: **the persona shapes behavior, not the tools**. Same tools, different thinking.

```python
RESEARCHER_PERSONA = """You are the RESEARCHER in a multi-agent investigation team.

YOUR ROLE: Find relevant documentation, business rules, and context.
YOU GO FIRST: Your findings will be used by the Analyst, Engineer, and Reviewer.

APPROACH:
1. Search the wiki for pages related to the user's question
2. Read relevant pages to extract specific rules, constraints, and definitions
3. Identify which tables/columns are involved and what business logic applies
4. Note any gaps, risks, or known issues from the documentation

OUTPUT: A concise research brief that other agents will build on. Include:
- Relevant business rules and constraints
- Affected tables and their relationships  
- Known issues or gaps from documentation
- Key definitions that inform the analysis

You have access to: wiki_search, wiki_read, query_sql (for schema discovery), 
write_file (save your research brief), python_exec, shell, read_file.

WORKSPACE: /tmp/workspace/ — write any reference files you want other agents to see."""


ANALYST_PERSONA = """You are the DATA ANALYST in a multi-agent investigation team.

YOUR ROLE: Query data, compute statistics, and identify patterns.
YOU GO SECOND: The Researcher has already gathered documentation. Build on it.

APPROACH:
1. Read the Researcher's findings (they're in the shared context above)
2. Write SQL queries based on the schema and business rules identified
3. Execute queries to get real data
4. Use Python for statistical analysis (trends, correlations, outliers)
5. Save charts/visualizations to /tmp/workspace/artifacts/

OUTPUT: Data-driven findings with specific numbers. Include:
- Key metrics and their values
- Trends over time (with direction and magnitude)
- Correlations between variables
- Anomalies or outliers worth investigating
- SQL queries used (so they can be reproduced)

You have access to: query_sql, python_exec, write_file, read_file, 
wiki_search, wiki_read, shell.

WORKSPACE: /tmp/workspace/ — save artifacts (charts, CSVs, SQL scripts)."""


ENGINEER_PERSONA = """You are the ENGINEER in a multi-agent investigation team.

YOUR ROLE: Diagnose root causes and propose technical solutions.
YOU GO THIRD: The Researcher found context, the Analyst found patterns. Synthesize.

APPROACH:
1. Review the Researcher's rules and the Analyst's data findings
2. Identify the root cause (why is the pattern happening?)
3. Propose concrete fixes (SQL, pipeline changes, monitoring)
4. Validate your proposed fix with a query if possible
5. Assess implementation effort and risk

OUTPUT: Technical diagnosis and solution. Include:
- Root cause analysis (tie data patterns to documented gaps/rules)
- Proposed fix (specific, implementable)
- Validation query (proves the fix would work)
- Risk assessment (what could go wrong)
- Implementation SQL or config changes

You have access to: query_sql, python_exec, write_file, read_file, 
wiki_search, wiki_read, shell.

WORKSPACE: /tmp/workspace/ — save fix scripts, validation queries."""


REVIEWER_PERSONA = """You are the BUSINESS REVIEWER in a multi-agent investigation team.

YOUR ROLE: Synthesize all findings into an executive summary.
YOU GO LAST: All other agents have completed their work. Wrap it up.

APPROACH:
1. Read everything above (Researcher + Analyst + Engineer findings)
2. Extract the 3-5 most important findings
3. Frame in business terms (risk, impact, urgency)
4. Provide clear recommendations with priority
5. Format for stakeholder consumption

OUTPUT: Executive summary in markdown. Include:
- Key Findings (bullet points with data)
- Risk Assessment (HIGH/MEDIUM/LOW with justification)
- Recommendations (numbered, prioritized, actionable)
- Data table summarizing key metrics
- Next steps

IMPORTANT: Your output IS the final deliverable. Make it polished, concise, 
and actionable. Use markdown formatting for readability.

You have access to: read_file (review artifacts), write_file (save final report),
query_sql, python_exec, wiki_search, wiki_read, shell.

WORKSPACE: /tmp/workspace/ — read artifacts from prior agents."""
```

---

## DynamoDB Progress Updates

```python
dynamodb = boto3.resource('dynamodb')
tasks_table = dynamodb.Table(os.environ['TASKS_TABLE'])

def update_progress(task_id, status, phase, step=None, total=None, 
                    detail=None, result=None, status_text='complete'):
    """Write progress to DynamoDB for frontend polling."""
    item = {
        'taskId': task_id,
        'status': status,
        'phase': phase,
        'updatedAt': int(time.time() * 1000),
    }
    if step: item['currentStep'] = step
    if total: item['totalSteps'] = total
    if detail: item['detail'] = detail[:500]
    if result: item['result'] = result
    
    tasks_table.put_item(Item=item)
```

---

## Lambda Configuration

```yaml
# Terraform
resource "aws_lambda_function" "agent" {
  function_name = "lighthouse-agent"
  runtime       = "python3.12"
  handler       = "handler.handler"
  timeout       = 900  # 15 minutes
  memory_size   = 1024  # Need memory for pandas/numpy
  
  layers = [
    aws_lambda_layer_version.pandas_layer.arn,  # pandas + numpy
  ]
  
  environment {
    variables = {
      TASKS_TABLE      = aws_dynamodb_table.tasks.name
      REDSHIFT_CLUSTER = var.redshift_cluster_id
      REDSHIFT_DATABASE = var.redshift_database
      REDSHIFT_SECRET_ARN = var.redshift_secret_arn
      LLM_GATEWAY_URL  = var.llm_gateway_url
      LLM_API_KEY_ARN  = var.llm_api_key_secret_arn
      WIKI_BUCKET      = aws_s3_bucket.wiki.id
      ARTIFACTS_BUCKET = aws_s3_bucket.artifacts.id
    }
  }
}
```

---

## Key Differences from ContainerClaw

| Aspect | ContainerClaw | Lighthouse Lambda |
|--------|--------------|-------------------|
| Runtime | Persistent Docker container | Ephemeral Lambda (15 min) |
| Agent coordination | Election → winner executes | Fixed roster, serial |
| Shared context | Fluss append-only log | In-memory list (within Lambda) |
| Progress updates | Fluss → SSE bridge | DynamoDB → polling |
| Workspace | Persistent Docker volume | /tmp (ephemeral, 512MB–10GB) |
| Tool calling | Per-agent tool scoping | Same tools for all |
| Concurrency | Async + event loop | Sequential (simpler) |
| Max duration | Unlimited (container lives) | 15 min (Lambda limit) |

---

## Local Testing (Without AWS)

The same loop runs in the Express backend (Node.js) with mock tools:

```javascript
// backend/agent/orchestrator.js — already implemented
// Just needs: mock_mode: false + real LLM calls

// Tool implementations for local:
// - query_sql → hits the query plugin (static catalog or HTTP proxy)
// - wiki_search/read → hits the wiki plugin (filesystem)
// - python_exec → spawns subprocess (if Python available)
// - write_file/read_file → local /tmp or workspace dir
// - shell → child_process.exec
```

The Lambda version is a Python translation of the same logic, optimized for AWS services (Redshift Data API instead of HTTP proxy, S3 instead of local filesystem).


---

## Self-Continuation Pattern (from EMST ETL Lambda)

Inspired by the fan-out ETL Lambda (`emst_etl_lambda.py`) which self-invokes when time runs low. This allows investigations to exceed the 15-minute Lambda limit by checkpointing state and continuing in a new invocation.

### Core Idea

```python
def handler(event, context):
    task_id = event['taskId']
    
    # Resume from checkpoint if this is a continuation
    checkpoint = load_checkpoint(task_id)  # From DynamoDB or S3
    shared_log = checkpoint.get('shared_log', [])
    agent_index = checkpoint.get('agent_index', 0)
    tool_round = checkpoint.get('tool_round', 0)
    
    # Process remaining agents
    for i in range(agent_index, len(AGENTS)):
        agent = AGENTS[i]
        
        # Check remaining time before each agent turn
        remaining_ms = context.get_remaining_time_in_millis()
        if remaining_ms < 120_000:  # <2 min left — checkpoint and reinvoke
            save_checkpoint(task_id, {
                'shared_log': shared_log,
                'agent_index': i,
                'tool_round': 0,
            })
            reinvoke_self(event, context)
            return  # Exit — continuation picks up from here
        
        output = run_agent_turn(agent, shared_log, task)
        shared_log.append(output)
        update_progress(task_id, agent['id'], output)
    
    # All agents done — finalize
    finalize_investigation(task_id, shared_log)
```

### Checkpoint Storage (S3 — larger payloads)

```python
def save_checkpoint(task_id, state):
    """Persist agent loop state to S3 for continuation."""
    s3.put_object(
        Bucket=os.environ['ARTIFACTS_BUCKET'],
        Key=f'checkpoints/{task_id}.json',
        Body=json.dumps(state),
    )

def load_checkpoint(task_id):
    """Load checkpoint from S3 if this is a continuation invocation."""
    try:
        resp = s3.get_object(
            Bucket=os.environ['ARTIFACTS_BUCKET'],
            Key=f'checkpoints/{task_id}.json',
        )
        return json.loads(resp['Body'].read())
    except s3.exceptions.NoSuchKey:
        return {}  # Fresh start

def reinvoke_self(event, context):
    """Re-invoke this Lambda asynchronously to continue the investigation."""
    lambda_client.invoke(
        FunctionName=os.environ['AWS_LAMBDA_FUNCTION_NAME'],
        InvocationType='Event',  # Async — fire and forget
        Payload=json.dumps(event),
    )
```

### Time Budget Per Agent

Given the 15-minute Lambda limit and 4 agents with up to 5 tool rounds each:

```
Budget per invocation: 15 min (900s)
Buffer: 2 min (120s) for checkpoint + reinvoke
Usable: 13 min (780s)

Per agent (4 agents): ~3 min each
Per tool round (5 rounds): ~36s each
LLM call latency: ~5-15s typical
Tool execution: ~1-30s (SQL can take time)

Worst case: Agent needs 6+ tool rounds → checkpoint mid-agent
Best case: All 4 agents finish in one invocation (~4-8 min total)
```

### Mid-Agent Checkpointing (Advanced)

If a single agent's tool-calling loop is taking too long:

```python
def run_agent_turn(agent, shared_log, task, context, checkpoint=None):
    """Run agent with mid-turn checkpointing."""
    
    api_turns = checkpoint.get('api_turns', []) if checkpoint else []
    accumulated_text = checkpoint.get('accumulated_text', '') if checkpoint else ''
    start_round = checkpoint.get('tool_round', 0) if checkpoint else 0
    
    for round_num in range(start_round, MAX_TOOL_ROUNDS):
        # Time check before each LLM call
        if context.get_remaining_time_in_millis() < 120_000:
            # Save mid-agent state
            save_checkpoint(task_id, {
                'shared_log': shared_log,
                'agent_index': current_agent_index,
                'tool_round': round_num,
                'api_turns': api_turns,
                'accumulated_text': accumulated_text,
            })
            reinvoke_self(event, context)
            return None  # Signal: not done yet
        
        text, tool_calls = call_llm(...)
        # ... rest of tool loop
    
    return {"text": accumulated_text, "artifacts": [...]}
```

### Fan-Out for Parallel Sub-Agents (Future)

Like the ETL Lambda's page-level parallelism, we could fan-out independent agents:

```python
# Instead of serial: researcher → analyst → engineer → reviewer
# Fan-out researcher + analyst in parallel, then engineer + reviewer serial:

def handler(event, context):
    if event.get('event_type') == 'agent-job':
        # This is a sub-agent invocation
        run_single_agent(event['agent_id'], event['task_id'], event['shared_log'])
        return
    
    # Orchestrator: fan out independent agents
    invoke_lambda({'event_type': 'agent-job', 'agent_id': 'researcher', ...})
    invoke_lambda({'event_type': 'agent-job', 'agent_id': 'analyst', ...})
    
    # Then: completion checker waits for both, then invokes engineer
    invoke_lambda({'event_type': 'agent-completion-checker', 
                   'waiting_for': ['researcher', 'analyst'],
                   'next_agents': ['engineer', 'reviewer']})
```

This mirrors the ETL's `stage-N-doc-scheduler → stage-N-doc-job → stage-N-completion-checker → next-stage` pattern.

### DynamoDB Counter (Lambda Pool Management)

From the ETL Lambda — tracks concurrent executions to avoid throttling:

```python
def check_pool_capacity():
    """Check if we can spawn more agent Lambdas without exceeding pool limit."""
    running = get_running_lambda_count(run_id)
    if running >= LAMBDA_POOL_SIZE - LAMBDA_POOL_BUFFER:
        return False  # Pool full — queue instead of invoking
    return True

def increment_pool():
    """Record that we're spawning a new Lambda."""
    # Write to S3 (for increments — fast, no contention)
    total = get_total_increments_from_s3() + 1
    write_total_increments_to_s3(total)

def decrement_pool():
    """Record that a Lambda has finished (DynamoDB for atomic decrements)."""
    dynamodb.put_item(
        TableName=POOL_COUNTER_TABLE,
        Item={
            'run_id': {'S': run_id},
            'sort_key': {'S': f'decrement-{uuid4()}'},
            'change': {'N': '-1'},
        }
    )
```

---

## Summary: ETL Patterns Applied to Agent Lambda

| ETL Pattern | Agent Application |
|-------------|-------------------|
| `check_remaining_time_and_invoke_lambda` | Checkpoint shared_log + agent_index, reinvoke to continue |
| Stage scheduler → job → completion checker | Agent roster: researcher → analyst → engineer → reviewer |
| S3 as intermediate state (stage JSONs) | S3 for checkpoints + artifacts between invocations |
| DynamoDB pool counter | Track concurrent investigations (prevent runaway costs) |
| `InvocationType='Event'` (async) | Fire-and-forget for fan-out agents |
| Retry with `retry_count` | Agent retry on LLM failure (max 3 attempts) |
| Batch processing with start_index | Resume agent roster from checkpoint index |
