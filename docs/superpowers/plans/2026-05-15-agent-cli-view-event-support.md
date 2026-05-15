# Agent CLI View/Event Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- []`) syntax for tracking.

**Goal:** Enable FUXA Agent (both web chat panel and CLI) to read and set view sizes, component events, and view-level events.

**Architecture:** Extend existing tools (`view_read`, `view_update_gauge`, `view_set_profile`) with event support, expose view tools to CLI mode via tool-router, add a CLI turn endpoint on the server, and create `fuxa-agent view` CLI commands.

**Tech Stack:** Node.js, Express, SQLite, Socket.IO

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `server/runtime/agent/tools/view.js` | Modify | Enhance redactProperty, view_read, view_update_gauge, view_set_profile |
| `server/runtime/agent/tool-router.js` | Modify | Add viewTools to cli mode |
| `server/runtime/agent/orchestrator.js` | Modify | Add runCliTurn, make _loop mode-aware |
| `server/api/agent/index.js` | Modify | Add POST /api/agent/cli/turn endpoint |
| `app/cli/fuxa-agent/src/commands/view.js` | Create | New `fuxa-agent view` subcommands |
| `app/cli/fuxa-agent/src/cli.js` | Modify | Wire view command into CLI entry |

---

### Task 1: Enhance `redactProperty` to include events and actions

**Files:**
- Modify: `server/runtime/agent/tools/view.js:554-558`

Currently `redactProperty` strips everything except `{text, fill, stroke, fontSize, variableId, bbox, bindings}`. Add `events` and `actions`.

- [ ] **Step 1: Update redactProperty function**

In `server/runtime/agent/tools/view.js`, replace:

```js
function redactProperty(p) {
    if (!p) return null;
    const { text, fill, stroke, fontSize, variableId, bbox, bindings } = p;
    return { text, fill, stroke, fontSize, variableId, bbox, bindings };
}
```

with:

```js
function redactProperty(p) {
    if (!p) return null;
    const { text, fill, stroke, fontSize, variableId, bbox, bindings, events, actions } = p;
    return { text, fill, stroke, fontSize, variableId, bbox, bindings, events: events || [], actions: actions || [] };
}
```

- [ ] **Step 2: Verify manually**

In the server directory, run `node -e "const v = require('./runtime/agent/tools/view'); console.log('loaded ok')"` to confirm no syntax errors.

---

### Task 2: Enhance `view_read` to return viewEvents

**Files:**
- Modify: `server/runtime/agent/tools/view.js:347-365` (view_read executor)

- [ ] **Step 1: Add viewEvents to view_read output**

In the `view_read` executor, change the return object to include `viewEvents`:

```js
'view_read': async (args = {}) => {
    const v = buffer.view;
    const items = Object.values(v.items || {});
    const filtered = args.onlySelection && selection?.ids?.length
        ? items.filter(it => selection.ids.includes(it.id))
        : items;
    return {
        id: v.id,
        name: v.name,
        profile: v.profile,
        selection: selection?.ids || [],
        items: filtered.map(it => ({
            id: it.id,
            type: it.type,
            label: it.label,
            name: it.name,
            property: redactProperty(it.property)
        })),
        viewEvents: (v.property && v.property.events) || []
    };
},
```

- [ ] **Step 2: Update view_read description**

Change the `description` of the `view_read` descriptor (line 187) from:

```js
description: 'Read a compact JSON description of the active view: profile, list of items with id/type/x/y/w/h/name and tag bindings.',
```

to:

```js
description: 'Read a compact JSON description of the active view: profile, list of items with id/type/x/y/w/h/name/tag bindings/events/actions, and view-level events (onopen/onclose).',
```

---

### Task 3: Add `events` parameter to `view_update_gauge`

**Files:**
- Modify: `server/runtime/agent/tools/view.js:228-246` (descriptor) and `view_update_gauge` executor

- [ ] **Step 1: Add events to descriptor schema**

In the `view_update_gauge` descriptor, add to `properties`:

