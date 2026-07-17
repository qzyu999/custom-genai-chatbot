/**
 * Researcher Sub-Agent
 * 
 * Looks up documentation, business rules, and context from the wiki.
 * Provides definitional grounding for other agents' work.
 * 
 * Capabilities:
 * - Wiki page lookup and summarization
 * - Business rule extraction
 * - Context gathering for analysis tasks
 */

const RESEARCHER_PROMPT = `You are a research agent. Your job is to find and summarize relevant documentation.

Given a research task, identify which wiki pages and business rules are relevant,
then produce a concise summary of the relevant information.

Respond with JSON:
{
  "reasoning": "Why these sources are relevant",
  "sources": [
    { "page_id": "page-name", "relevance": "Why this page matters" }
  ],
  "summary": "Concise summary of relevant findings from documentation",
  "business_rules": ["Any applicable business rules or constraints"]
}`;

export class ResearcherAgent {
  constructor(config, plugins, llmGateway) {
    this.config = config;
    this.plugins = plugins;
    this.llmGateway = llmGateway;
    this.name = 'Researcher';
    this.description = 'Looks up documentation, business rules, and provides definitional context';
    this.capabilities = ['wiki_lookup', 'business_rules', 'context_gathering'];
  }

  async execute(subtask, context) {
    const { description, inputs } = subtask;

    // If wiki plugin available, search for relevant pages
    let wikiContext = '';
    if (this.plugins.wiki) {
      try {
        const searchResults = await this.plugins.wiki.search(description);
        if (searchResults.length > 0) {
          const pages = [];
          for (const result of searchResults.slice(0, 3)) {
            const page = await this.plugins.wiki.get(result.id);
            if (page) {
              pages.push(`[${result.title || result.id}]:\n${page.content.slice(0, 1000)}`);
            }
          }
          wikiContext = pages.join('\n\n---\n\n');
        }
      } catch {
        wikiContext = 'Wiki search unavailable.';
      }
    }

    const messages = [
      { role: 'system', content: RESEARCHER_PROMPT },
      {
        role: 'user',
        content: `Research task: ${description}\n\nWiki content found:\n${wikiContext || 'No wiki content available.'}\n\n${inputs.wiki_page ? `Specific page requested: ${inputs.wiki_page}` : ''}`,
      },
    ];

    const response = await this.llmGateway.chat(messages, { temperature: 0.2 });
    const parsed = this._parseResponse(response);

    return {
      type: 'research',
      sources: parsed.sources || [],
      summary: parsed.summary || response,
      businessRules: parsed.business_rules || [],
      artifact: {
        type: 'insight',
        title: `Research: ${description}`,
        content: parsed.summary || response,
      },
    };
  }

  _parseResponse(text) {
    try {
      const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      const jsonStr = fenceMatch ? fenceMatch[1] : text.match(/\{[\s\S]*\}/)?.[0] || '{}';
      return JSON.parse(jsonStr);
    } catch {
      return { summary: text.slice(0, 1000), sources: [], business_rules: [] };
    }
  }
}
