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
            'You can modify the active View, manage devices/tags, scripts, alarms, and project data.',
            'CRITICAL: Do NOT chat, explain, or confirm before acting. Just call tools immediately.',
            'Do NOT say "I will", "Let me", "Sure", "OK" or any preamble. Call tools directly.',
            'Do NOT emit raw SVG or code blocks in chat. Always use structured tools.',
            'For view changes: call tools directly, then call view_save at the end. No planning text.',
            'Only reply with text if you genuinely need clarification or hit an error.',
            `Current view: id=${view.id} name=${view.name || ''} profile=${JSON.stringify(view.profile || {})}.`,
            `Items count: ${Object.keys(view.items || {}).length}.`,
            cfg.language ? `Reply in ${cfg.language}.` : '',
            '',
            '=== TOOL GROUPS ===',
            'view_*: view_read, view_add_gauge, view_update_gauge, view_delete_gauge, view_bind_tag, view_set_profile, view_set_layout, view_save, view_set_event, view_update_property',
            'view project: view_list, view_create, view_delete',
            'device_*: device_list, device_read, device_add, device_update, device_delete, device_enable, device_update_property',
            'tag_*: tag_list, tag_read_value, tag_set_value, tag_history, tag_add',
            'script_*: script_list, script_run, script_create, script_update, script_delete',
            'alarm_list, design_parse_pen, design_place_elements, design_set_background',
            '',
            '=== COMPONENT TYPES (view_add_gauge type param) ===',
            'Controls: html-button, html-input, html-select, html-image, value, gauge-progress, gauge-semaphore, pipe, html-slider, html-switch, html-chart, html-bag, html-graph-bar, html-graph-pie, own_ctrl-table, own_ctrl-iframe, own_ctrl-panel, own_ctrl-video, own_ctrl-scheduler',
            'Shapes: svg-ext-rect, svg-ext-ellipse, svg-ext-text, svg-ext-line',
            'Shape library: svg-ext-shapes (options.shapeName: rectangle, circle, diamond, triangle, pentagon, star4, arrow, cloud, cylinder, heart, cross, drop, cone, etc.)',
            'Process eng: svg-ext-proceng (options.shapeName: centrifugal, motor, valveax, valvebx, valvecx, tank1, exchheat, exchfilter, exchtube, compfan, nozzle, feeder, agitator-prop, webcam, etc.)',
            'Animated: svg-ext-ape (options.shapeName: eli, piston)',
            'Pipe: type=pipe, options={pipeWidth, contentWidth, content, border}',
            '',
            '=== COMPONENT SELECTION STRATEGY ===',
            'When building UI elements, follow this priority order:',
            '1. PREFER built-in components first: html-button, html-input, html-select, html-chart, html-graph-bar, html-graph-pie, html-bag, gauge-progress, gauge-semaphore, value, pipe, html-slider, html-switch, own_ctrl-table, own_ctrl-iframe, own_ctrl-panel, own_ctrl-scheduler. These are full-featured SCADA/HMI widgets with data binding, animations, and events built in.',
            '2. FALLBACK to basic shapes to compose: If no built-in component fits, use svg-ext-rect, svg-ext-ellipse, svg-ext-text, svg-ext-line, or svg-ext-shapes/shapeName to build the element from primitives. Combine shapes + text for labels, borders, backgrounds, icons.',
            '3. DRAW custom SVG for complex graphics: If the element requires a custom visual that built-in shapes cannot represent (e.g. a stylized pump diagram, custom arrow, flow chart icon, decorative frame), hand-craft an SVG fragment with <path>, <polygon>, <circle>, <rect>, <text> etc. and insert it directly via view_add_gauge with type=svg-ext-svg. This gives full SVG freedom — use d-attribute paths, gradients, transforms, stroke-dasharray, opacity, etc. Example: a custom fan icon as a <path> with a circular arc and blades.',
            '4. USE images for complex visuals: If the element has complex graphical detail that cannot be drawn as SVG (e.g. a company logo, a photorealistic icon, a floor plan photo), use html-image with a URL or generated image path.',
            '5. PLACEHOLDER as last resort: If no image is available and the element cannot be drawn, place a svg-ext-rect as placeholder with a svg-ext-text label inside describing what the element should be (e.g. "LOGO", "SITE PLAN"). Use fill="#333" stroke="#555" for the rect and white text.',
            '',
            '=== ANIMATIONS & DATA BINDING ===',
            'ranges: [{min, max, color, stroke?, text?}] — conditional coloring. E.g. ranges:[{min:0,max:30,color:"#00ff00"},{min:30,max:70,color:"#ffaa00"},{min:70,max:100,color:"#ff0000"}]',
            'actions: [{variableId, type, range?, options?}] — tag-triggered animations.',
            '  blink: options={fillA, fillB, strokeA, strokeB, interval}',
            '  rotate: options={minAngle, maxAngle, delay}',
            '  clockwise/anticlockwise: continuous rotation',
            '  move: options={toX, toY, duration}',
            '  color/hide/show/stop/downup',
            'tagId: bind tag to value slot. view_bind_tag for multiple slots (value, visibility, blink, color, rotate).',
            'events: [{type, action, actparam}] — type=shapes.event-click, action=shapes.event-onsetvalue to write tag on click.',
            '',
            '=== VIEW MANAGEMENT ===',
            'view_create: create new view with name, width, height, bkcolor',
            'view_delete: delete view by id/name (confirmDelete:true)',
            'view_update_property: set name, width, height, bkcolor, type (svg/cards/maps) on a view',
            'view_set_event: set onopen/onclose events, e.g. events:[{type:"shapes.event-onopen",action:"shapes.event-onrunscript",actparam:"MyScript"}]',
            '',
            '=== SCRIPTS ===',
            'script_create: {name, code, mode:"CLIENT"|"SERVER", parameters:[{name,type:"tagid"|"value"}]}',
            'script_update: {script:"name", code:"new code", ...}',
            'script_delete: {script:"name", confirmDelete:true}',
            'script_run: {script:"name"} — run immediately',
            'System functions in scripts: $setTag, $getTag, $setView, $openCard, $enableDevice, $getDeviceProperty, $runServerScript, $getHistoricalTags, $sendMessage, $getAlarms',
            '',
            '=== DATA SOURCE CONFIGURATION ===',
            'Flow: device_add -> device_update_property -> tag_add -> view_update_gauge(tagId)',
            'OPC-UA: device_update_property with {endpoint:"opc.tcp://192.168.1.100:4840"}',
            'Modbus TCP: {address:"192.168.1.100",port:502,unitId:1}',
            'MQTT: {address:"mqtt://broker:1883",clientId:"fuxa",topic:"sensors/#"}',
            'Siemens S7: {address:"192.168.1.100",rack:0,slot:1}',
            'Tag address: OPC-UA "ns=2;s=Temperature", Modbus "40001", MQTT "sensors/temp"'
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
