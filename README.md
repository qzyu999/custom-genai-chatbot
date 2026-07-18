# Lighthouse

Pluggable AI chatbot for datalake exploration. Config-driven LLM gateway, dynamic model selection, streaming responses, full-text chat search.

Designed to embed into existing platforms or run standalone. No hardcoded provider — bring your own OpenAI-compatible endpoint.

## Architecture

```
client/                    React UI (Vite) — chat, model picker, search
backend/                   Express gateway — proxies LLM calls, manages chat history
config.yaml                Provider config (committed, no secrets)
config.local.yaml          Private overrides (gitignored)
secrets/                   API keys (gitignored)
```

## Quick Start

### 1. Configure

Copy `config.yaml` for defaults. For a custom provider, create `config.local.yaml`:

```yaml
llm:
  providers:
    my-provider:
      type: openai
      base_url: "https://my-llm-endpoint.com/v1"
      endpoint_path: "/chat/completions"
      auth_scheme: "bearer"
      api_key_secret: "my_api_key"
      models: ["gpt-4o-mini", "gpt-4o"]
  default_provider: "my-provider"
  default_model: "gpt-4o-mini"
```

Put your API key in `secrets/my_api_key.txt`.

### 2. Run Backend

```bash
cd backend
npm install
npm start
```

### 3. Run Frontend

```bash
cd client
npm install
npm run dev
```

Open http://localhost:5173

## Features

- Streaming responses (token-by-token, cancellable)
- Dynamic model list from provider API (with config fallback)
- ChatGPT-style regeneration with variant navigation
- Full-text search across all conversation history
- In-memory storage fallback (works without MongoDB)
- Config-driven — no hardcoded providers or credentials

## Config Pattern

- `config.yaml` — committed, defines provider shape (no secrets)
- `config.local.yaml` — gitignored, deep-merged on top for private endpoints
- `secrets/` — gitignored API key files, resolved at runtime

## MongoDB (Optional)

Chat history persists to MongoDB if available. Without it, falls back to in-memory (chats lost on restart).

```bash
docker run -d --name mongo -p 27017:27017 mongo:7
```

## License

Apache License 2.0 — see [LICENSE](LICENSE)
