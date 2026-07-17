/**
 * LLM Gateway Client (for agent internal use)
 * 
 * Wraps the same provider config as the main chat endpoint,
 * but calls the LLM synchronously (non-streaming) for agent planning/synthesis.
 */

export class LlmGatewayClient {
  constructor(gatewayConfig) {
    this.config = gatewayConfig;
  }

  /**
   * Send a chat completion request (non-streaming).
   * Returns the assistant's response text.
   */
  async chat(messages, options = {}) {
    const providerConfig = this.config.providers[this.config.defaultProvider];
    if (!providerConfig) {
      throw new Error(`No provider configured: ${this.config.defaultProvider}`);
    }

    const baseUrl = providerConfig.base_url.replace(/\/$/, '');
    const endpointPath = providerConfig.endpoint_path || '/chat/completions';
    const url = `${baseUrl}${endpointPath.startsWith('/') ? endpointPath : '/' + endpointPath}`;

    const authScheme = providerConfig.auth_scheme || 'bearer';
    const authHeader = providerConfig.api_key
      ? authScheme === 'basic' ? `basic ${providerConfig.api_key}` : `Bearer ${providerConfig.api_key}`
      : undefined;

    const payload = {
      model: options.model || this.config.defaultModel,
      messages,
      stream: false,
      temperature: options.temperature ?? 0.3,
      ...(providerConfig.settings || {}),
    };

    const headers = { 'Content-Type': 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM call failed (${response.status}): ${text.slice(0, 300)}`);
    }

    const data = await response.json();

    // Handle standard OpenAI response format
    if (data.choices?.[0]?.message?.content) {
      return data.choices[0].message.content;
    }

    // Handle NDJSON-style responses (enterprise API)
    if (data.choices?.[0]?.messages?.[0]?.delta) {
      return data.choices[0].messages[0].delta;
    }

    // Fallback: try to extract any text
    return JSON.stringify(data);
  }
}