```js
events: {
    type: 'array',
    description: 'Replace all interaction events on this gauge. Each: {type, action, actparam?, actoptions?}.',
    items: {
        type: 'object',
        required: ['type', 'action'],
        properties: {
            type: { type: 'string', enum: [
                'shapes.event-click', 'shapes.event-dblclick',
                'shapes.event-mousedown', 'shapes.event-mouseup',
                'shapes.event-mouseover', 'shapes.event-mouseout',
                'shapes.event-enter', 'shapes.event-select',
                'shapes.event-onLoad'
            ]},
            action: { type: 'string', enum: [
                'shapes.event-onpage', 'shapes.event-onwindow',
                'shapes.event-onopentab', 'shapes.event-ondialog',
                'shapes.event-oniframe', 'shapes.event-oncard',
                'shapes.event-onsetvalue', 'shapes.event-ontogglevalue',
                'shapes.event-onsetinput', 'shapes.event-onclose',
                'shapes.event-onrunscript', 'shapes.event-onViewToPanel',
                'shapes.event-onmonitor'
            ]},
            actparam: { type: 'string' },
            actoptions: { type: 'object' }
        }
    }
},
```

- [ ] **Step 2: Add events handling to executor**

In the `view_update_gauge` executor, after the existing `tagId` handling line (`if (args.tagId !== undefined) it.property.variableId = args.tagId;`), add:

```js
if (args.events !== undefined) {
    it.property.events = args.events;
}
```

---

### Task 4: Add `viewEvents` parameter to `view_set_profile`

**Files:**
- Modify: `server/runtime/agent/tools/view.js:276-286` (descriptor) and `view_set_profile` executor

- [ ] **Step 1: Add viewEvents to descriptor schema**

In the `view_set_profile` descriptor, add to `properties`:

```js
viewEvents: {
    type: 'array',
    description: 'Replace view-level events (onopen/onclose). Each: {type, action, actparam?, actoptions?}.',
    items: {
        type: 'object',
        required: ['type', 'action'],
        properties: {
            type: { type: 'string', enum: ['shapes.event-onopen', 'shapes.event-onclose'] },
            action: { type: 'string', enum: [
                'shapes.event-onpage', 'shapes.event-onwindow',
                'shapes.event-onopentab', 'shapes.event-ondialog',
                'shapes.event-oniframe', 'shapes.event-oncard',
                'shapes.event-onsetvalue', 'shapes.event-ontogglevalue',
                'shapes.event-onsetinput', 'shapes.event-onclose',
                'shapes.event-onrunscript', 'shapes.event-onViewToPanel',
                'shapes.event-onmonitor'
            ]},
            actparam: { type: 'string' },
            actoptions: { type: 'object' }
        }
    }
},
```

- [ ] **Step 2: Add viewEvents handling to executor**

In the `view_set_profile` executor, after the bkcolor line, add:

```js
if (args.viewEvents !== undefined) {
    buffer.view.property = buffer.view.property || {};
    buffer.view.property.events = args.viewEvents;
}
```

Note: the `buffer.dirty = true` line already exists at the end of the executor, so no need to add it again.

- [ ] **Step 3: Update description**

Change `view_set_profile` description from `'Update view profile (size and background color).'` to `'Update view profile (size, background color) and view-level events (onopen/onclose).'`.

---

### Task 5: Add `events` parameter to `view_add_gauge`

**Files:**
- Modify: `server/runtime/agent/tools/view.js` (view_add_gauge descriptor + executor)

Newly created gauges should also be able to have initial events set.

- [ ] **Step 1: Add events to view_add_gauge descriptor**

In the `view_add_gauge` descriptor `properties`, add after `tagId`:

