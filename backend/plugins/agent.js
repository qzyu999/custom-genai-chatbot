/**
 * Agent Plugin Interface
 *
 * For complex multi-step tasks that exceed a single LLM call.
 * Delegates work to an external agent system that can run tools,
 * query data, read docs, and consolidate results.
 *
 * Any agent provider must implement:
 *   - isAvailable()       → boolean
 *   - delegate(task)      → { result, sources?, artifacts? }
 *   - getCapabilities()   → [{ name, description }]
 *
 * The chat engine decides when to delegate based on task complexity.
 */

export class AgentPlugin {
    constructor(config) {
        this.config = config;
    }

    /** Check if the agent system is reachable */
    async isAvailable() {
        throw new Error('AgentPlugin.isAvailable() not implemented');
    }

    /**
     * Delegate a complex task to the agent system.
     *
     * @param {object} task
     *   - prompt: string (the user's request)
     *   - context: string (wiki + schema context already gathered)
     *   - history: array (conversation history for continuity)
     *
     * @returns {object}
     *   - result: string (the consolidated response)
     *   - sources: [{ type, id, title }] (wiki pages, tables, etc. used)
     *   - artifacts: [{ type, content }] (generated SQL, reports, etc.)
     */
    async delegate(task) {
        throw new Error('AgentPlugin.delegate() not implemented');
    }

    /** List what the agent system can do */
    async getCapabilities() {
        throw new Error('AgentPlugin.getCapabilities() not implemented');
    }
}
