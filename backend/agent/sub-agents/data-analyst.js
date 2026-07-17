/**
 * Data Analyst Sub-Agent
 * 
 * Performs analytical computations on data retrieved by other agents.
 * Phase 1: Uses LLM to reason about data patterns (no actual Python execution)
 * Phase 2: Executes Python/pandas in a sandboxed container
 * 
 * Capabilities:
 * - Statistical analysis (trends, correlations, outliers)
 * - Data summarization and aggregation
 * - Pattern detection
 * - Recommendation generation
 */

const DATA_ANALYST_PROMPT = `You are a data analyst agent. Your job is to analyze data and produce insights.

Given a task and available data (from prior query results), perform analysis and produce findings.
Respond with JSON:
{
  "reasoning": "Your analytical approach",
  "findings": [
    { "type": "trend|correlation|anomaly|summary", "description": "...", "confidence": "high|medium|low" }
  ],
  "recommendations": ["actionable recommendation 1", "..."],
  "python_sketch": "Optional: pandas code that would perform this analysis (for Phase 2 execution)"
}

Rules:
- Be specific with numbers and percentages
- Note confidence levels for each finding
- Distinguish correlation from causation
- If data is insufficient, say so explicitly`;

export class DataAnalystAgent {
  constructor(config, plugins, llmGateway) {
    this.config = config;
    this.plugins = plugins;
    this.llmGateway = llmGateway;
    this.name = 'Data Analyst';
    this.description = 'Performs statistical analysis, trend detection, and produces insights from data';
    this.capabilities = ['statistical_analysis', 'trend_detection', 'correlation', 'recommendations'];
  }

  async execute(subtask, context) {
    const { description, inputs } = subtask;

    // Gather any prior results from context (from SQL analyst runs)
    const priorData = context.priorResults
      ? context.priorResults.map(r => `[${r.subtask.description}]: ${JSON.stringify(r.result).slice(0, 1500)}`).join('\n\n')
      : 'No prior data available.';

    const messages = [
      { role: 'system', content: DATA_ANALYST_PROMPT },
      {
        role: 'user',
        content: `Task: ${description}\n\nAvailable data from prior steps:\n${priorData}\n\n${inputs.focus_area ? `Focus area: ${inputs.focus_area}` : ''}`,
      },
    ];

    const response = await this.llmGateway.chat(messages, { temperature: 0.3 });
    const parsed = this._parseResponse(response);

    return {
      type: 'analysis',
      findings: parsed.findings || [],
      recommendations: parsed.recommendations || [],
      reasoning: parsed.reasoning || '',
      pythonSketch: parsed.python_sketch || null,
      artifact: {
        type: 'insight',
        title: description,
        content: this._formatFindings(parsed),
      },
    };
  }

  _parseResponse(text) {
    try {
      const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      const jsonStr = fenceMatch ? fenceMatch[1] : text.match(/\{[\s\S]*\}/)?.[0] || '{}';
      return JSON.parse(jsonStr);
    } catch {
      return { reasoning: text.slice(0, 500), findings: [], recommendations: [] };
    }
  }

  _formatFindings(parsed) {
    const lines = [];
    if (parsed.findings?.length) {
      lines.push('### Findings');
      for (const f of parsed.findings) {
        const icon = f.type === 'anomaly' ? '⚠️' : f.type === 'trend' ? '📈' : f.type === 'correlation' ? '🔗' : '📊';
        lines.push(`${icon} **${f.type}** (${f.confidence}): ${f.description}`);
      }
    }
    if (parsed.recommendations?.length) {
      lines.push('\n### Recommendations');
      for (const r of parsed.recommendations) {
        lines.push(`- ${r}`);
      }
    }
    return lines.join('\n');
  }
}
