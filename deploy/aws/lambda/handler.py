"""
Lighthouse Agent Lambda — Single Lambda, Multi-Role Handler

Routes to scheduler or agent execution based on event_type.
Both roles use self-reinvocation for time continuity.

Event types:
  - "schedule": Orchestrate the agent roster (serial MAS loop)
  - "agent_turn": Execute one agent's tool-calling loop
  - "finalize": Compile final result from shared conversation

The shared conversation lives in S3 and accumulates agent outputs.
DynamoDB tracks progress for frontend polling.
"""

import json
import os
import time
import uuid
import subprocess
import tempfile

import boto3

# ─── AWS Clients ─────────────────────────────────────────────────
s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
lambda_client = boto3.client('lambda')
secrets_client = boto3.client('secretsmanager')

# ─── Environment ─────────────────────────────────────────────────
FUNCTION_NAME = os.environ.get('AWS_LAMBDA_FUNCTION_NAME', 'lighthouse-agent')
BUCKET = os.environ.get('ARTIFACTS_BUCKET', 'lighthouse-artifacts')
TASKS_TABLE = os.environ.get('TASKS_TABLE', 'LighthouseTasks')
LLM_GATEWAY_URL = os.environ.get('LLM_GATEWAY_URL', '')
LLM_API_KEY_ARN = os.environ.get('LLM_API_KEY_ARN', '')
REDSHIFT_CLUSTER = os.environ.get('REDSHIFT_CLUSTER', '')
REDSHIFT_DATABASE = os.environ.get('REDSHIFT_DATABASE', '')
REDSHIFT_SECRET_ARN = os.environ.get('REDSHIFT_SECRET_ARN', '')
WORKSPACE = '/tmp/workspace'

# Time buffer before reinvocation (2 minutes)
REINVOKE_BUFFER_MS = 120_000
MAX_TOOL_ROUNDS = 5

# ─── Agent Roster ────────────────────────────────────────────────
AGENTS = [
    {
        "id": "researcher",
        "icon": "🔍",
        "name": "Researcher",
        "persona": """You are the RESEARCHER in a multi-agent investigation team.
YOUR ROLE: Find relevant documentation, business rules, and context.
YOU GO FIRST: Your findings will be used by the Analyst, Engineer, and Reviewer.

APPROACH:
1. Search the wiki for pages related to the user's question
2. Read relevant pages to extract specific rules, constraints, definitions
3. Identify which tables/columns are involved and what business logic applies
4. Note any gaps, risks, or known issues from the documentation

OUTPUT: A concise research brief. Include:
- Relevant business rules and constraints
- Affected tables and their relationships
- Known issues or gaps from documentation
- Key definitions that inform the analysis

WORKSPACE: /tmp/workspace/ — write reference files for other agents to see."""
    },
    {
        "id": "analyst",
        "icon": "📊",
        "name": "Data Analyst",
        "persona": """You are the DATA ANALYST in a multi-agent investigation team.
YOUR ROLE: Query data, compute statistics, and identify patterns.
YOU GO SECOND: The Researcher has already gathered documentation. Build on it.

APPROACH:
1. Read the Researcher's findings in the shared conversation above
2. Write SQL queries based on the schema and business rules identified
3. Execute queries to get real data
4. Use Python for statistical analysis (trends, correlations, outliers)
5. Save charts/visualizations to /tmp/workspace/artifacts/

OUTPUT: Data-driven findings with specific numbers. Include:
- Key metrics and their values
- Trends over time (with direction and magnitude)
- Correlations between variables
- Anomalies or outliers
- SQL queries used (so they can be reproduced)

WORKSPACE: /tmp/workspace/ — save artifacts (charts, CSVs, SQL scripts)."""
    },
    {
        "id": "engineer",
        "icon": "🛠️",
        "name": "Engineer",
        "persona": """You are the ENGINEER in a multi-agent investigation team.
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
- Risk assessment
- Implementation SQL or config changes

WORKSPACE: /tmp/workspace/ — save fix scripts, validation queries."""
    },
    {
        "id": "reviewer",
        "icon": "💼",
        "name": "Business Reviewer",
        "persona": """You are the BUSINESS REVIEWER in a multi-agent investigation team.
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

IMPORTANT: Your output IS the final deliverable. Make it polished and actionable.

WORKSPACE: /tmp/workspace/ — read artifacts from prior agents."""
    },
]

