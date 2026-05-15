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
