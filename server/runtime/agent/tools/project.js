/**
 * Project-level tools: view list/create/delete, script list/run/create/update/delete,
 * alarm list, view events.
 *
 * These tools let the agent manage views, scripts, alarms, and other
 * project-wide resources beyond individual gauge editing.
 */
'use strict';

function genId(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

function descriptors() {
    return [
        {
            name: 'view_list',
            description: 'List all views in the project with id, name, and item count.',
            input_schema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Optional substring filter on view name.' }
                }
            }
        },
        {
            name: 'view_create',
            description: 'Create a new empty view with given name and optional profile (width, height, bkcolor).',
            input_schema: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: { type: 'string', maxLength: 64 },
                    width: { type: 'number', minimum: 100, maximum: 8192 },
                    height: { type: 'number', minimum: 100, maximum: 8192 },
                    bkcolor: { type: 'string', pattern: '^#[0-9A-Fa-f]{6,8}$' }
                }
            }
        },
        {
            name: 'view_delete',
            description: 'Delete a view by id or name. confirmDelete must be true.',
            input_schema: {
                type: 'object',
                required: ['view', 'confirmDelete'],
                properties: {
                    view: { type: 'string', description: 'View id or name.' },
                    confirmDelete: { type: 'boolean', enum: [true] }
                }
            }
        },
        {
            name: 'script_list',
            description: 'List all scripts in the project with id, name, mode, and scheduling info.',
            input_schema: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'script_run',
            description: 'Run a script by name. The script must already exist in the project.',
            input_schema: {
                type: 'object',
                required: ['script'],
                properties: {
                    script: { type: 'string', description: 'Script name.' },
                    logOutput: { type: 'boolean', description: 'Whether to emit log events (default true).' }
                }
            }
        },
        {
            name: 'alarm_list',
            description: 'List all alarm definitions in the project.',
            input_schema: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'script_create',
            description: 'Create a new script. Scripts can be CLIENT (runs in browser) or SERVER (runs on server).',
            input_schema: {
                type: 'object',
                required: ['name', 'code'],
                properties: {
                    name: { type: 'string', maxLength: 64, description: 'Script name (must be unique).' },
                    code: { type: 'string', description: 'JavaScript code body.' },
                    mode: { type: 'string', enum: ['CLIENT', 'SERVER'], default: 'CLIENT' },
                    parameters: {
                        type: 'array',
                        description: 'Script parameters (tagid, value, chart).',
                        items: {
                            type: 'object',
                            required: ['name', 'type'],
                            properties: {
                                name: { type: 'string' },
                                type: { type: 'string', enum: ['tagid', 'value', 'chart'] },
                                value: { type: 'string' }
                            }
                        }
                    }
                }
            }
        },
        {
            name: 'script_update',
            description: 'Update an existing script (code, name, mode, parameters).',
            input_schema: {
                type: 'object',
                required: ['script'],
                properties: {
                    script: { type: 'string', description: 'Current script name or id.' },
                    name: { type: 'string', maxLength: 64 },
                    code: { type: 'string' },
                    mode: { type: 'string', enum: ['CLIENT', 'SERVER'] },
                    parameters: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['name', 'type'],
                            properties: {
                                name: { type: 'string' },
                                type: { type: 'string', enum: ['tagid', 'value', 'chart'] },
                                value: { type: 'string' }
                            }
                        }
                    }
                }
            }
        },
        {
            name: 'script_delete',
            description: 'Delete a script by name or id. confirmDelete must be true.',
            input_schema: {
                type: 'object',
                required: ['script', 'confirmDelete'],
                properties: {
                    script: { type: 'string' },
                    confirmDelete: { type: 'boolean', enum: [true] }
                }
            }
        },
        {
            name: 'view_set_event',
            description: 'Set view-level events (onopen, onclose) to trigger scripts or actions when a view opens/closes.',
            input_schema: {
                type: 'object',
                required: ['view', 'events'],
                properties: {
                    view: { type: 'string', description: 'View id or name. Use "current" for the active view.' },
                    events: {
                        type: 'array',
                        description: 'Replace all events on this view. Each: {type, action, actparam}.',
                        items: {
                            type: 'object',
                            required: ['type', 'action'],
                            properties: {
                                type: { type: 'string', enum: ['shapes.event-onopen', 'shapes.event-onclose'] },
                                action: { type: 'string', enum: ['shapes.event-onrunscript'] },
                                actparam: { type: 'string', description: 'Script name for onrunscript action.' },
                                actoptions: { type: 'object' }
                            }
                        }
                    }
                }
            }
        },
        {
            name: 'view_update_property',
            description: 'Update view properties: name, profile (width, height, bkcolor), type, layout settings.',
            input_schema: {
                type: 'object',
                required: ['view'],
                properties: {
                    view: { type: 'string', description: 'View id or name. Use "current" for the active view.' },
                    name: { type: 'string', maxLength: 64 },
                    width: { type: 'number', minimum: 100, maximum: 8192 },
                    height: { type: 'number', minimum: 100, maximum: 8192 },
                    bkcolor: { type: 'string', pattern: '^#[0-9A-Fa-f]{6,8}$' },
                    type: { type: 'string', enum: ['svg', 'cards', 'maps'] }
                }
            }
        },
        {
            name: 'view_switch',
            description: 'Switch the active view. Commits any pending changes to the current view, then loads the target view as the new active view. After switching, all subsequent view_read, view_add_gauge, view_update_gauge, etc. operate on the new view.',
            input_schema: {
                type: 'object',
                required: ['view'],
                properties: {
                    view: { type: 'string', description: 'Target view id or name to switch to.' }
                }
            }
        }
    ];
}