# ─── Tool Definitions (same for all agents) ──────────────────────
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "query_sql",
            "description": "Execute a SQL query against the data warehouse (Redshift). Returns columns and rows as JSON.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {"type": "string", "description": "The SQL query to execute"},
                    "limit": {"type": "integer", "description": "Max rows (default 100)"}
                },
                "required": ["sql"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "wiki_search",
            "description": "Search the documentation wiki. Returns page IDs and snippets.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"}
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "wiki_read",
            "description": "Read a wiki page by ID. Returns full content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string", "description": "Wiki page identifier"}
                },
                "required": ["page_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "python_exec",
            "description": "Execute Python code. Has pandas, numpy, matplotlib. Write outputs to /tmp/workspace/artifacts/",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python code to execute"},
                    "description": {"type": "string", "description": "What this code does"}
                },
                "required": ["code"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file in the workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path relative to workspace"},
                    "content": {"type": "string", "description": "File content"}
                },
                "required": ["path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file from the workspace (written by prior agents).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path relative to workspace"}
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "shell",
            "description": "Execute a shell command in the workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command"},
                    "timeout": {"type": "integer", "description": "Timeout seconds (default 30)"}
                },
                "required": ["command"]
            }
        }
    },
]


# ═══════════════════════════════════════════════════════════════════
# HANDLER — Single entry point, routes by event_type
# ═══════════════════════════════════════════════════════════════════

def handler(event, context):
    """Main Lambda handler — routes to scheduler or agent turn."""
    event_type = event.get('event_type', 'schedule')
    task_id = event.get('task_id')

    print(f"🚀 [{event_type}] task_id={task_id}")

    if event_type == 'schedule':
        return schedule(event, context)
    elif event_type == 'agent_turn':
        return agent_turn(event, context)
    elif event_type == 'finalize':
        return finalize(event, context)
    else:
        print(f"❌ Unknown event_type: {event_type}")
        return {'statusCode': 400, 'error': f'Unknown event_type: {event_type}'}


# ═══════════════════════════════════════════════════════════════════
# SCHEDULER — Manages serial agent roster with self-continuation
# ═══════════════════════════════════════════════════════════════════

def schedule(event, context):
    """Orchestrate the MAS roster. Invokes agents serially, reinvokes self if time low."""
    task_id = event['task_id']
    task = event.get('task', '')
    schema_context = event.get('schema_context', '')

    # Load or initialize checkpoint
    checkpoint = load_checkpoint(task_id, 'scheduler')
    agent_index = checkpoint.get('agent_index', 0)

    # Initialize shared conversation on first run
    if agent_index == 0 and not checkpoint:
        shared_convo = [
            f"# Investigation Task\n\n{task}",
            f"# Available Schema\n\n{schema_context}" if schema_context else "",
        ]
        save_shared_conversation(task_id, shared_convo)
        update_progress(task_id, 'running', 'starting', detail='Investigation started')

    # Process agents serially
    for i in range(agent_index, len(AGENTS)):
        agent = AGENTS[i]

        # ⏱️ Time check — reinvoke if running low
        remaining_ms = context.get_remaining_time_in_millis()
        if remaining_ms < REINVOKE_BUFFER_MS:
            print(f"⏱️ Time low ({remaining_ms}ms). Checkpointing at agent {i} and reinvoking.")
            save_checkpoint(task_id, 'scheduler', {'agent_index': i})
            reinvoke(event, context)
            return {'statusCode': 202, 'message': 'Continued in next invocation'}

        # Update progress: this agent is starting
        update_progress(task_id, 'running', agent['id'],
                       step=i + 1, total=len(AGENTS),
                       detail=f"{agent['icon']} {agent['name']} working...")

        # Invoke agent turn (synchronous — same Lambda, different code path)
        agent_event = {
            'event_type': 'agent_turn',
            'task_id': task_id,
            'task': task,
            'agent_index': i,
        }
        agent_turn(agent_event, context)

        # Update progress: agent complete
        update_progress(task_id, 'running', agent['id'],
                       step=i + 1, total=len(AGENTS),
                       detail=f"{agent['icon']} {agent['name']} complete")

    # All agents done — finalize
    save_checkpoint(task_id, 'scheduler', {'agent_index': len(AGENTS), 'done': True})
    finalize({'task_id': task_id, 'event_type': 'finalize'}, context)

    return {'statusCode': 200, 'message': 'Investigation complete'}