```js
events: {
    type: 'array',
    description: 'Interaction events for this gauge. Each: {type, action, actparam?, actoptions?}.',
    items: {
        type: 'object',
        required: ['type', 'action'],
        properties: {
            type: { type: 'string', enum: [
                'shapes.event-click', 'shapes.event-dblclick',
                'shapes.event-mousedown', 'shapes.event-mouseup',
                'shapes.event-mouseover', 'shapes.event-mouseout',
                'shapes.event-enter', 'shapes.event-select',
                'shapes.event-onLoad'
            ]},
            action: { type: 'string', enum: [
                'shapes.event-onpage', 'shapes.event-onwindow',
                'shapes.event-onopentab', 'shapes.event-ondialog',
                'shapes.event-oniframe', 'shapes.event-oncard',
                'shapes.event-onsetvalue', 'shapes.event-ontogglevalue',
                'shapes.event-onsetinput', 'shapes.event-onclose',
                'shapes.event-onrunscript', 'shapes.event-onViewToPanel',
                'shapes.event-onmonitor'
            ]},
            actparam: { type: 'string' },
            actoptions: { type: 'object' }
        }
    }
},
```

- [ ] **Step 2: Add events to view_add_gauge executor**

In the `view_add_gauge` executor, change the `item` object construction. After `bbox: { x: args.x, y: args.y, w: args.w, h: args.h }`, add the events:

```js
const item = {
    id: svgId,
    name: args.name || svgId,
    type: args.type,
    label: args.type,
    hide: false,
    lock: false,
    property: {
        text: args.text || '',
        fill: args.fill,
        stroke: args.stroke,
        fontSize: args.fontSize,
        variableId: args.tagId || null,
        bbox: { x: args.x, y: args.y, w: args.w, h: args.h },
        events: args.events || []
    }
};
```

---

### Task 6: Add viewTools to CLI mode in tool-router

**Files:**
- Modify: `server/runtime/agent/tool-router.js:19-22`

- [ ] **Step 1: Update MODE_TOOLS**

Change:

```js
const MODE_TOOLS = {
    web: [viewTools, deviceTools, projectTools],
    cli: [deviceTools, projectTools]
};
```

to:

```js
const MODE_TOOLS = {
    web: [viewTools, deviceTools, projectTools],
    cli: [viewTools, deviceTools, projectTools]
};
```

- [ ] **Step 2: Verify**

Run: `node -e "const r = require('./server/runtime/agent/tool-router'); console.log('cli tools:', r.buildDescriptors('cli', {}).map(t=>t.name).join(', '))"` from project root.

Expected: output includes `view_read`, `view_add_gauge`, `view_update_gauge`, `view_set_profile` etc.

---

### Task 7: Make orchestrator `_loop` mode-aware

**Files:**
- Modify: `server/runtime/agent/orchestrator.js:94-117` (_loop method)

- [ ] **Step 1: Add mode parameter to _loop**

Change `_loop` signature from:

```js
async _loop({ cfg, viewId, userText, attachments, selection, sessionId }) {
```

to:

```js
async _loop({ cfg, viewId, userText, attachments, selection, sessionId, mode }) {
```

- [ ] **Step 2: Use mode in tool building**

Change line 110:

```js
const tools = toolRouter.buildDescriptors('web', { runtime: this.runtime });
```

to:

```js
const toolMode = mode || 'web';
const tools = toolRouter.buildDescriptors(toolMode, { runtime: this.runtime });
```

And change line 111:

```js
const exec = toolRouter.buildExecutors('web', {
```

to:

```js
const exec = toolRouter.buildExecutors(toolMode, {
```

- [ ] **Step 3: Pass mode from runWebTurn**

In `runWebTurn` (line 71), change the `_loop` call to include `mode: 'web'`:

```js
const result = await this._loop({ cfg, viewId, userText, attachments, selection, sessionId: sid, mode: 'web' });
```

---

### Task 8: Add `runCliTurn` method to orchestrator

**Files:**
- Modify: `server/runtime/agent/orchestrator.js` (add after `runWebTurn`)

- [ ] **Step 1: Add runCliTurn method**

Insert after the `runWebTurn` method (after line 92):

```js
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
```

Key difference from `runWebTurn`: no socket.io event emission (`_emit` calls), since CLI has no socket connection.

---

### Task 9: Add CLI turn endpoint to server API

**Files:**
- Modify: `server/api/agent/index.js` (add before `return app;` on line 253)

- [ ] **Step 1: Add POST /api/agent/cli/turn endpoint**

Insert before `return app;`:

