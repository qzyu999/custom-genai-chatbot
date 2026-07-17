/**
 * Sub-Agent Registry
 * 
 * Manages available sub-agent types and instantiates them on demand.
 * Phase 1: All agents run in-process.
 * Phase 2: Agents are dispatched to containers via ECS.
 */

import { SqlAnalystAgent } from './sql-analyst.js';
import { DataAnalystAgent } from './data-analyst.js';
import { ResearcherAgent } from './researcher.js';

export class SubAgentRegistry {
  constructor(config, plugins, llmGateway) {
    this.agents = {
      sql_analyst: new SqlAnalystAgent(config, plugins, llmGateway),
      data_analyst: new DataAnalystAgent(config, plugins, llmGateway),
      researcher: new ResearcherAgent(config, plugins, llmGateway),
    };
  }

  get(agentType) {
    const agent = this.agents[agentType];
    if (!agent) {
      throw new Error(`Unknown sub-agent type: ${agentType}. Available: ${Object.keys(this.agents).join(', ')}`);
    }
    return agent;
  }

  list() {
    return Object.entries(this.agents).map(([id, agent]) => ({
      id,
      name: agent.name,
      description: agent.description,
      capabilities: agent.capabilities || [],
    }));
  }
}
