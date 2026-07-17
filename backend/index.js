import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { load as yamlLoad } from "js-yaml";
import Chat from "./models/chat.js";
import UserChats from "./models/userChats.js";
import { loadPlugins } from "./plugins/index.js";
import { ContextCompiler } from "./context/compiler.js";
import { registerAgentRoutes } from "./agent/routes.js";

// Allow self-signed certs for enterprise endpoints
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const port = process.env.PORT || 3000;
const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(
    cors({
        origin: process.env.CLIENT_URL,
        credentials: true,
    })
);
app.use(express.json());

// Hardcoded user ID (no auth — host page handles identity)
const DEFAULT_USER_ID = "local-user";

// ── Storage Layer (Mongo with in-memory fallback) ───────────────
let mongoConnected = false;
const memStore = { chats: [], userChats: [] };

const connect = async () => {
    try {
        mongoose.set('bufferCommands', false);
        await mongoose.connect(process.env.MONGO, {
            serverSelectionTimeoutMS: 3000,
            connectTimeoutMS: 3000,
        });
        mongoConnected = true;
        console.log('✅ Connected to MongoDB');
    } catch (err) {
        mongoConnected = false;
        console.log('⚠️  MongoDB unavailable — using in-memory storage (chats lost on restart)');
    }
};

// ── Chat CRUD Routes ────────────────────────────────────────────

app.post("/api/chats", async (req, res) => {
    const { text, model } = req.body;
    if (!model) return res.status(400).json({ error: 'Model is required' });

    try {
        if (mongoConnected) {
            const newChat = new Chat({ userId: DEFAULT_USER_ID, history: [{ role: 'user', parts: [{ text }] }], model });
            const savedChat = await newChat.save();
            const userChats = await UserChats.find({ userId: DEFAULT_USER_ID });
            if (!userChats.length) {
                await new UserChats({ userId: DEFAULT_USER_ID, chats: [{ _id: savedChat._id, title: text.substring(0, 40) }] }).save();
            } else {
                await UserChats.updateOne({ userId: DEFAULT_USER_ID }, { $push: { chats: { _id: savedChat._id, title: text.substring(0, 40) } } });
            }
            return res.status(201).json({ id: savedChat._id });
        }
        // In-memory fallback
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
        memStore.chats.push({ _id: id, userId: DEFAULT_USER_ID, history: [{ role: 'user', parts: [{ text }] }], model, isCustomChatbot: false });
        memStore.userChats.push({ _id: id, title: text.substring(0, 40) });
        res.status(201).json({ id });
    } catch (err) {
        res.status(500).json({ error: 'Error creating chat: ' + err.message });
    }
});

app.get('/api/userchats', async (req, res) => {
    try {
        if (mongoConnected) {
            const userChats = await UserChats.find({ userId: DEFAULT_USER_ID });
            return res.status(200).json(userChats.length ? userChats[0].chats : []);
        }
        res.status(200).json(memStore.userChats);
    } catch (err) {
        res.status(200).json([]);
    }
});

app.get('/api/search', async (req, res) => {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) return res.status(200).json([]);

    try {
        if (mongoConnected) {
            // Search through all chat histories for this user
            const chats = await Chat.find({ userId: DEFAULT_USER_ID });
            const matches = chats
                .filter(chat => chat.history.some(msg =>
                    msg.parts.some(p => p.text.toLowerCase().includes(q))
                ))
                .map(chat => ({ _id: chat._id, title: chat.history[0]?.parts[0]?.text?.substring(0, 40) || 'Untitled' }));
            return res.status(200).json(matches);
        }
        // In-memory search
        const matches = memStore.chats
            .filter(chat => chat.history.some(msg =>
                msg.parts.some(p => p.text.toLowerCase().includes(q))
            ))
            .map(chat => ({ _id: chat._id, title: chat.history[0]?.parts[0]?.text?.substring(0, 40) || 'Untitled' }));
        res.status(200).json(matches);
    } catch (err) {
        res.status(200).json([]);
    }
});

