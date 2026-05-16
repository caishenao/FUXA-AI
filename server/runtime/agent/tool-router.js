/**
 * Tool router.
 * - Aggregates descriptors from all enabled tool packs (built-in + Skills).
 * - Validates arguments with a minimal JSON-schema subset (no extra deps).
 * - Dispatches calls to the matching executor.
 *
 * Skill tools are namespaced as "<skillSlug>.<toolName>" to avoid collisions
 * with the built-in view.* / device.* tools. SkillManager exposes
 * runtime.agentMgr.getSkillManager().getToolPacks() returning an array of
 * { slug, descriptors(), executors(ctx) } objects with a single descriptors()
 * call already returning namespaced names.
 */
'use strict';

const viewTools = require('./tools/view');
const deviceTools = require('./tools/device');
const projectTools = require('./tools/project');
const designImportTools = require('./tools/design-import');

const MODE_TOOLS = {
    web: [viewTools, deviceTools, projectTools, designImportTools],
    cli: [viewTools, deviceTools, projectTools, designImportTools]
};

function _skillPacks(ctx) {
    try {
        const mgr = ctx?.runtime?.agentMgr?.getSkillManager?.();
        if (!mgr || typeof mgr.getToolPacks !== 'function') return [];
        return mgr.getToolPacks() || [];
    } catch (_) {
        return [];
    }
}

function buildDescriptors(mode, ctx) {
    const packs = MODE_TOOLS[mode] || [];
    const builtIn = packs.flatMap(p => p.descriptors());
    const skill = _skillPacks(ctx).flatMap(p => {
        try { return p.descriptors() || []; } catch (_) { return []; }
    });
    return builtIn.concat(skill);
}

function buildExecutors(mode, ctx) {
    const packs = MODE_TOOLS[mode] || [];
    const builtIn = Object.assign({}, ...packs.map(p => p.executors(ctx)));
    const skill = Object.assign({}, ..._skillPacks(ctx).map(p => {
        try { return p.executors(ctx) || {}; } catch (_) { return {}; }
    }));
    return Object.assign({}, builtIn, skill);
}

/** Tiny ajv-free validator: enough for our locked-down schemas. */
function validate(schema, value) {
    const errs = [];
    _walk(schema, value, '$', errs);
    return errs;
}

function _walk(schema, v, p, errs) {
    if (!schema) return;
    if (schema.type === 'object') {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
            errs.push(`${p}: expected object`);
            return;
        }
        for (const r of schema.required || []) {
            if (!(r in v)) errs.push(`${p}.${r}: required`);
        }
        for (const k of Object.keys(schema.properties || {})) {
            if (k in v) _walk(schema.properties[k], v[k], `${p}.${k}`, errs);
        }
    } else if (schema.type === 'array') {
        if (!Array.isArray(v)) { errs.push(`${p}: expected array`); return; }
        if (schema.items) v.forEach((x, i) => _walk(schema.items, x, `${p}[${i}]`, errs));
    } else if (schema.type === 'string') {
        if (typeof v !== 'string') { errs.push(`${p}: expected string`); return; }
        if (schema.maxLength !== undefined && v.length > schema.maxLength) errs.push(`${p}: too long`);
        if (schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(`${p}: pattern mismatch`);
        if (schema.enum && !schema.enum.includes(v)) errs.push(`${p}: not in enum`);
    } else if (schema.type === 'number') {
        if (typeof v !== 'number' || Number.isNaN(v)) { errs.push(`${p}: expected number`); return; }
        if (schema.minimum !== undefined && v < schema.minimum) errs.push(`${p}: < minimum`);
        if (schema.maximum !== undefined && v > schema.maximum) errs.push(`${p}: > maximum`);
    } else if (schema.type === 'boolean') {
        if (typeof v !== 'boolean') errs.push(`${p}: expected boolean`);
        if (schema.enum && !schema.enum.includes(v)) errs.push(`${p}: not in enum`);
    }
}

module.exports = { buildDescriptors, buildExecutors, validate };
