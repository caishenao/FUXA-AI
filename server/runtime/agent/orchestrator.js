/**
 * Per-turn orchestrator.
 * Drives the function-calling loop: send messages -> receive tool_calls
 * -> execute via tool-router -> append results -> repeat until model stops
 * or we hit MAX_LOOPS. All view mutations live in a ChangeBuffer that is
 * committed atomically when the loop exits successfully.
 *
 * Streams real-time events via socket.io (agent:stream / agent:done / agent:error).
 * Persists messages and change records to SQLite via agent-storage.
 */
'use strict';

const { createAdapter } = require('./providers');
const toolRouter = require('./tool-router');

const MAX_LOOPS = 30;
const viewMutexes = new Map();

/** Minimal mutex (we don't pull async-mutex to keep zero new deps). */
function viewMutex(viewId) {
    if (!viewMutexes.has(viewId)) {
        let chain = Promise.resolve();
        viewMutexes.set(viewId, {
            acquire() {
                let release;
                const wait = new Promise(r => { release = r; });
                const prev = chain;
                chain = chain.then(() => wait);
                return prev.then(() => release);
            }
        });
    }
    return viewMutexes.get(viewId);
}

class Orchestrator {
    /**
     * @param {object} deps { runtime, settingsStore, logger, storage }
     */
    constructor(deps) {
        this.runtime = deps.runtime;
        this.settingsStore = deps.settingsStore;
        this.logger = deps.logger;
        this.storage = deps.storage || null;
    }

    /** Emit a socket.io event to all connected clients. */
    _emit(event, payload) {
        try {
            const io = this.runtime?.io;
            if (io) io.emit(event, payload);
        } catch (_) { /* defensive */ }
    }

    async runWebTurn({ viewId, userText, attachments, selection, sessionId }) {
        const cfg = this.settingsStore.getRuntime();
        if (!cfg.enabled) {
            const err = new Error('Agent is not enabled');
            err.code = 'agent_disabled';
            throw err;
        }
        if (!cfg.apiKey && cfg.provider !== 'ollama') {
            const err = new Error('Agent API key not configured');
            err.code = 'agent_no_apikey';
            throw err;
        }

        const release = await viewMutex(viewId).acquire();
        const sid = sessionId || genId();
        try {
            const result = await this._loop({ cfg, viewId, userText, attachments, selection, sessionId: sid, mode: 'web' });
            // Persist the change record for undo support.
            if (result.committed && result.committed.ok && this.storage) {
                try {
                    await this.storage.addChange(
                        genId(), sid, viewId,
                        result._beforeSnapshot || null,
                        result.committed,
                        result.usage.input,
                        result.usage.output
                    );
                } catch (e) { this.logger?.warn?.('agent.storage.addChange: ' + e.message); }
            }
            this._emit('agent:done', { sessionId: sid, viewId, text: result.text, committed: result.committed, usage: result.usage });
            return result;
        } catch (err) {
            this._emit('agent:error', { sessionId: sid, viewId, code: err.code, message: err.message });
            throw err;
        } finally {
            release();
        }
    }

    async runCliTurn({ viewId, userText, sessionId }) {
        const cfg = this.settingsStore.getRuntime();
        if (!cfg.enabled) {
            const err = new Error('Agent is not enabled');
            err.code = 'agent_disabled';
            throw err;
        }
        if (!cfg.apiKey && cfg.provider !== 'ollama') {
            const err = new Error('Agent API key not configured');
            err.code = 'agent_no_apikey';
            throw err;
        }

        const sid = sessionId || genId();
        const release = await viewMutex(viewId).acquire();
        try {
            const result = await this._loop({ cfg, viewId, userText, sessionId: sid, mode: 'cli' });
            // Persist change record if committed.
            if (result.committed && result.committed.ok && this.storage) {
                try {
                    await this.storage.addChange(
                        genId(), sid, viewId,
                        result._beforeSnapshot || null,
                        result.committed,
                        result.usage.input,
                        result.usage.output
                    );
                } catch (e) { this.logger?.warn?.('agent.storage.addChange: ' + e.message); }
            }
            return { text: result.text, trace: result.trace, committed: result.committed, usage: result.usage };
        } finally {
            release();
        }
    }