app.get('/api/chats/:id', async (req, res) => {
    try {
        if (mongoConnected) {
            const chat = await Chat.findOne({ _id: req.params.id });
            return chat ? res.status(200).json(chat) : res.status(404).json({ error: 'Chat not found' });
        }
        const chat = memStore.chats.find(c => c._id === req.params.id);
        return chat ? res.status(200).json(chat) : res.status(404).json({ error: 'Chat not found' });
    } catch (err) {
        res.status(500).json({ error: 'Error fetching chat: ' + err.message });
    }
});

app.put("/api/chats/:id", async (req, res) => {
    const { question, answer, img } = req.body;
    const newItems = [
        ...(question ? [{ role: "user", parts: [{ text: question }], ...(img && { img }) }] : []),
        ...(answer ? [{ role: "model", parts: [{ text: answer }] }] : []),
    ];
    if (newItems.length === 0) return res.status(400).json({ error: 'Nothing to save' });
    try {
        if (mongoConnected) {
            await Chat.updateOne({ _id: req.params.id }, { $push: { history: { $each: newItems } } });
            return res.status(200).json({ ok: true });
        }
        const chat = memStore.chats.find(c => c._id === req.params.id);
        if (chat) { chat.history.push(...newItems); return res.status(200).json({ ok: true }); }
        res.status(404).json({ error: 'Chat not found' });
    } catch (err) {
        res.status(500).send("Error adding conversation!");
    }
});

app.delete('/api/chats/:id', async (req, res) => {
    try {
        const chatId = req.params.id;
        if (mongoConnected) {
            await Chat.deleteOne({ _id: chatId });
            await UserChats.updateOne({ userId: DEFAULT_USER_ID }, { $pull: { chats: { _id: chatId } } });
        } else {
            memStore.chats = memStore.chats.filter(c => c._id !== chatId);
            memStore.userChats = memStore.userChats.filter(c => c._id !== chatId);
        }
        res.status(200).send('Chat deleted successfully!');
    } catch (err) {
        res.status(500).send('Error deleting chat!');
    }
});

// ── Investigation Persistence ────────────────────────────────────

