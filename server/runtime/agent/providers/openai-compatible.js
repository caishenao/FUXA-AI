/**
 * OpenAI-compatible & Anthropic Chat adapter.
 * Works with: OpenAI, DeepSeek, Moonshot, Qwen, Ollama, Anthropic proxies, etc.
 *
 * Uses Node built-in http/https — no new server dep required.
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

class OpenAICompatibleAdapter {
    constructor(cfg, logger) {
        this.cfg = cfg;
        this.logger = logger;
    }

    /**
     * Build full URL, ensuring /v1 prefix when the base doesn't include it.
     * e.g. base=https://proxy.com/anthropic  path=/messages
     *   → https://proxy.com/anthropic/v1/messages
     */
    _buildUrl(path) {
        const base = (this.cfg.baseUrl || '').replace(/\/+$/, '');
        // If base already ends with /v1 or /v<number>, or path starts with /v1, don't double-add.
        if (/\/v\d+$/.test(base) || path.startsWith('/v1')) {
            return new URL(base + path);
        }
        return new URL(base + '/v1' + path);
    }

    _request(path, method, body, extraHeaders) {
        const url = this._buildUrl(path);
        const headers = { 'Content-Type': 'application/json' };
        if (this.cfg.apiKey) {
            headers['Authorization'] = `Bearer ${this.cfg.apiKey}`;
        }
        if (extraHeaders) Object.assign(headers, extraHeaders);
        const lib = url.protocol === 'http:' ? http : https;
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        if (data) headers['Content-Length'] = data.length;
        return new Promise((resolve, reject) => {
            const req = lib.request({
                method,
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'http:' ? 80 : 443),
                path: url.pathname + (url.search || ''),
                headers,
                timeout: this.cfg.timeoutMs || 60000
            }, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    const text = buf.toString('utf8');
                    let parsed;
                    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { _raw: text }; }
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ status: res.statusCode, data: parsed });
                    } else {
                        const err = new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`);
                        err.status = res.statusCode;
                        err.response = { status: res.statusCode, data: parsed };
                        reject(err);
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(new Error('timeout')); });
            if (data) req.write(data);
            req.end();
        });
    }

    /**
     * HTTP request with Anthropic-specific headers (x-api-key, no Bearer).
     */
    _anthropicRequest(path, method, body) {
        const url = this._buildUrl(path);
        const headers = {
            'Content-Type': 'application/json',
            'x-api-key': this.cfg.apiKey || '',
            'anthropic-version': '2023-06-01'
        };
        const lib = url.protocol === 'http:' ? http : https;
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        if (data) headers['Content-Length'] = data.length;
        return new Promise((resolve, reject) => {
            const req = lib.request({
                method,
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'http:' ? 80 : 443),
                path: url.pathname + (url.search || ''),
                headers,
                timeout: this.cfg.timeoutMs || 60000
            }, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    const text = buf.toString('utf8');
                    let parsed;
                    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { _raw: text }; }
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ status: res.statusCode, data: parsed });
                    } else {
                        const err = new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`);
                        err.status = res.statusCode;
                        err.response = { status: res.statusCode, data: parsed };
                        reject(err);
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(new Error('timeout')); });
            if (data) req.write(data);
            req.end();
        });
    }

    async ping() {
        const t0 = Date.now();
        const errors = [];

        if (this._isAnthropicEndpoint()) {
            // Anthropic-style ping: minimal /messages request.
            try {
                await this._anthropicRequest('/messages', 'POST', {
                    model: this.cfg.chatModel || 'claude-sonnet-4-20250514',
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'ping' }]
                });
                return { ok: true, latencyMs: Date.now() - t0, fallback: 'anthropic' };
            } catch (err) {
                // 401 = auth error but endpoint is reachable = success
                if (err.status === 401) {
                    return { ok: false, error: 'Invalid API Key (endpoint reachable)' };
                }
                errors.push('anthropic/messages: ' + (err.message || err));
            }
            return { ok: false, error: errors.join('; ') };
        }

        // OpenAI-style ping strategies.
        try {
            const res = await this._request('/models', 'GET');
            return { ok: true, latencyMs: Date.now() - t0, modelsCount: Array.isArray(res.data?.data) ? res.data.data.length : undefined };
        } catch (err) {
            errors.push('models: ' + (err.message || err));
        }

        try {
            await this._request('/chat/completions', 'POST', {
                model: this.cfg.chatModel,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1
            });
            return { ok: true, latencyMs: Date.now() - t0, fallback: 'chat' };
        } catch (err) {
            errors.push('chat/completions: ' + (err.message || err));
        }

        return { ok: false, error: errors.join('; ') };
    }

    async chat(req) {
        if (this._isAnthropicEndpoint()) {
            return this._chatAnthropic(req);
        }
        return this._chatOpenAI(req);
    }

    async _chatOpenAI(req) {
        const body = {
            model: req.model || this.cfg.chatModel,
            messages: req.messages,
            temperature: req.temperature ?? this.cfg.temperature,
            max_tokens: req.maxTokens ?? this.cfg.maxTokens
        };
        if (req.tools && req.tools.length) {
            body.tools = req.tools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.input_schema
                }
            }));
            body.tool_choice = 'auto';
        }
        const res = await this._request('/chat/completions', 'POST', body);
        const choice = res.data?.choices?.[0];
        const msg = choice?.message || {};
        return {
            text: msg.content || '',
            reasoningContent: msg.reasoning_content || msg.thinking_content || null,
            toolCalls: (msg.tool_calls || []).map(tc => ({
                id: tc.id,
                name: tc.function?.name,
                args: safeJson(tc.function?.arguments)
            })),
            finishReason: choice?.finish_reason || 'stop',
            usage: res.data?.usage || null
        };
    }

    async _chatAnthropic(req) {
        const messages = this._convertMessagesForAnthropic(req.messages);
        const body = {
            model: req.model || this.cfg.chatModel,
            max_tokens: req.maxTokens ?? this.cfg.maxTokens,
            messages
        };
        if (req.tools && req.tools.length) {
            body.tools = req.tools.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.input_schema
            }));
        }
        if (req.temperature != null) body.temperature = req.temperature;
        else if (this.cfg.temperature != null) body.temperature = this.cfg.temperature;

        const res = await this._anthropicRequest('/messages', 'POST', body);
        const data = res.data;
        const textParts = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
        const toolUses = (data.content || []).filter(b => b.type === 'tool_use');

        return {
            text: textParts.join('\n') || '',
            toolCalls: toolUses.map(tu => ({
                id: tu.id,
                name: tu.name,
                args: tu.input || {}
            })),
            finishReason: data.stop_reason === 'tool_use' ? 'tool_use' : 'stop',
            usage: data.usage ? {
                prompt_tokens: data.usage.input_tokens || 0,
                completion_tokens: data.usage.output_tokens || 0
            } : null
        };
    }

    _convertMessagesForAnthropic(messages) {
        const out = [];
        for (const m of messages) {
            if (m.role === 'system') {
                out.push({ role: 'user', content: m.content });
                out.push({ role: 'assistant', content: 'Understood. I will follow these instructions.' });
                continue;
            }
            if (m.role === 'tool') {
                out.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: m.tool_call_id,
                        content: m.content
                    }]
                });
                continue;
            }
            if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
                const content = [];
                if (m.content) content.push({ type: 'text', text: m.content });
                for (const tc of m.tool_calls) {
                    content.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.function?.name || tc.name,
                        args: typeof tc.function?.arguments === 'string'
                            ? safeJson(tc.function.arguments)
                            : (tc.args || {})
                    });
                }
                out.push({ role: 'assistant', content });
                continue;
            }
            if (typeof m.content === 'string') {
                out.push({ role: m.role, content: m.content });
            } else if (Array.isArray(m.content)) {
                out.push({ role: m.role, content: m.content });
            } else {
                out.push({ role: m.role, content: JSON.stringify(m.content) });
            }
        }
        return out;
    }

    _isAnthropicEndpoint() {
        const url = (this.cfg.baseUrl || '').toLowerCase();
        const provider = (this.cfg.provider || '').toLowerCase();
        return provider === 'anthropic'
            || url.includes('anthropic')
            || url.includes('/anthropic');
    }
}

function safeJson(s) {
    if (!s) return {};
    try { return JSON.parse(s); } catch { return { _raw: s }; }
}

module.exports = { OpenAICompatibleAdapter };
