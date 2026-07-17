/**
 * Investigation Planner
 * 
 * Uses the orchestrator LLM to:
 *   1. Break a complex task into sub-tasks
 *   2. Assign each sub-task to a sub-agent type
 *   3. Synthesize results from all sub-agents into a final response
 */

const PLANNER_SYSTEM_PROMPT = `You are an investigation planner for a datalake analytics system.
Given a user's analysis request, break it into concrete sub-tasks.

Available sub-agents:
- sql_analyst: Runs SQL queries against the datalake (Redshift). Use for data retrieval, aggregation, filtering.
- data_analyst: Runs Python/pandas analysis on data. Use for statistical analysis, trend detection, correlation.
- researcher: Looks up documentation and wiki pages. Use for context, business rules, definitions.

Respond with a JSON object:
{
  "reasoning": "Brief explanation of your plan",
  "subtasks": [
    {
      "agent": "sql_analyst|data_analyst|researcher",
      "description": "What this sub-task should accomplish",
      "inputs": { ... any specific parameters like sql_hint, query_topic, wiki_page ... }
    }
  ]
}

Rules:
- Keep subtasks to 3-6 max (focus on what's essential)
- Order matters: data retrieval before analysis
- sql_analyst should come before data_analyst (need data to analyze)
- researcher can run in parallel conceptually but we execute sequentially for now
- Be specific in descriptions so the sub-agent knows exactly what to do`;

const SYNTHESIZER_SYSTEM_PROMPT = `You are a senior data analyst synthesizing results from multiple sub-investigations.
Given the original task and results from sub-agents, produce a clear, actionable summary.

Format your response as JSON:
{
  "summary": "Markdown-formatted summary with key findings, tables, and recommendations",
  "artifacts": [
    {
      "type": "table|chart_data|sql|insight",
      "title": "Descriptive title",
      "content": "The artifact content (markdown table, SQL query, data, or text)"
    }
  ]
}

Rules:
- Summary should be concise but complete (aim for 200-400 words)
- Include specific numbers and data points from the results
- If queries were run, include key SQL as artifacts so users can re-run them
- Highlight anomalies, trends, or actionable findings
- If results are incomplete due to errors, note what couldn't be determined`;

/**
 * Plan an investigation by asking the LLM to decompose the task.
 */
export async function planInvestigation(llmGateway, task, context) {
  const messages = [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
    { role: 'user', content: `Task: ${task}\n\nAvailable context about the datalake:\n${context.schemaContext || 'No schema context available.'}` },
  ];

  try {
    const response = await llmGateway.chat(messages, { temperature: 0.2 });
    const parsed = JSON.parse(extractJson(response));
    return {
      reasoning: parsed.reasoning || '',
      subtasks: parsed.subtasks || [],
    };
  } catch (err) {
    // Fallback: single SQL analyst task
    return {
      reasoning: 'Failed to plan, falling back to single query approach',
      subtasks: [
        { agent: 'sql_analyst', description: task, inputs: {} },
      ],
    };
  }
}

/**
 * Synthesize results from all sub-agents into a final response.
 */
export async function synthesizeResults(llmGateway, task, results, context) {
  const resultsSummary = results.map((r, i) => {
    const status = r.status === 'success' ? '✓' : '✗';
    const content = r.status === 'success'
      ? JSON.stringify(r.result, null, 2).slice(0, 2000)
      : `Error: ${r.result.error}`;
    return `[${status} Sub-task ${i + 1}: ${r.subtask.agent}] ${r.subtask.description}\nResult:\n${content}`;
  }).join('\n\n---\n\n');

  const messages = [
    { role: 'system', content: SYNTHESIZER_SYSTEM_PROMPT },
    { role: 'user', content: `Original task: ${task}\n\nSub-agent results:\n${resultsSummary}` },
  ];

  try {
    const response = await llmGateway.chat(messages, { temperature: 0.3 });
    const parsed = JSON.parse(extractJson(response));
    return {
      summary: parsed.summary || response,
      artifacts: parsed.artifacts || [],
    };
  } catch (err) {
    // Fallback: return raw results as summary
    return {
      summary: `## Investigation Results\n\n${resultsSummary}`,
      artifacts: [],
    };
  }
}

/**
 * Extract JSON from an LLM response (handles markdown code fences).
 */
function extractJson(text) {
  // Try to find JSON in code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];

  return text;
}
