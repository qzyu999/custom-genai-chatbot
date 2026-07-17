/**
 * SQL Analyst Sub-Agent
 * 
 * Generates and executes SQL queries against the datalake.
 * Uses the LLM to write queries based on the task + schema context,
 * then executes via the query plugin.
 * 
 * Capabilities:
 * - Generate SQL from natural language
 * - Execute queries and return structured results
 * - Iterate on queries (refine if results aren't what's needed)
 */

const SQL_AGENT_PROMPT = `You are a SQL analyst agent. Your job is to write and execute SQL queries to answer data questions.

Given a task description and available schema, produce a SQL query.
Respond with JSON:
{
  "reasoning": "Why this query answers the question",
  "sql": "SELECT ...",
  "expected_columns": ["col1", "col2"]
}

Rules:
- Use only tables and columns from the provided schema
- Always include LIMIT (max 1000 rows) unless aggregating
- Prefer aggregations over raw data dumps
- Use clear column aliases
- For time-series, use date_trunc or equivalent`;

export class SqlAnalystAgent {
  constructor(config, plugins, llmGateway) {
    this.config = config;
    this.plugins = plugins;
    this.llmGateway = llmGateway;
    this.name = 'SQL Analyst';
    this.description = 'Generates and executes SQL queries against the datalake';
    this.capabilities = ['query_generation', 'query_execution', 'data_retrieval'];
  }

  async execute(subtask, context) {
    const { description, inputs } = subtask;

    // Step 1: Generate SQL
    const messages = [
      { role: 'system', content: SQL_AGENT_PROMPT },
      {
        role: 'user',
        content: `Task: ${description}\n\nSchema:\n${context.schemaContext || 'No schema available'}\n\n${inputs.sql_hint ? `Hint: ${inputs.sql_hint}` : ''}`,
      },
    ];

    const response = await this.llmGateway.chat(messages, { temperature: 0.1 });
    const parsed = this._parseResponse(response);

    if (!parsed.sql) {
      return { type: 'error', error: 'Failed to generate SQL', raw: response };
    }

    // Step 2: Execute query via plugin
    if (this.plugins.query) {
      try {
        const result = await this.plugins.query.execute(parsed.sql);
        return {
          type: 'query_result',
          sql: parsed.sql,
          reasoning: parsed.reasoning,
          columns: result.columns || [],
          rows: (result.rows || []).slice(0, 100), // Cap for context size
          rowCount: (result.rows || []).length,
          artifact: {
            type: 'table',
            title: description,
            content: this._formatAsMarkdown(result.columns || [], (result.rows || []).slice(0, 20)),
            sql: parsed.sql,
          },
        };
      } catch (err) {
        return {
          type: 'query_error',
          sql: parsed.sql,
          error: err.message,
          artifact: { type: 'sql', title: 'Generated Query (failed)', content: parsed.sql },
        };
      }
    }

    // No query plugin — return the SQL as artifact
    return {
      type: 'sql_only',
      sql: parsed.sql,
      reasoning: parsed.reasoning,
      artifact: { type: 'sql', title: description, content: parsed.sql },
    };
  }

  _parseResponse(text) {
    try {
      const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      const jsonStr = fenceMatch ? fenceMatch[1] : text.match(/\{[\s\S]*\}/)?.[0] || '{}';
      return JSON.parse(jsonStr);
    } catch {
      // Try to extract SQL directly
      const sqlMatch = text.match(/```sql\s*\n?([\s\S]*?)\n?```/);
      return { sql: sqlMatch ? sqlMatch[1] : null, reasoning: text.slice(0, 200) };
    }
  }

  _formatAsMarkdown(columns, rows) {
    if (!columns.length) return 'No results';
    const header = `| ${columns.join(' | ')} |`;
    const sep = `| ${columns.map(() => '---').join(' | ')} |`;
    const body = rows.map(row => `| ${row.map(c => c === null ? 'NULL' : String(c).slice(0, 50)).join(' | ')} |`).join('\n');
    return [header, sep, body].join('\n');
  }
}