# ═══════════════════════════════════════════════════════════════════
# AGENT TURN — One agent's tool-calling loop with self-continuation
# ═══════════════════════════════════════════════════════════════════

def agent_turn(event, context):
    """Execute one agent's full turn. Self-reinvokes if time runs low mid-loop."""
    task_id = event['task_id']
    task = event.get('task', '')
    agent_index = event['agent_index']
    agent = AGENTS[agent_index]

    # Load checkpoint (for mid-turn continuation)
    checkpoint = load_checkpoint(task_id, f'agent_{agent["id"]}')
    api_turns = checkpoint.get('api_turns', [])
    accumulated_text = checkpoint.get('accumulated_text', '')
    start_round = checkpoint.get('tool_round', 0)

    # Load shared conversation
    shared_convo = load_shared_conversation(task_id)

    # Initialize workspace
    os.makedirs(WORKSPACE, exist_ok=True)
    os.makedirs(os.path.join(WORKSPACE, 'artifacts'), exist_ok=True)

    # Restore workspace files from S3 (prior agents' artifacts)
    restore_workspace(task_id)

    # Build messages for LLM
    system_prompt = agent['persona']
    user_content = "\n\n".join(shared_convo)

    # ─── Tool-calling loop ────────────────────────────────────────
    for round_num in range(start_round, MAX_TOOL_ROUNDS):
        # ⏱️ Time check
        remaining_ms = context.get_remaining_time_in_millis()
        if remaining_ms < REINVOKE_BUFFER_MS:
            print(f"⏱️ [{agent['id']}] Time low at round {round_num}. Checkpointing.")
            save_workspace(task_id)
            save_checkpoint(task_id, f'agent_{agent["id"]}', {
                'tool_round': round_num,
                'api_turns': api_turns,
                'accumulated_text': accumulated_text,
            })
            # Reinvoke the scheduler (which will re-enter this agent)
            reinvoke({
                'event_type': 'agent_turn',
                'task_id': task_id,
                'task': task,
                'agent_index': agent_index,
            }, context)
            return

        # Call LLM
        tool_choice = "required" if round_num == 0 and not api_turns else "auto"
        response = call_llm(system_prompt, user_content, api_turns, tool_choice)

        text = response.get('text', '')
        tool_calls = response.get('tool_calls', [])

        if text:
            accumulated_text += text + "\n"

        # No tool calls → agent is done
        if not tool_calls:
            break

        # Store assistant message for multi-turn
        api_turns.append({
            "role": "assistant",
            "content": text,
            "tool_calls": [
                {"id": tc['id'], "type": "function",
                 "function": {"name": tc['name'], "arguments": json.dumps(tc['args'])}}
                for tc in tool_calls
            ]
        })

        # Execute tools
        for call in tool_calls:
            print(f"  🔧 [{agent['id']}] {call['name']}({json.dumps(call['args'])[:100]})")
            result = execute_tool(call['name'], call['args'])
            print(f"  → {'✅' if result['success'] else '❌'} {result['output'][:100]}")

            api_turns.append({
                "role": "tool",
                "tool_call_id": call['id'],
                "name": call['name'],
                "content": result['output'][:4000],
            })

    # ─── Agent done — append output to shared conversation ────────
    agent_output = f"\n--- [{agent['id'].upper()} | {agent['icon']} {agent['name']}] ---\n{accumulated_text.strip()}"
    shared_convo.append(agent_output)
    save_shared_conversation(task_id, shared_convo)

    # Save workspace artifacts to S3
    save_workspace(task_id)

    # Clear agent checkpoint (done)
    clear_checkpoint(task_id, f'agent_{agent["id"]}')

    print(f"✅ [{agent['id']}] Turn complete ({len(accumulated_text)} chars)")


