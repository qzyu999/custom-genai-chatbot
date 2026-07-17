/**
 * Agent API Routes
 * 
 * POST /api/agent/investigate    — Start an investigation (SSE stream)
 * POST /api/agent/should-investigate — Check if a message should trigger investigation
 * GET  /api/agent/capabilities   — List available sub-agents
 */

import { AgentOrchestrator } from './orchestrator.js';
import { LlmGatewayClient } from './llm-gateway.js';
import { MOCK_PLANS, MOCK_SYNTHESIS, MOCK_QUERY_RESULTS } from './mock-data.js';

let orchestrator = null;

export function registerAgentRoutes(app, config, plugins, gatewayConfig) {
  const mockMode = config?.agent?.mock_mode !== false; // Default to mock for safety
  const llmGateway = gatewayConfig ? new LlmGatewayClient(gatewayConfig) : null;

  orchestrator = new AgentOrchestrator(config, plugins, llmGateway);

  /**
   * POST /api/agent/investigate
   * Starts an investigation and streams progress events via SSE.
   * 
   * Body: { task: string, context?: { model, chatHistory } }
   */
  app.post('/api/agent/investigate', async (req, res) => {
    const { task, context = {} } = req.body;
    if (!task) return res.status(400).json({ error: 'task is required' });

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Build schema context from query plugin
    let schemaContext = '';
    if (plugins.query) {
      try {
        const ctx = await plugins.query.getContext();
        schemaContext = ctx.systemPromptAddition || '';
      } catch {}
    }

    const agentContext = {
      ...context,
      schemaContext,
      priorResults: [],
    };

    if (mockMode || !llmGateway) {
      // Mock mode: simulate the investigation with delays
      await runMockInvestigation(task, res);
    } else {
      // Real mode: use orchestrator
      try {
        await orchestrator.investigate(task, agentContext, (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          // Track results for passing to later sub-agents
          if (event.type === 'step_complete' && event.artifact) {
            agentContext.priorResults.push({
              subtask: { description: event.detail },
              result: event.artifact,
            });
          }
        });
      } catch (err) {
        res.write(`data: ${JSON.stringify({ type: 'error', detail: err.message })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  });

  /**
   * POST /api/agent/should-investigate
   * Quick check: does this message warrant an investigation?
   * 
   * Body: { message: string }
   * Returns: { suggested: boolean, reason?: string }
   */
  app.post('/api/agent/should-investigate', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.json({ suggested: false });

    const suggestion = await orchestrator.shouldInvestigate(message);
    res.json(suggestion || { suggested: false });
  });

  /**
   * GET /api/agent/capabilities
   * List available sub-agents and their capabilities.
   */
  app.get('/api/agent/capabilities', (req, res) => {
    res.json({
      agents: orchestrator.registry.list(),
      mockMode,
      maxIterations: 10,
      maxDuration: '2 minutes',
    });
  });
}

/**
 * Run a mock investigation with realistic delays and data.
 */
async function runMockInvestigation(task, res) {
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  // Determine which mock plan to use based on keywords
  let plan;
  if (/trend|over time|monthly|growth/i.test(task)) {
    plan = MOCK_PLANS.trend_analysis;
  } else if (/correlat|relationship|versus|vs\b/i.test(task)) {
    plan = MOCK_PLANS.correlation;
  } else {
    plan = MOCK_PLANS.default;
  }

  send({ type: 'started', detail: 'Planning investigation...' });
  await delay(800);

  send({ type: 'planned', detail: `${plan.subtasks.length} sub-tasks identified`, plan });
  await delay(500);

  // Execute each sub-task with mock delays
  for (let i = 0; i < plan.subtasks.length; i++) {
    const subtask = plan.subtasks[i];
    send({
      type: 'executing',
      step: i + 1,
      total: plan.subtasks.length,
      detail: `${subtask.agent}: ${subtask.description}`,
    });

    await delay(1200 + Math.random() * 800);

    // Pick some mock data for the artifact
    const mockResult = pickMockResult(subtask);
    send({
      type: 'step_complete',
      step: i + 1,
      total: plan.subtasks.length,
      detail: `${subtask.agent}: completed`,
      artifact: mockResult,
    });

    await delay(300);
  }

  send({ type: 'synthesizing', detail: 'Combining results...' });
  await delay(1500);

  send({
    type: 'complete',
    detail: 'Investigation complete',
    result: {
      summary: MOCK_SYNTHESIS.summary,
      artifacts: MOCK_SYNTHESIS.artifacts,
      steps: plan.subtasks.map(s => ({ subtask: s, status: 'success' })),
      duration: 4500 + Math.round(Math.random() * 2000),
    },
  });
}

function pickMockResult(subtask) {
  if (subtask.agent === 'sql_analyst') {
    // Pick a relevant mock dataset
    const keys = Object.keys(MOCK_QUERY_RESULTS);
    const key = keys[Math.floor(Math.random() * keys.length)];
    const data = MOCK_QUERY_RESULTS[key];
    return {
      type: 'table',
      title: subtask.description,
      content: formatMockTable(data.columns, data.rows.slice(0, 6)),
    };
  }
  if (subtask.agent === 'data_analyst') {
    return {
      type: 'insight',
      title: subtask.description,
      content: '📈 **Trend detected**: 5% month-over-month increase observed. Correlation coefficient: 0.78 (strong positive).',
    };
  }
  if (subtask.agent === 'researcher') {
    return {
      type: 'insight',
      title: subtask.description,
      content: 'Relevant business rules found: Licenses expiring within 30 days trigger automatic access review. ITAR classifications require manual renewal.',
    };
  }
  return { type: 'insight', title: subtask.description, content: 'Completed.' };
}

function formatMockTable(columns, rows) {
  const header = `| ${columns.join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map(r => `| ${r.join(' | ')} |`).join('\n');
  return [header, sep, body].join('\n');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