    async _loop({ cfg, viewId, userText, attachments, selection, sessionId, mode }) {
        const adapter = createAdapter(cfg, this.logger);
        const view = this._loadView(viewId);
        if (!view) {
            const err = new Error(`view ${viewId} not found`);
            err.code = 'view_not_found';
            throw err;
        }
        const buffer = {
            view: deepClone(view),
            dirty: false,
            commitRequested: false,
            beforeSnapshot: deepClone(view),
            layoutPatch: null,
            devicePatch: null
        };
        const toolMode = mode || 'web';
        const tools = toolRouter.buildDescriptors(toolMode, { runtime: this.runtime });
        const exec = toolRouter.buildExecutors(toolMode, {
            runtime: this.runtime,
            viewId,
            buffer,
            logger: this.logger,
            selection: selection && Array.isArray(selection.ids) ? { ids: selection.ids.slice() } : null
        });

        const messages = this._initialMessages({ cfg, view, selection, userText, attachments });
        const trace = [];
        let lastText = '';
        let usageTotal = { input: 0, output: 0 };
        let anyCommitted = false;

        // Persist user message.
        if (this.storage) {
            try {
                await this.storage.addMessage(genId(), sessionId, 'user', { text: userText, selection });
            } catch (e) { this.logger?.warn?.('agent.storage.addMessage(user): ' + e.message); }
        }

        for (let i = 0; i < MAX_LOOPS; i++) {
            let resp;
            try {
                resp = await adapter.chat({ messages, tools });
            } catch (err) {
                this.logger?.error(`agent.chat failed: ${err?.response?.data ? JSON.stringify(err.response.data) : err.message}`);
                throw err;
            }
            if (resp.usage) {
                usageTotal.input += resp.usage.prompt_tokens || 0;
                usageTotal.output += resp.usage.completion_tokens || 0;
            }
            if (resp.text) lastText = resp.text;
            trace.push({ kind: 'assistant', text: resp.text, toolCalls: resp.toolCalls });

            // Stream: text chunk
            if (resp.text) {
                this._emit('agent:stream', { sessionId, viewId, kind: 'text', delta: resp.text });
            }

            if (!resp.toolCalls || resp.toolCalls.length === 0) {
                break;
            }
            // Push assistant message into history exactly as needed by the model.
            messages.push({
                role: 'assistant',
                content: resp.text || null,
                tool_calls: resp.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.args) }
                }))
            });

            for (const call of resp.toolCalls) {
                const result = await this._runOne(call, tools, exec);
                trace.push({ kind: 'tool', name: call.name, args: call.args, result });

                // Stream: tool call result
                this._emit('agent:stream', {
                    sessionId, viewId, kind: 'tool',
                    name: call.name, args: call.args, result
                });

                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    name: call.name,
                    content: JSON.stringify(result)
                });

                // Real-time commit: after each tool that modifies the view,
                // persist and push the updated view so the canvas refreshes immediately.
                if (buffer.dirty) {
                    const commitResult = await this._commit(viewId, buffer);
                    if (commitResult.ok) {
                        buffer.dirty = false;
                        anyCommitted = true;
                        this._emit('agent:view-updated', {
                            sessionId, viewId,
                            itemsCount: commitResult.itemsCount
                        });
                        // Reload buffer from persisted data so subsequent tool calls
                        // see the latest committed state.
                        const freshView = this._loadView(viewId);
                        if (freshView) buffer.view = deepClone(freshView);
                    }
                }

                if (buffer.commitRequested) break;
            }
            if (buffer.commitRequested) break;
        }

        let committed = null;
        if (buffer.dirty) {
            // Catch-all: commit any remaining dirty changes that weren't
            // committed during the loop (e.g. device/layout patches).
            committed = await this._commit(viewId, buffer);
            if (committed && committed.ok) anyCommitted = true;
        }
        // If changes were committed during the loop but nothing new at the end,
        // still report ok=true so legacy clients know to reload.
        if (!committed && anyCommitted) {
            committed = {
                ok: true,
                viewId,
                itemsCount: Object.keys(buffer.view?.items || {}).length
            };
        }

        // Persist assistant message.
        if (this.storage) {
            try {
                await this.storage.addMessage(genId(), sessionId, 'assistant', {
                    text: lastText,
                    toolCalls: trace.filter(t => t.kind === 'tool').map(t => ({ name: t.name, result: t.result })),
                    committed
                });
            } catch (e) { this.logger?.warn?.('agent.storage.addMessage(assistant): ' + e.message); }
            try {
                await this.storage.touchSession(sessionId);
            } catch (_) { /* best effort */ }
        }

        return { text: lastText, trace, committed, usage: usageTotal, _beforeSnapshot: buffer.beforeSnapshot };
    }

    async _runOne(call, tools, exec) {
        const name = call.name || call.function?.name;
        let args = call.args ?? call.function?.arguments ?? {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        const desc = tools.find(t => t.name === name);
        if (!desc) return { error: 'unknown_tool', tool: name };
        const errs = toolRouter.validate(desc.input_schema, args);
        if (errs.length) return { error: 'invalid_args', details: errs };
        try {
            return await exec[name](args);
        } catch (err) {
            return { error: 'tool_failed', message: String(err?.message || err) };
        }
    }

    _loadView(viewId) {
        try {
            const project = this.runtime?.project;
            // Use synchronous getView if available (avoids Promise wrapping).
            if (project && typeof project.getView === 'function') {
                return project.getView(viewId);
            }
            // Fallback: try getProject synchronously (returns a deep copy).
            const data = project?.getProject?.();
            if (data && typeof data.then === 'function') return null; // Promise — can't use sync
            const views = (data?.hmi && data.hmi.views) || [];
            return views.find(v => v.id === viewId) || null;
        } catch (_) {
            return null;
        }
    }

    async _commit(viewId, buffer) {
        const project = this.runtime?.project;
        if (!project) return { ok: false, reason: 'no_project_runtime' };
        const cmds = project.ProjectDataCmdType || {};
        try {
            // Commit view changes.
            if (buffer.dirty && buffer.view) {
                const cmdType = cmds.SetView || 'set-view';
                if (typeof project.setProjectData === 'function') {
                    await project.setProjectData(cmdType, buffer.view);
                } else if (typeof project.setView === 'function') {
                    await project.setView(buffer.view);
                } else {
                    return { ok: false, reason: 'project_setProjectData_missing' };
                }
            }
            // Commit layout changes.
            if (buffer.layoutPatch) {
                const cmdType = cmds.HmiLayout || 'layout';
                if (typeof project.setProjectData === 'function') {
                    await project.setProjectData(cmdType, buffer.layoutPatch);
                }
            }
            // Commit device changes (add/update/delete).
            if (buffer.devicePatch) {
                for (const dp of buffer.devicePatch) {
                    const cmdType = dp.cmd === 'delete' ? (cmds.DelDevice || 'del-device') : (cmds.SetDevice || 'set-device');
                    if (typeof project.setProjectData === 'function') {
                        await project.setProjectData(cmdType, dp.device);
                    }
                }
            }
            return {
                ok: true,
                viewId,
                itemsCount: Object.keys(buffer.view?.items || {}).length
            };
        } catch (err) {
            this.logger?.error(`agent.commit failed: ${err}`);
            return { ok: false, reason: String(err?.message || err) };
        }
    }

    /**
     * Undo the last committed change on a view by restoring its beforeSnapshot.
     */
    async undo(viewId) {
        if (!this.storage) {
            return { ok: false, reason: 'no_storage' };
        }
        const change = await this.storage.getLastChange(viewId);
        if (!change) {
            return { ok: false, reason: 'no_change_to_undo' };
        }
        let snapshot;
        try {
            snapshot = JSON.parse(change.before_snapshot);
        } catch (_) {
            return { ok: false, reason: 'invalid_snapshot' };
        }
        if (!snapshot || !snapshot.id) {
            return { ok: false, reason: 'empty_snapshot' };
        }
        const project = this.runtime?.project;
        if (!project) return { ok: false, reason: 'no_project_runtime' };
        try {
            const cmdType = (project.ProjectDataCmdType && project.ProjectDataCmdType.SetView) || 'set-view';
            if (typeof project.setProjectData === 'function') {
                await project.setProjectData(cmdType, snapshot);
            } else if (typeof project.setView === 'function') {
                await project.setView(snapshot);
            } else {
                return { ok: false, reason: 'project_setProjectData_missing' };
            }
            return { ok: true, viewId, itemsCount: Object.keys(snapshot.items || {}).length };
        } catch (err) {
            this.logger?.error(`agent.undo failed: ${err}`);
            return { ok: false, reason: String(err?.message || err) };
        }
    }

    _initialMessages({ cfg, view, selection, userText, attachments }) {
        const parts = [
            'You are FUXA Agent, an assistant embedded in a web SCADA/HMI editor.',
            'You can modify the active View, manage devices/tags, run scripts, and query project data.',
            'CRITICAL: Do NOT chat, explain, or confirm before acting. Just call tools immediately.',
            'Do NOT say "I will", "Let me", "Sure", "OK" or any preamble. Call tools directly.',
            'Do NOT emit raw SVG or code blocks in chat. Always use structured tools.',
            'For view changes: call tools directly, then call view.save at the end. No planning text.',
            'Only reply with text if you genuinely need clarification or hit an error.',
            'Available tool groups: view_* (gauge editing, layout), device_* (device CRUD), tag_* (tag browsing, values), project-level: view_list/create/delete, script_list/run, alarm_list.',
            `Current view: id=${view.id} name=${view.name || ''} profile=${JSON.stringify(view.profile || {})}.`,
            `Items count: ${Object.keys(view.items || {}).length}.`,
            cfg.language ? `Reply in ${cfg.language}.` : ''
        ];

        // Inject instruction-pack instructions into system prompt.
        const skillMgr = this.runtime?.agentMgr?.getSkillManager?.();
        if (skillMgr) {
            const instr = skillMgr.getInstructions();
            if (instr) parts.push('\n--- SKILL INSTRUCTIONS ---\n' + instr);
        }

        // Design import tools info
        parts.push(
            'Design import tools: design_parse_pen (parse .pen files), ' +
            'design_place_elements (batch-place elements on canvas), ' +
            'design_set_background (set background image). ' +
            'For PNG/JPG: analyze the image then use view_add_gauge to recreate the layout. ' +
            'Map design types to FUXA: rect->svg-ext-rect, ellipse->svg-ext-ellipse, ' +
            'text->svg-ext-text, line->svg-ext-line, button->html-button, value->value. ' +
            'Always call view_save after placing elements.'
        );

        const sys = parts.filter(Boolean).join('\n');

        const userParts = [];
        if (selection && selection.ids && selection.ids.length) {
            userParts.push(`SELECTION: ${selection.ids.join(', ')}. Restrict modifications to these unless the user explicitly says otherwise.`);
        }
        userParts.push(userText || '');

        const userMsg = { role: 'user', content: userParts.join('\n\n') };
        if (attachments && attachments.length) {
            // OpenAI vision multimodal payload — adapter uses non-streaming
            // chat completion which accepts content as an array of parts.
            userMsg.content = [
                { type: 'text', text: userParts.join('\n\n') },
                ...attachments
                    .filter(a => a && a.kind === 'image' && a.dataUrl)
                    .map(a => ({ type: 'image_url', image_url: { url: a.dataUrl } }))
            ];
        }
        return [
            { role: 'system', content: sys },
            userMsg
        ];
    }
}

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function deepClone(o) {
    return o == null ? o : JSON.parse(JSON.stringify(o));
}

module.exports = { Orchestrator };