# ═══════════════════════════════════════════════════════════════════
# FINALIZE — Compile result from shared conversation
# ═══════════════════════════════════════════════════════════════════

def finalize(event, context):
    """Mark investigation complete. The reviewer's output is the final summary."""
    task_id = event['task_id']
    shared_convo = load_shared_conversation(task_id)

    # The last entry is the reviewer's output
    summary = shared_convo[-1] if shared_convo else "No results produced."

    # Collect artifact URLs from S3
    artifacts = list_artifacts(task_id)

    update_progress(task_id, 'complete', 'done', result={
        'summary': summary,
        'artifacts': artifacts,
        'shared_log': shared_convo,
    })

    # Cleanup checkpoint
    clear_checkpoint(task_id, 'scheduler')

    print(f"✅ Investigation {task_id} finalized.")


# ═══════════════════════════════════════════════════════════════════
# TOOL EXECUTION
# ═══════════════════════════════════════════════════════════════════

def execute_tool(name, args):
    """Route tool call to implementation."""
    try:
        if name == 'query_sql':
            return tool_query_sql(args)
        elif name == 'wiki_search':
            return tool_wiki_search(args)
        elif name == 'wiki_read':
            return tool_wiki_read(args)
        elif name == 'python_exec':
            return tool_python_exec(args)
        elif name == 'write_file':
            return tool_write_file(args)
        elif name == 'read_file':
            return tool_read_file(args)
        elif name == 'shell':
            return tool_shell(args)
        else:
            return {'success': False, 'output': f'Unknown tool: {name}'}
    except Exception as e:
        return {'success': False, 'output': f'Tool error: {str(e)}'}


def tool_query_sql(args):
    """Execute SQL via Redshift Data API."""
    sql = args['sql']
    limit = args.get('limit', 100)

    if not REDSHIFT_CLUSTER:
        return {'success': False, 'output': 'Redshift not configured'}

    client = boto3.client('redshift-data')
    resp = client.execute_statement(
        ClusterIdentifier=REDSHIFT_CLUSTER,
        Database=REDSHIFT_DATABASE,
        SecretArn=REDSHIFT_SECRET_ARN,
        Sql=sql if 'LIMIT' in sql.upper() else f"{sql} LIMIT {limit}",
    )

    stmt_id = resp['Id']
    while True:
        status = client.describe_statement(Id=stmt_id)
        if status['Status'] in ('FINISHED', 'FAILED', 'ABORTED'):
            break
        time.sleep(1)

    if status['Status'] == 'FINISHED':
        result = client.get_statement_result(Id=stmt_id)
        columns = [col['name'] for col in result['ColumnMetadata']]
        rows = []
        for record in result['Records'][:limit]:
            row = []
            for field in record:
                val = field.get('stringValue', field.get('longValue', field.get('doubleValue', '')))
                row.append(str(val) if val is not None else 'NULL')
            rows.append(row)

        output = json.dumps({'columns': columns, 'rows': rows, 'count': len(rows)})
        return {'success': True, 'output': output}
    else:
        return {'success': False, 'output': f"Query failed: {status.get('Error', 'Unknown')}"}


def tool_wiki_search(args):
    """Search wiki content in S3."""
    query = args['query'].lower()
    wiki_prefix = f"wiki/"

    try:
        resp = s3.list_objects_v2(Bucket=BUCKET, Prefix=wiki_prefix)
        matches = []
        for obj in resp.get('Contents', [])[:20]:
            key = obj['Key']
            page_id = key.replace(wiki_prefix, '').replace('.json', '')
            # Simple keyword match on filename
            if any(word in page_id.lower() for word in query.split()):
                matches.append({'id': page_id, 'relevance': 'keyword_match'})
        return {'success': True, 'output': json.dumps(matches[:5])}
    except Exception as e:
        return {'success': False, 'output': str(e)}