function executors(ctx) {
    const { runtime, buffer, logger } = ctx;

    return {
        'view_list': async (args = {}) => {
            const views = [];
            const project = runtime?.project;
            if (!project) return [];
            // Use getView for each view — iterate via getDevices trick.
            // Actually we need view list from project data. Use getView won't iterate.
            // Use getProject is Promise, so let's use a different approach.
            // Check if there's a sync way to get all views.
            // data.hmi.views is the array but not directly accessible.
            // Fallback: use the getView approach won't work for listing.
            // We'll read from runtime.project data via getDevices pattern.
            try {
                // Try to access views list. We don't have a sync getAllViews,
                // but the orchestrator loaded the view for the session already.
                // For listing, we need to access the raw data.
                // Let's try an alternative: the runtime keeps project data in memory.
                // Unfortunately there's no getViews() sync function.
                // We'll use getProject() with await - but executors are async anyway.
                const data = await project.getProject();
                const hmiViews = (data?.hmi?.views) || [];
                const q = (args.query || '').toLowerCase();
                for (const v of hmiViews) {
                    if (q && !(v.name || '').toLowerCase().includes(q) && !(v.id || '').toLowerCase().includes(q)) continue;
                    views.push({
                        id: v.id,
                        name: v.name,
                        itemsCount: Object.keys(v.items || {}).length
                    });
                }
            } catch (_) { /* defensive */ }
            return views;
        },
        'view_create': async (args) => {
            const view = {
                id: genId('v'),
                name: args.name || genId('view'),
                items: {},
                profile: {
                    width: args.width || 800,
                    height: args.height || 600,
                    bkcolor: args.bkcolor || '#FFFFFFFF'
                }
            };
            // Use project.setProjectData to persist.
            const project = runtime?.project;
            if (!project) return { error: 'no_project' };
            try {
                const cmds = project.ProjectDataCmdType || {};
                if (typeof project.setProjectData === 'function') {
                    await project.setProjectData(cmds.SetView || 'set-view', view);
                } else if (typeof project.setView === 'function') {
                    await project.setView(view);
                }
                return { ok: true, id: view.id, name: view.name };
            } catch (err) {
                return { error: 'create_failed', message: String(err?.message || err) };
            }
        },
        'view_delete': async (args) => {
            if (args.confirmDelete !== true) return { error: 'confirm_required' };
            const project = runtime?.project;
            if (!project) return { error: 'no_project' };
            try {
                const data = await project.getProject();
                const views = data?.hmi?.views || [];
                const view = views.find(v => v.id === args.view || v.name === args.view);
                if (!view) return { error: 'view_not_found', view: args.view };
                const cmds = project.ProjectDataCmdType || {};
                if (typeof project.setProjectData === 'function') {
                    await project.setProjectData(cmds.DelView || 'del-view', { id: view.id, name: view.name });
                }
                return { ok: true, deleted: view.name };
            } catch (err) {
                return { error: 'delete_failed', message: String(err?.message || err) };
            }
        },
        'script_list': async () => {
            const scripts = runtime?.project?.getScripts?.() || [];
            return scripts.map(s => ({
                id: s.id,
                name: s.name,
                mode: s.mode,
                scheduling: s.scheduling ? { mode: s.scheduling.mode, interval: s.scheduling.interval } : null
            }));
        },
        'script_run': async (args) => {
            const scripts = runtime?.project?.getScripts?.() || [];
            const script = scripts.find(s => s.name === args.script);
            if (!script) return { error: 'script_not_found', script: args.script };
            try {
                if (typeof runtime?.scriptsMgr?.runScript !== 'function') {
                    return { error: 'scripts_manager_not_available' };
                }
                const result = await runtime.scriptsMgr.runScript(script, args.logOutput !== false);
                return { ok: true, script: args.script, result };
            } catch (err) {
                return { error: 'run_failed', message: String(err?.message || err) };
            }
        },
        'alarm_list': async () => {
            const alarms = runtime?.project?.getAlarms?.() || [];
            return alarms.map(a => ({
                name: a.name,
                type: a.type,
                condition: a.condition,
                enabled: a.enabled
            }));
        },
        'script_create': async (args) => {
            const project = runtime?.project;
            if (!project) return { error: 'no_project' };
            const scripts = project.getScripts?.() || [];
            const existing = scripts.find(s => s.name === args.name);
            if (existing) return { error: 'script_exists', name: args.name };
            const script = {
                id: genId('scr'),
                name: args.name,
                code: args.code || '',
                mode: args.mode || 'CLIENT',
                parameters: args.parameters || [],
                scheduling: null,
                sync: true
            };
            try {
                const cmds = project.ProjectDataCmdType || {};
                const updated = [...scripts.map(s => ({ ...s })), script];
                if (typeof project.setProjectData === 'function') {
                    await project.setProjectData(cmds.SetScripts || 'set-scripts', updated);
                }
                return { ok: true, id: script.id, name: script.name, mode: script.mode };
            } catch (err) {
                return { error: 'create_failed', message: String(err?.message || err) };
            }
        },
        'script_update': async (args) => {
            const project = runtime?.project;
            if (!project) return { error: 'no_project' };
            const scripts = project.getScripts?.() || [];
            const idx = scripts.findIndex(s => s.name === args.script || s.id === args.script);
            if (idx < 0) return { error: 'script_not_found', script: args.script };
            const updated = scripts.map(s => ({ ...s }));
            const target = updated[idx];
            if (args.name !== undefined) target.name = args.name;
            if (args.code !== undefined) target.code = args.code;
            if (args.mode !== undefined) target.mode = args.mode;
            if (args.parameters !== undefined) target.parameters = args.parameters;
            try {
                const cmds = project.ProjectDataCmdType || {};
                if (typeof project.setProjectData === 'function') {
                    await project.setProjectData(cmds.SetScripts || 'set-scripts', updated);
                }
                return { ok: true, id: target.id, name: target.name };
            } catch (err) {
                return { error: 'update_failed', message: String(err?.message || err) };
            }
        },
        'script_delete': async (args) => {
            if (args.confirmDelete !== true) return { error: 'confirm_required' };
            const project = runtime?.project;
            if (!project) return { error: 'no_project' };
            const scripts = project.getScripts?.() || [];
            const target = scripts.find(s => s.name === args.script || s.id === args.script);
            if (!target) return { error: 'script_not_found', script: args.script };
            try {
                const cmds = project.ProjectDataCmdType || {};
                const updated = scripts.filter(s => s.id !== target.id);
                if (typeof project.setProjectData === 'function') {
                    await project.setProjectData(cmds.SetScripts || 'set-scripts', updated);
                }
                return { ok: true, deleted: target.name };
            } catch (err) {
                return { error: 'delete_failed', message: String(err?.message || err) };
            }
        },
        'view_set_event': async (args) => {
            const project = runtime?.project;
            if (!project) return { error: 'no_project' };
            let view;
            try {
                if (args.view === 'current') {
                    view = buffer.view;
                } else {
                    const data = await project.getProject();
                    const views = data?.hmi?.views || [];
                    view = views.find(v => v.id === args.view || v.name === args.view);
                }
            } catch (_) { /* defensive */ }
            if (!view) return { error: 'view_not_found', view: args.view };
            view.property = view.property || {};
            view.property.events = args.events || [];
            // If using current view, mark buffer dirty
            if (args.view === 'current') {
                buffer.dirty = true;
            } else {
                try {
                    const cmds = project.ProjectDataCmdType || {};
                    if (typeof project.setProjectData === 'function') {
                        await project.setProjectData(cmds.SetView || 'set-view', view);
                    }
                } catch (err) {
                    return { error: 'save_failed', message: String(err?.message || err) };
                }
            }
            return { ok: true, view: view.name || view.id, events: view.property.events };
        },
        'view_update_property': async (args) => {
            const project = runtime?.project;
            if (!project) return { error: 'no_project' };
            let view;
            try {
                if (args.view === 'current') {
                    view = buffer.view;
                } else {
                    const data = await project.getProject();
                    const views = data?.hmi?.views || [];
                    view = views.find(v => v.id === args.view || v.name === args.view);
                }
            } catch (_) { /* defensive */ }
            if (!view) return { error: 'view_not_found', view: args.view };
            if (args.name !== undefined) view.name = args.name;
            if (args.width !== undefined) { view.profile = view.profile || {}; view.profile.width = args.width; }
            if (args.height !== undefined) { view.profile = view.profile || {}; view.profile.height = args.height; }
            if (args.bkcolor !== undefined) { view.profile = view.profile || {}; view.profile.bkcolor = args.bkcolor; }
            if (args.type !== undefined) view.type = args.type;
            if (args.view === 'current') {
                buffer.dirty = true;
            } else {
                try {
                    const cmds = project.ProjectDataCmdType || {};
                    if (typeof project.setProjectData === 'function') {
                        await project.setProjectData(cmds.SetView || 'set-view', view);
                    }
                } catch (err) {
                    return { error: 'save_failed', message: String(err?.message || err) };
                }
            }
            return { ok: true, view: view.name || view.id, profile: view.profile };
        },
        'view_switch': async (args) => {
            const project = runtime?.project;
            if (!project) return { error: 'no_project' };
            let target;
            try {
                const data = await project.getProject();
                const views = data?.hmi?.views || [];
                target = views.find(v => v.id === args.view || v.name === args.view);
            } catch (_) { /* defensive */ }
            if (!target) return { error: 'view_not_found', view: args.view };
            // Signal the orchestrator to switch after this tool call returns.
            buffer.switchTo = target.id;
            return { ok: true, switchedTo: target.id, name: target.name, itemsCount: Object.keys(target.items || {}).length };
        }
    };
}

module.exports = { descriptors, executors };
