/**
 * Agent Orchestrator
 * 
 * Manages the agentic investigation workflow:
 *   1. Receives a complex task from the chat
 *   2. Plans sub-tasks using the orchestrator LLM
 *   3. Dispatches sub-agents (SQL analyst, data analyst, researcher)
 *   4. Collects results, iterates if needed
 *   5. Synthesizes final response + artifacts
 * 
 * Phase 1: In-process execution (all sub-agents run locally)
 * Phase 2: Containerized sub-agents via ECS Fargate
 */

import { SubAgentRegistry } from './sub-agents/registry.js';
import { planInvestigation, synthesizeResults } from './planner.js';

const MAX_ITERATIONS = 10;
const MAX_DURATION_MS = 120_000; // 2 minutes for Phase 1

export class AgentOrchestrator {
  constructor(config, plugins, llmGateway) {
    this.config = config;
    this.plugins = plugins;
    this.llmGateway = llmGateway;
    this.registry = new SubAgentRegistry(config, plugins, llmGateway);
  }

  /**
   * Run an investigation. Yields progress events via callback.
   * 
   * @param {string} task - The user's investigation request
   * @param {object} context - Chat history, model, etc.
   * @param {function} onProgress - Called with { type, step, detail, artifacts? }
   * @returns {object} Final result { summary, artifacts, steps }
   */
  async investigate(task, context, onProgress) {
    const startTime = Date.now();
    const steps = [];

    onProgress({ type: 'started', detail: 'Planning investigation...' });

    // Step 1: Plan — ask the orchestrator LLM to break down the task
    const plan = await planInvestigation(this.llmGateway, task, context);
    onProgress({ type: 'planned', detail: `${plan.subtasks.length} sub-tasks identified`, plan });

    // Step 2: Execute sub-tasks (sequential for Phase 1, parallel later)
    const results = [];
    for (let i = 0; i < plan.subtasks.length && i < MAX_ITERATIONS; i++) {
      const subtask = plan.subtasks[i];
      const elapsed = Date.now() - startTime;
      if (elapsed > MAX_DURATION_MS) {
        onProgress({ type: 'timeout', detail: 'Investigation timed out, synthesizing partial results...' });
        break;
      }

      onProgress({
        type: 'executing',
        step: i + 1,
        total: plan.subtasks.length,
        detail: `${subtask.agent}: ${subtask.description}`,
      });

      try {
        const agent = this.registry.get(subtask.agent);
        const result = await agent.execute(subtask, context);
        results.push({ subtask, result, status: 'success' });

        onProgress({
          type: 'step_complete',
          step: i + 1,
          total: plan.subtasks.length,
          detail: `${subtask.agent}: completed`,
          artifact: result.artifact || null,
        });
      } catch (err) {
        results.push({ subtask, result: { error: err.message }, status: 'failed' });
        onProgress({
          type: 'step_failed',
          step: i + 1,
          detail: `${subtask.agent}: ${err.message}`,
        });
      }
    }

    // Step 3: Synthesize — ask the LLM to combine all results
    onProgress({ type: 'synthesizing', detail: 'Combining results...' });
    const synthesis = await synthesizeResults(this.llmGateway, task, results, context);

    const finalResult = {
      summary: synthesis.summary,
      artifacts: synthesis.artifacts || [],
      steps: results,
      duration: Date.now() - startTime,
    };

    onProgress({ type: 'complete', detail: 'Investigation complete', result: finalResult });
    return finalResult;
  }

  /**
   * Quick check: should this message trigger an investigation?
   * Returns a suggestion object or null.
   */
  async shouldInvestigate(message, chatHistory) {
    // Simple heuristics first (avoid LLM call for obvious cases)
    const complexIndicators = [
      /analyz/i, /investigat/i, /correlat/i, /trend/i, /compar/i,
      /over (the )?(past|last) \d+/i, /break down/i, /deep dive/i,
      /comprehensive/i, /multi.?step/i, /end.?to.?end/i,
    ];

    const isComplex = complexIndicators.some(r => r.test(message));
    if (!isComplex) return null;

    return {
      suggested: true,
      reason: 'This looks like a multi-step analysis that would benefit from an investigation.',
      estimatedSteps: 3,
    };
  }
}