def tool_wiki_read(args):
    """Read a wiki page from S3."""
    page_id = args['page_id']
    try:
        resp = s3.get_object(Bucket=BUCKET, Key=f"wiki/{page_id}.json")
        content = json.loads(resp['Body'].read())
        return {'success': True, 'output': json.dumps(content)[:8000]}
    except Exception as e:
        return {'success': False, 'output': f"Page not found: {page_id} ({e})"}


def tool_python_exec(args):
    """Execute Python in subprocess."""
    code = args['code']
    script_path = os.path.join(WORKSPACE, '_exec.py')

    with open(script_path, 'w') as f:
        f.write(code)

    try:
        result = subprocess.run(
            ['python3', script_path],
            capture_output=True, text=True,
            cwd=WORKSPACE, timeout=60,
        )
        output = result.stdout
        if result.stderr:
            output += f"\nSTDERR: {result.stderr}"
        return {'success': result.returncode == 0, 'output': output[:4000]}
    except subprocess.TimeoutExpired:
        return {'success': False, 'output': 'Timeout (60s)'}
    except Exception as e:
        return {'success': False, 'output': str(e)}


def tool_write_file(args):
    """Write file to workspace."""
    path = os.path.join(WORKSPACE, args['path'])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(args['content'])
    return {'success': True, 'output': f"Written: {args['path']}"}


def tool_read_file(args):
    """Read file from workspace."""
    path = os.path.join(WORKSPACE, args['path'])
    if os.path.exists(path):
        with open(path, 'r') as f:
            return {'success': True, 'output': f.read()[:8000]}
    return {'success': False, 'output': f"Not found: {args['path']}"}


def tool_shell(args):
    """Execute shell command."""
    timeout = args.get('timeout', 30)
    try:
        result = subprocess.run(
            args['command'], shell=True,
            capture_output=True, text=True,
            cwd=WORKSPACE, timeout=timeout,
        )
        output = result.stdout + (f"\nSTDERR: {result.stderr}" if result.stderr else "")
        return {'success': result.returncode == 0, 'output': output[:4000]}
    except subprocess.TimeoutExpired:
        return {'success': False, 'output': f'Timeout ({timeout}s)'}
    except Exception as e:
        return {'success': False, 'output': str(e)}


# ═══════════════════════════════════════════════════════════════════
# LLM CLIENT
# ═══════════════════════════════════════════════════════════════════

def call_llm(system_prompt, user_content, api_turns, tool_choice="auto"):
    """Call the LLM gateway. Returns {text, tool_calls}."""
    import urllib.request

    # Get API key from Secrets Manager (cached in Lambda warm start)
    api_key = get_secret(LLM_API_KEY_ARN) if LLM_API_KEY_ARN else ''

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]
    messages.extend(api_turns)

    payload = {
        "model": os.environ.get('LLM_MODEL', 'gpt-4.1'),
        "messages": messages,
        "tools": TOOLS,
        "tool_choice": tool_choice,
        "stream": False,
    }

    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {api_key}',
    }

    req = urllib.request.Request(
        LLM_GATEWAY_URL,
        data=json.dumps(payload).encode(),
        headers=headers,
        method='POST',
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())

        message = data.get('choices', [{}])[0].get('message', {})
        text = message.get('content', '')
        raw_tool_calls = message.get('tool_calls', [])

        tool_calls = []
        for tc in raw_tool_calls:
            fn = tc.get('function', {})
            try:
                args = json.loads(fn.get('arguments', '{}'))
            except (json.JSONDecodeError, TypeError):
                args = {}
            tool_calls.append({
                'id': tc.get('id', str(uuid.uuid4())),
                'name': fn.get('name', ''),
                'args': args,
            })

        return {'text': text, 'tool_calls': tool_calls}

    except Exception as e:
        print(f"❌ LLM call failed: {e}")
        return {'text': f'[LLM Error: {e}]', 'tool_calls': []}


# ═══════════════════════════════════════════════════════════════════
# STATE MANAGEMENT (S3 + DynamoDB)
# ═══════════════════════════════════════════════════════════════════