```js
// POST one-shot CLI turn (no socket.io streaming).
app.post('/api/agent/cli/turn', secureFnc, async function (req, res) {
    if (!requireEditorOrAdmin(req, res)) return;
    const { viewId, text, sessionId } = req.body || {};
    if (!viewId || !text) {
        return res.status(400).json({ error: 'missing_params', message: 'viewId and text are required' });
    }
    try {
        const result = await runtime.agentMgr.getOrchestrator().runCliTurn({
            viewId, userText: text, sessionId
        });
        res.json(result);
    } catch (err) {
        runtime.logger?.error?.(`api agent.cli.turn: ${err}`);
        res.status(400).json({
            error: err.code || 'cli_turn_failed',
            message: String(err?.message || err)
        });
    }
});
```

---

### Task 10: Create CLI `view` command module

**Files:**
- Create: `app/cli/fuxa-agent/src/commands/view.js`

- [ ] **Step 1: Create view.js with ls, show, resize, ask subcommands**

```js
/**
 * `fuxa-agent view` — View management commands.
 *
 *   fuxa-agent view ls                           List all views
 *   fuxa-agent view show <name>                  Show view details (items, events)
 *   fuxa-agent view resize <name> --width W --height H
 *   fuxa-agent view ask <name> "natural language"  Agent turn on a view
 */
'use strict';

const config = require('../config');
const { AgentClient } = require('../client');

module.exports = async function view({ positional, flags }) {
    const cfg = config.read();
    const client = new AgentClient(cfg);
    const subcmd = positional[0];
    const viewName = positional[1];

    if (!subcmd || subcmd === 'help') {
        console.log(`Usage:
  fuxa-agent view ls                         List all views
  fuxa-agent view show <name>                Show view details
  fuxa-agent view resize <name> --width N --height N
  fuxa-agent view ask <name> "description"   Agent natural-language turn`);
        return;
    }

    // Fetch project to resolve view name → id.
    const projectRes = await client.get('/api/project');
    const views = (projectRes.data?.hmi && projectRes.data.hmi.views) || [];

    if (subcmd === 'ls') {
        for (const v of views) {
            const profile = v.profile || {};
            console.log(`${v.name || '(unnamed)'}  id=${v.id}  ${profile.width||'?'}x${profile.height||'?'}  items=${Object.keys(v.items||{}).length}`);
        }
        return;
    }

    if (!viewName) {
        throw new Error(`${subcmd} requires a view name`);
    }

    const view = views.find(v => v.name === viewName || v.id === viewName);
    if (!view) {
        throw new Error(`view not found: ${viewName}`);
    }

    if (subcmd === 'show') {
        // Use agent CLI turn to get structured read.
        try {
            const r = await client.post('/api/agent/cli/turn', {
                viewId: view.id,
                text: 'Read this view and return its full structure including all component events and view events.'
            });
            if (r.data?.text) {
                console.log(r.data.text);
            }
            // Also output raw tool results for machine consumption.
            const toolResults = (r.data?.trace || [])
                .filter(t => t.kind === 'tool' && t.name === 'view_read')
                .map(t => t.result);
            if (toolResults.length && flags.json) {
                console.log(JSON.stringify(toolResults[toolResults.length - 1], null, 2));
            }
        } catch (err) {
            // Fallback: dump raw project data if agent turn fails.
            console.log(JSON.stringify({
                id: view.id,
                name: view.name,
                profile: view.profile,
                items: Object.keys(view.items || {}).length + ' items'
            }, null, 2));
        }
        return;
    }

    if (subcmd === 'resize') {
        const width = parseInt(flags.width, 10);
        const height = parseInt(flags.height, 10);
        if (!width || !height) {
            throw new Error('resize requires --width and --height');
        }
        const r = await client.post('/api/agent/cli/turn', {
            viewId: view.id,
            text: `Resize this view to ${width}x${height} pixels.`
        });
        console.log(r.data?.text || 'done');
        return;
    }

    if (subcmd === 'ask') {
        const description = positional.slice(2).join(' ').trim();
        if (!description) {
            throw new Error('ask requires a description');
        }
        const r = await client.post('/api/agent/cli/turn', {
            viewId: view.id,
            text: description
        });
        console.log(r.data?.text || '');
        if (r.data?.trace) {
            for (const step of r.data.trace) {
                if (step.kind === 'tool') {
                    console.log(`  [tool] ${step.name}: ${JSON.stringify(step.result).slice(0, 200)}`);
                }
            }
        }
        return;
    }

    throw new Error(`unknown view subcommand: ${subcmd}`);
};
```

