/**
 * Skill manifest schema + validator.
 *
 * Four kinds:
 *   tool-pack   — JS module exporting { descriptors(), executors(ctx) } that
 *                 the agent registers as namespaced LLM tools.
 *   asset-pack  — JSON registry of view/gauge templates the agent can apply
 *                 via view.list_templates / view.apply_template.
 *   mcp-bridge  — placeholder for MCP-over-stdio bridges (Phase 4 wiring).
 *   instruction-pack — static prompt/instruction snippets injected into the
 *                 agent system prompt.
 *
 * Manifest file: skill.json at the skill root.
 *   {
 *     "name": "MQTT Pack",
 *     "slug": "mqtt-pack",          // namespace prefix; [a-z0-9-]+
 *     "version": "0.1.0",
 *     "kind": "tool-pack",
 *     "main": "index.js",           // tool-pack only
 *     "templates": "templates.json",// asset-pack only
 *     "description": "...",
 *     "author": "...",
 *     "permissions": []             // reserved for Phase 3
 *   }
 */
'use strict';

const KINDS = ['tool-pack', 'asset-pack', 'mcp-bridge', 'instruction-pack'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const VER_RE = /^\d+\.\d+\.\d+([.-][\w.-]+)?$/;

function validate(m) {
    const errs = [];
    if (!m || typeof m !== 'object') return ['manifest: not an object'];
    if (!m.name || typeof m.name !== 'string') errs.push('name: required string');
    if (!m.slug || typeof m.slug !== 'string') errs.push('slug: required string');
    else if (!SLUG_RE.test(m.slug)) errs.push('slug: must match ' + SLUG_RE);
    if (!m.version || typeof m.version !== 'string') errs.push('version: required string');
    else if (!VER_RE.test(m.version)) errs.push('version: must match semver-ish');
    if (!m.kind || !KINDS.includes(m.kind)) errs.push('kind: must be one of ' + KINDS.join('|'));
    if (m.kind === 'tool-pack' && (!m.main || typeof m.main !== 'string')) {
        errs.push('main: required for tool-pack');
    }
    if (m.kind === 'asset-pack' && (!m.templates || typeof m.templates !== 'string')) {
        errs.push('templates: required for asset-pack');
    }
    if (m.kind === 'instruction-pack' && (!m.instructions || typeof m.instructions !== 'string')) {
        errs.push('instructions: required for instruction-pack');
    }
    return errs;
}

module.exports = { validate, KINDS };