def save_shared_conversation(task_id, convo):
    """Persist shared conversation to S3."""
    s3.put_object(
        Bucket=BUCKET,
        Key=f'investigations/{task_id}/conversation.json',
        Body=json.dumps(convo),
    )


def load_shared_conversation(task_id):
    """Load shared conversation from S3."""
    try:
        resp = s3.get_object(Bucket=BUCKET, Key=f'investigations/{task_id}/conversation.json')
        return json.loads(resp['Body'].read())
    except:
        return []


def save_checkpoint(task_id, role, state):
    """Save checkpoint for self-continuation."""
    s3.put_object(
        Bucket=BUCKET,
        Key=f'investigations/{task_id}/checkpoints/{role}.json',
        Body=json.dumps(state, default=str),
    )


def load_checkpoint(task_id, role):
    """Load checkpoint for resumption."""
    try:
        resp = s3.get_object(Bucket=BUCKET, Key=f'investigations/{task_id}/checkpoints/{role}.json')
        return json.loads(resp['Body'].read())
    except:
        return {}


def clear_checkpoint(task_id, role):
    """Remove checkpoint after completion."""
    try:
        s3.delete_object(Bucket=BUCKET, Key=f'investigations/{task_id}/checkpoints/{role}.json')
    except:
        pass


def save_workspace(task_id):
    """Upload workspace artifacts to S3."""
    artifacts_dir = os.path.join(WORKSPACE, 'artifacts')
    if not os.path.exists(artifacts_dir):
        return
    for fname in os.listdir(artifacts_dir):
        fpath = os.path.join(artifacts_dir, fname)
        if os.path.isfile(fpath):
            s3.upload_file(fpath, BUCKET, f'investigations/{task_id}/artifacts/{fname}')


def restore_workspace(task_id):
    """Download workspace artifacts from S3 (from prior agents)."""
    prefix = f'investigations/{task_id}/artifacts/'
    try:
        resp = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix)
        artifacts_dir = os.path.join(WORKSPACE, 'artifacts')
        os.makedirs(artifacts_dir, exist_ok=True)
        for obj in resp.get('Contents', []):
            key = obj['Key']
            fname = key.split('/')[-1]
            s3.download_file(BUCKET, key, os.path.join(artifacts_dir, fname))
    except:
        pass


def list_artifacts(task_id):
    """List artifact URLs for the investigation."""
    prefix = f'investigations/{task_id}/artifacts/'
    try:
        resp = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix)
        artifacts = []
        for obj in resp.get('Contents', []):
            key = obj['Key']
            fname = key.split('/')[-1]
            # Generate pre-signed URL (1 hour expiry)
            url = s3.generate_presigned_url('get_object',
                Params={'Bucket': BUCKET, 'Key': key}, ExpiresIn=3600)
            artifacts.append({'name': fname, 'url': url, 'key': key})
        return artifacts
    except:
        return []


def reinvoke(event, context):
    """Re-invoke this Lambda asynchronously to continue."""
    lambda_client.invoke(
        FunctionName=FUNCTION_NAME,
        InvocationType='Event',
        Payload=json.dumps(event),
    )
    print(f"🔄 Reinvoked self for task {event.get('task_id')}")


def update_progress(task_id, status, phase, step=None, total=None, detail=None, result=None):
    """Write progress to DynamoDB for frontend polling."""
    table = dynamodb.Table(TASKS_TABLE)
    item = {
        'taskId': task_id,
        'status': status,
        'phase': phase,
        'updatedAt': int(time.time() * 1000),
    }
    if step is not None:
        item['currentStep'] = step
    if total is not None:
        item['totalSteps'] = total
    if detail:
        item['detail'] = detail[:500]
    if result:
        item['result'] = json.dumps(result)[:50000]  # DynamoDB 400KB item limit

    table.put_item(Item=item)


# ─── Secrets cache ────────────────────────────────────────────────
_secrets_cache = {}

def get_secret(arn):
    """Get secret value with Lambda-warm caching."""
    if arn in _secrets_cache:
        return _secrets_cache[arn]
    resp = secrets_client.get_secret_value(SecretId=arn)
    val = resp['SecretString']
    _secrets_cache[arn] = val
    return val