app.post('/api/chats/:id/investigations', async (req, res) => {
    const { task, steps, result, status } = req.body;
    if (!task) return res.status(400).json({ error: 'task is required' });

    const investigation = { task, steps: steps || [], result: result || null, status: status || 'complete', createdAt: new Date() };

    try {
        if (mongoConnected) {
            await Chat.updateOne({ _id: req.params.id }, { $push: { investigations: investigation } });
            return res.status(201).json({ ok: true });
        }
        const chat = memStore.chats.find(c => c._id === req.params.id);
        if (chat) {
            if (!chat.investigations) chat.investigations = [];
            chat.investigations.push(investigation);
            return res.status(201).json({ ok: true });
        }
        res.status(404).json({ error: 'Chat not found' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/chats/:id/investigations', async (req, res) => {
    try {
        if (mongoConnected) {
            const chat = await Chat.findOne({ _id: req.params.id }, { investigations: 1 });
            return res.json({ investigations: chat?.investigations || [] });
        }
        const chat = memStore.chats.find(c => c._id === req.params.id);
        res.json({ investigations: chat?.investigations || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Enterprise LLM Gateway Proxy ────────────────────────────────

function loadGatewayConfig() {
    const configPath = path.resolve(__dirname, "../config.yaml");
    if (!fs.existsSync(configPath)) {
        console.warn("⚠️  config.yaml not found — gateway proxy disabled");
        return null;
    }
    let raw = yamlLoad(fs.readFileSync(configPath, "utf8"));

    // Apply local override if present (gitignored — for private/enterprise config)
    const localPath = path.resolve(__dirname, "../config.local.yaml");
    if (fs.existsSync(localPath)) {
        const local = yamlLoad(fs.readFileSync(localPath, "utf8")) || {};
        raw = deepMerge(raw, local);
        console.log('🔧 Applied config.local.yaml overlay');
    }

    const providers = {};
    for (const [name, prov] of Object.entries(raw.llm?.providers || {})) {
        let apiKey = prov.api_key || "";
        if (!apiKey && prov.api_key_secret) {
            const secretPath = path.resolve(__dirname, "../secrets", `${prov.api_key_secret}.txt`);
            if (fs.existsSync(secretPath)) {
                apiKey = fs.readFileSync(secretPath, "utf8").trim();
            }
        }
        providers[name] = { ...prov, api_key: apiKey, name };
    }
    return {
        providers,
        defaultProvider: raw.llm?.default_provider || Object.keys(providers)[0],
        defaultModel: raw.llm?.default_model || "",
        modelFilter: raw.llm?.model_filter || "",
    };
}

function deepMerge(base, override) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && merged[key] && typeof merged[key] === 'object') {
            merged[key] = deepMerge(merged[key], value);
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

const gatewayConfig = loadGatewayConfig();
if (gatewayConfig) {
    console.log(`✅ Gateway config loaded: providers=[${Object.keys(gatewayConfig.providers).join(", ")}]`);
}

app.post("/api/chat/completions", async (req, res) => {
    if (!gatewayConfig) {
        return res.status(503).json({ error: "Gateway not configured (missing config.yaml)" });
    }

    const { messages, model, provider: providerOverride, ...rest } = req.body;
    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "messages array is required" });
    }

    // --- Context Injection (compiled at startup) ---
    const enrichedMessages = [...messages];
    const compiledSystemPrompt = contextCompiler.getSystemPrompt();
    const anchor = contextCompiler.getAnchor();

    // Inject compiled context into the system message
    if (compiledSystemPrompt) {
        const systemIdx = enrichedMessages.findIndex(m => m.role === 'system');
        if (systemIdx >= 0) {
            enrichedMessages[systemIdx] = {
                ...enrichedMessages[systemIdx],
                content: compiledSystemPrompt + '\n\n' + enrichedMessages[systemIdx].content,
            };
        } else {
            enrichedMessages.unshift({ role: 'system', content: compiledSystemPrompt });
        }
    }

    // Inject anchor as the last system message (hidden steering)
    if (anchor) {
        enrichedMessages.push({ role: 'system', content: anchor });
    }

    const providerName = providerOverride || gatewayConfig.defaultProvider;
    const providerConfig = gatewayConfig.providers[providerName];
    if (!providerConfig) {
        return res.status(400).json({
            error: `Unknown provider: ${providerName}. Available: ${Object.keys(gatewayConfig.providers).join(", ")}`,
        });
    }

    const baseUrl = providerConfig.base_url.replace(/\/$/, "");
    const endpointPath = providerConfig.endpoint_path || "/chat/completions";
    const url = `${baseUrl}${endpointPath.startsWith("/") ? endpointPath : "/" + endpointPath}`;

    const authScheme = providerConfig.auth_scheme || "bearer";
    const authHeader = providerConfig.api_key
        ? authScheme === "basic" ? `basic ${providerConfig.api_key}` : `Bearer ${providerConfig.api_key}`
        : undefined;

    const payload = { model: model || gatewayConfig.defaultModel, messages: enrichedMessages, ...rest };
    for (const [key, value] of Object.entries(providerConfig.settings || {})) {
        if (!(key in payload)) payload[key] = value;
    }
    payload.stream = true;

    try {
        const headers = { "Content-Type": "application/json" };
        if (authHeader) headers["Authorization"] = authHeader;

        console.log(`→ POST ${url} | model=${payload.model} | stream=true`);

        const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });

        if (!response.ok) {
            const text = await response.text();
            let data;
            try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 500) }; }
            console.error(`❌ Provider returned ${response.status}:`, JSON.stringify(data).slice(0, 300));
            return res.status(response.status).json(data);
        }

        // Provider streams NDJSON (one JSON object per line, no "data:" prefix)
        // We convert to standard SSE format for the frontend
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // Process complete lines
            const lines = buffer.split("\n");
            buffer = lines.pop(); // Keep incomplete line in buffer

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const chunk = JSON.parse(trimmed);
                    // Convert NDJSON chunk to standard OpenAI SSE delta format
                    const delta = chunk.choices?.[0]?.messages?.[0]?.delta || "";
                    const finishReason = chunk.choices?.[0]?.finish_reason || null;
                    const sseChunk = {
                        choices: [{ delta: { content: delta }, finish_reason: finishReason }]
                    };
                    res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
                } catch {}
            }
        }

        // Process any remaining buffer
        if (buffer.trim()) {
            try {
                const chunk = JSON.parse(buffer.trim());
                const delta = chunk.choices?.[0]?.messages?.[0]?.delta || "";
                const finishReason = chunk.choices?.[0]?.finish_reason || null;
                const sseChunk = { choices: [{ delta: { content: delta }, finish_reason: finishReason }] };
                res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
            } catch {}
        }

        res.write("data: [DONE]\n\n");
        res.end();
    } catch (err) {
        console.error("❌ Gateway proxy error:", err.message);
        res.status(502).json({ error: `Gateway error: ${err.message}` });
    }
});