---

### Task 11: Wire view command into CLI entry

**Files:**
- Modify: `app/cli/fuxa-agent/src/cli.js`

- [ ] **Step 1: Add view to COMMANDS**

Change line 15-21 from:

```js
const COMMANDS = {
    login:   require('./commands/login'),
    doctor:  require('./commands/doctor'),
    connect: require('./commands/connect'),
    device:  require('./commands/device'),
    tags:    require('./commands/tags')
};
```

to:

```js
const COMMANDS = {
    login:   require('./commands/login'),
    doctor:  require('./commands/doctor'),
    connect: require('./commands/connect'),
    device:  require('./commands/device'),
    tags:    require('./commands/tags'),
    view:    require('./commands/view')
};
```

- [ ] **Step 2: Update help text**

Change the help function (line 49-63) to include view commands:

```js
function help() {
    console.log(`fuxa-agent — natural-language device & tag provisioning for FUXA

Usage:
  fuxa-agent login   --server <url> --apikey <key>
  fuxa-agent doctor
  fuxa-agent connect "<natural-language description>"
                     [--dry-run] [--yes] [--file plan.yaml]
  fuxa-agent device  ls | show <name> | rm <name>
  fuxa-agent tags    ls --device <name>
  fuxa-agent view    ls | show <name> [--json] | resize <name> --width N --height N | ask <name> "description"

Configuration is stored at ~/.fuxa-agent/config.json.
Environment overrides:  FUXA_AGENT_SERVER, FUXA_AGENT_APIKEY.
`);
}
```

---

### Task 12: Manual verification

- [ ] **Step 1: Start the server**

```bash
cd D:/work/self/FUXA/server && node main.js
```

Expected: server starts on port 1881.

- [ ] **Step 2: Test view_read with events via curl**

```bash
curl -X POST http://127.0.0.1:1881/api/agent/cli/turn \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-api-key>" \
  -d '{"viewId": "<any-view-id>", "text": "read this view"}'
```

Expected: JSON response with view data including `viewEvents` array and items with `events`/`actions` arrays.

- [ ] **Step 3: Test CLI view ls**

```bash
cd D:/work/self/FUXA/app/cli/fuxa-agent && node src/cli.js view ls
```

Expected: list of views with names, ids, dimensions, item counts.

- [ ] **Step 4: Test CLI view show**

```bash
node src/cli.js view show <view-name>
```

Expected: structured view output including events.

- [ ] **Step 5: Test CLI view resize**

```bash
node src/cli.js view resize <view-name> --width 1920 --height 1080
```

Expected: success confirmation.

---

### Task 13: Commit

- [ ] **Step 1: Stage and commit all changes**

```bash
git add server/runtime/agent/tools/view.js \
        server/runtime/agent/tool-router.js \
        server/runtime/agent/orchestrator.js \
        server/api/agent/index.js \
        app/cli/fuxa-agent/src/commands/view.js \
        app/cli/fuxa-agent/src/cli.js \
        docs/superpowers/specs/2026-05-15-agent-cli-view-event-support-design.md \
        docs/superpowers/plans/2026-05-15-agent-cli-view-event-support.md

git commit -m "feat(agent): add view/event read/write for web and CLI modes

- view_read now returns events, actions, and viewEvents
- view_update_gauge accepts events parameter for component event CRUD
- view_set_profile accepts viewEvents parameter for view-level events
- CLI mode now includes all view tools
- New runCliTurn orchestrator method (no socket.io)
- New POST /api/agent/cli/turn endpoint
- New fuxa-agent view ls/show/resize/ask CLI commands"
```