app.get("/api/suggestions", (req, res) => {
    const suggestions = fullConfig?.prompts?.suggestions || [
        "What tables are available?",
        "Help me write a SQL query",
        "Explain the data model",
    ];
    res.json({ suggestions });
});

app.get("/api/context-stats", (req, res) => {
    const compiled = contextCompiler.compiled || [];
    const layers = compiled.map(l => ({
        id: l.id,
        tokens: Math.round(l.content.length / 4),
    }));
    const totalTokens = layers.reduce((sum, l) => sum + l.tokens, 0);

    // Model context limits (approximate)
    const modelLimits = {
        'gpt-4o-mini': 128000,
        'gpt-4o': 128000,
        'gpt-4.1-mini': 1000000,
        'gpt-4.1': 1000000,
        'gpt-5.1': 272000,
        'gpt-5.1-us-sovereign': 272000,
        'gpt-5.4': 1050000,
        'o4-mini': 200000,
    };

    const currentModel = gatewayConfig?.defaultModel || 'gpt-4o-mini';
    const modelLimit = modelLimits[currentModel] || 272000;

    res.json({
        layers,
        totalTokens,
        modelLimit,
        currentModel,
        usagePercent: Math.round((totalTokens / modelLimit) * 100),
    });
});

app.get("/api/models", async (req, res) => {
    if (!gatewayConfig) return res.json({ models: [], default: "" });

    const providerConfig = gatewayConfig.providers[gatewayConfig.defaultProvider];
    if (!providerConfig) return res.json({ models: [], default: gatewayConfig.defaultModel });

    const baseUrl = providerConfig.base_url.replace(/\/$/, "");
    const url = `${baseUrl}/getModels`;
    const authScheme = providerConfig.auth_scheme || "bearer";
    const authHeader = providerConfig.api_key
        ? authScheme === "basic" ? `basic ${providerConfig.api_key}` : `Bearer ${providerConfig.api_key}`
        : undefined;

    try {
        const headers = { "accept": "application/json" };
        if (authHeader) headers["Authorization"] = authHeader;
        const response = await fetch(url, { method: "GET", headers });
        if (response.ok) {
            const data = await response.json();
            let models = Array.isArray(data)
                ? data.map(m => ({ id: m.modelId || m.id || m, displayName: m.displayName || m.modelId || m.id || m, description: m.short_description || m.description || "", maxTokens: m.maxTokens || "" }))
                : [];
            // Apply optional model filter from config
            if (gatewayConfig.modelFilter) {
                const filterRegex = new RegExp(gatewayConfig.modelFilter, 'i');
                models = models.filter(m => filterRegex.test(m.id) || filterRegex.test(m.displayName));
            }
            return res.json({ models, default: gatewayConfig.defaultModel, source: "live" });
        }
    } catch (err) {
        console.warn("⚠️  Could not fetch live models, falling back to config:", err.message);
    }

    let models = (providerConfig.models || []).map(id => ({ id, displayName: id, description: "", maxTokens: "" }));
    if (gatewayConfig.modelFilter) {
        const filterRegex = new RegExp(gatewayConfig.modelFilter, 'i');
        models = models.filter(m => filterRegex.test(m.id) || filterRegex.test(m.displayName));
    }
    res.json({ models, default: gatewayConfig.defaultModel, source: "config" });
});

// ── Plugins (Wiki + Query) ───────────────────────────────────────

function loadFullConfig() {
    const configPath = path.resolve(__dirname, "../config.yaml");
    if (!fs.existsSync(configPath)) return {};
    let raw = yamlLoad(fs.readFileSync(configPath, "utf8"));
    const localPath = path.resolve(__dirname, "../config.local.yaml");
    if (fs.existsSync(localPath)) {
        const local = yamlLoad(fs.readFileSync(localPath, "utf8")) || {};
        raw = deepMerge(raw, local);
    }
    return raw;
}

const fullConfig = loadFullConfig();
const plugins = loadPlugins(fullConfig);

// Compile context at startup
const contextCompiler = new ContextCompiler(fullConfig, plugins);
contextCompiler.compile().catch(err => console.warn('⚠️  Context compilation failed:', err.message));

// Agent routes (investigation orchestrator)
registerAgentRoutes(app, fullConfig, plugins, gatewayConfig);

// Wiki routes
app.get("/api/wiki", async (req, res) => {
    if (!plugins.wiki) return res.status(501).json({ error: "Wiki plugin not configured" });
    try {
        const pages = await plugins.wiki.list();
        res.json({ pages });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/wiki/search", async (req, res) => {
    if (!plugins.wiki) return res.status(501).json({ error: "Wiki plugin not configured" });
    const q = req.query.q || "";
    if (!q) return res.json({ results: [] });
    try {
        const results = await plugins.wiki.search(q);
        res.json({ results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Wiki HTML serving (iframe-friendly) — MUST be before /:id route
const wikiHtmlPath = fullConfig?.plugins?.wiki?.html_path;
if (wikiHtmlPath && fs.existsSync(path.resolve(wikiHtmlPath))) {
    const resolvedHtmlPath = path.resolve(wikiHtmlPath);
    
    app.get("/api/wiki/html", (req, res) => {
        const htmlFiles = fs.readdirSync(resolvedHtmlPath)
            .filter(f => f.endsWith('.html') && f !== '_template.html')
            .map(f => ({
                id: f.replace('.html', ''),
                filename: f,
                title: f.replace('.html', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            }));
        res.json({ pages: htmlFiles });
    });

    app.use("/wiki-static", express.static(resolvedHtmlPath));

    // 404 for missing wiki pages (don't fall through to React catch-all)
    app.use("/wiki-static", (req, res) => {
        res.status(404).send('<html><body style="font-family:sans-serif;padding:40px;color:#666"><h2>Page not found</h2><p>This wiki page has not been created yet.</p><a href="/wiki-static/index.html">← Back to Wiki</a></body></html>');
    });

    console.log(`📄 Wiki HTML serving enabled: ${resolvedHtmlPath}`);
} else {
    app.get("/api/wiki/html", (req, res) => {
        res.json({ pages: [] });
    });
}

app.get("/api/wiki/:id", async (req, res) => {
    if (!plugins.wiki) return res.status(501).json({ error: "Wiki plugin not configured" });
    try {
        const page = await plugins.wiki.get(req.params.id);
        if (!page) return res.status(404).json({ error: "Page not found" });
        res.json(page);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Query routes
app.get("/api/query/catalog", async (req, res) => {
    if (!plugins.query) return res.status(501).json({ error: "Query plugin not configured" });
    try {
        const catalog = await plugins.query.getCatalog();
        res.json(catalog);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/query/execute", async (req, res) => {
    if (!plugins.query) return res.status(501).json({ error: "Query plugin not configured" });
    const { sql } = req.body;
    if (!sql) return res.status(400).json({ error: "sql field is required" });
    try {
        const result = await plugins.query.execute(sql);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/query/validate", async (req, res) => {
    if (!plugins.query) return res.status(501).json({ error: "Query plugin not configured" });
    const { sql } = req.body;
    try {
        const result = await plugins.query.validate(sql);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Error Handling & Static ─────────────────────────────────────

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Internal server error');
});

app.use(express.static(path.join(__dirname, '../client')));
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, '../client', 'index.html')); });

app.listen(port, () => {
    connect();
    console.log(`🚀 Server running on http://localhost:${port}`);
});
