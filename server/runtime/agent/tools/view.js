/**
 * View tools: exposed to the LLM as function/tool calls.
 *
 * Tools mutate a per-turn ChangeBuffer; the orchestrator commits the buffer
 * once at the end of the turn through runtime.project.setProjectData.
 * That gives us atomic transactions plus a one-step undo (snapshot kept
 * inside ChangeBuffer.beforeSnapshot).
 *
 * Selection awareness:
 *   When the user has elements selected on the canvas, ctx.selection.ids
 *   carries the gauge ids. update/delete/bind tools default their target
 *   to that list if the model omits an explicit id, which prevents the
 *   "agent edits the wrong thing" failure mode in Phase 2.
 */
'use strict';

function genId(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

// ---- SVG generation helpers ----

const ID_PREFIX = {
    'svg-ext-rect': 'SHE_',
    'svg-ext-ellipse': 'SHE_',
    'svg-ext-text': 'svg_',
    'svg-ext-line': 'svg_',
    'html-button': 'HXB_',
    'html-input': 'HXB_',
    'html-select': 'HXB_',
    'html-image': 'HXB_',
    'value': 'VAL_',
    'gauge-progress': 'GXP_',
    'gauge-semaphore': 'GSE_'
};

function _gaugeSvgId(type) {
    const pfx = ID_PREFIX[type] || 'svg_';
    return pfx + Math.random().toString(36).slice(2, 10);
}

function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build an SVG fragment for a newly added gauge.
 * Returns { id, svg } where id is the SVG element id and svg is the markup string.
 */
function buildSvg(type, x, y, w, h, fill, stroke, fontSize, text, options) {
    const f = fill || '#1565c0';
    const s = stroke || '#0D47A1';
    const fs = fontSize || 14;
    const id = _gaugeSvgId(type);

    switch (type) {
        case 'svg-ext-rect': {
            return { id, svg:
                `<g id="${id}" type="svg-ext-shapes-rectangle" fill="${f}" stroke="${s}" font-size="${fs}" font-family="sans-serif" text-anchor="middle" transform="translate(${x},${y})">` +
                `<rect id="${id}" width="${w}" height="${h}"/>` +
                `</g>` };
        }
        case 'svg-ext-ellipse': {
            const rx = w / 2, ry = h / 2;
            return { id, svg:
                `<g id="${id}" type="svg-ext-shapes-circle" fill="${f}" stroke="${s}" font-size="${fs}" font-family="sans-serif" text-anchor="middle" transform="translate(${x},${y})">` +
                `<ellipse id="${id}" cx="${rx}" cy="${ry}" rx="${rx}" ry="${ry}"/>` +
                `</g>` };
        }
        case 'svg-ext-text': {
            return { id, svg:
                `<text xml:space="preserve" text-anchor="middle" font-family="sans-serif" font-size="${fs}" id="${id}" y="${y + fs}" x="${x + w / 2}" stroke-width="0" stroke="${s}" fill="${f}">${_esc(text || 'Text')}</text>` };
        }
        case 'svg-ext-line': {
            return { id, svg:
                `<line fill="none" stroke="${s}" x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" stroke-width="2" id="${id}"/>` };
        }
        case 'value': {
            return { id, svg:
                `<g id="${id}" type="svg-ext-value" fill="${f}" stroke="${s}" font-size="${fs}" stroke-width="0" font-family="sans-serif" text-anchor="middle">` +
                `<text stroke-width="0" id="${id}" fill="${f}" stroke="${s}" font-size="${fs}" font-family="sans-serif" text-anchor="middle" xml:space="preserve" x="${x + w / 2}" y="${y + fs}">${_esc(text || '##.##')}</text>` +
                `</g>` };
        }
        case 'html-button': {
            const btnId = 'B-' + id;
            const foId = 'H-' + id;
            const bgId = 'svg_' + Math.random().toString(36).slice(2, 10);
            return { id, svg:
                `<g type="svg-ext-html_button" id="${id}" style="pointer-events:none" fill="rgba(0,0,0,0)" stroke="rgba(0,0,0,0)" xml:space="preserve">` +
                `<rect x="${x}" y="${y}" width="${w}" height="${h}" stroke-width="0" id="${bgId}"/>` +
                `<foreignObject x="${x}" y="${y}" height="${h}" width="${w}" id="${foId}">` +
                `<button id="${btnId}" class="md-btn md-btn-raised" style="width:calc(100% - 6px);height:calc(100% - 6px);text-align:center;background-color:${f};color:${s};font-size:${fs}px;font-family:sans-serif;">${_esc(text || '')}</button>` +
                `</foreignObject>` +
                `</g>` };
        }
        case 'gauge-progress': {
            const aId = 'A-' + id;
            const bId = 'B-' + id;
            const hId = 'H-' + id;
            return { id, svg:
                `<g stroke="${s}" font-family="sans-serif" font-size="${fs}" type="svg-ext-gauge_progress" id="${id}">` +
                `<rect stroke-width="0.5" stroke="${s}" fill="none" height="${h}" width="${w}" y="${y}" x="${x}" id="${aId}"/>` +
                `<rect stroke-width="0.5" stroke="${s}" fill="${f}" height="${h / 2}" width="${w}" y="${y + h / 2}" x="${x}" id="${bId}"/>` +
                `<foreignObject font-size="${fs}" id="${hId}" width="${w}" height="${h}" y="${y}" x="${x}"/>` +
                `</g>` };
        }
        case 'gauge-semaphore': {
            return { id, svg:
                `<g id="${id}" type="svg-ext-gauge_semaphore" fill="${f}" stroke="${s}" font-size="${fs}" font-family="sans-serif" stroke-width="1" xml:space="preserve" style="pointer-events:none">` +
                `<ellipse id="${id}" cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"/>` +
                `</g>` };
        }
        case 'pipe': {
            const pipeW = (options && options.pipeWidth) || 10;
            const contentW = (options && options.contentWidth) || Math.max(2, pipeW - 4);
            const border = (options && options.border) || f;
            const content = (options && options.content) || s;
            const aId = 'A-' + id, bId = 'B-' + id, cId = 'C-' + id;
            return { id, svg:
                `<g type="svg-ext-pipe" id="${id}" fill="${f}" stroke="${s}" font-size="${fs}" font-family="sans-serif" stroke-width="1" transform="translate(${x},${y})" xml:space="preserve">` +
                `<rect fill="${border}" height="${pipeW}" width="${w}" y="${(h - pipeW) / 2}" x="0" id="${aId}"/>` +
                `<rect fill="${content}" height="${contentW}" width="${w}" y="${(h - contentW) / 2}" x="0" id="${bId}"/>` +
                `<rect fill="none" height="${pipeW}" width="${w}" y="${(h - pipeW) / 2}" x="0" stroke="${border}" id="${cId}"/>` +
                `</g>` };
        }
        default: {
            // ForeignObject-based controls: html-input, html-select, html-image,
            // pipe, html-slider, html-switch, html-chart, html-bag,
            // html-graph-bar, html-graph-pie, own_ctrl-table, own_ctrl-iframe,
            // own_ctrl-panel, own_ctrl-video, own_ctrl-scheduler
            const typeAttr = TYPE_ATTR_MAP[type];
            if (typeAttr) {
                const bgId = 'svg_' + Math.random().toString(36).slice(2, 10);
                const foId = 'H-' + id;
                return { id, svg:
                    `<g type="${typeAttr}" id="${id}" fill="rgba(0,0,0,0)" stroke="rgba(0,0,0,0)" font-size="${fs}" font-family="sans-serif" transform="translate(${x},${y})" xml:space="preserve" style="pointer-events:none">` +
                    `<rect stroke-width="0" fill="rgba(0,0,0,0)" height="${h}" width="${w}" y="0" x="0" id="${bgId}"/>` +
                    `<foreignObject id="${foId}" width="${w}" height="${h}" y="0" x="0">` +
                    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;"></div>` +
                    `</foreignObject>` +
                    `</g>` };
            }
            // Shape library types: svg-ext-shapes, svg-ext-proceng, svg-ext-ape
            if (type === 'svg-ext-shapes') {
                const shapeName = (options && options.shapeName) || 'rectangle';
                const shapeType = SHAPES_MAP[shapeName] || 'svg-ext-shapes-rectangle';
                return { id, svg:
                    `<g id="${id}" type="${shapeType}" fill="${f}" stroke="${s}" font-size="${fs}" font-family="sans-serif" text-anchor="middle" transform="translate(${x},${y})">` +
                    `<rect id="${id}" width="${w}" height="${h}"/>` +
                    `</g>` };
            }
            if (type === 'svg-ext-proceng') {
                const shapeName = (options && options.shapeName) || 'centrifugal';
                const shapeType = PROCENG_MAP[shapeName] || 'svg-ext-proceng-centrifugal';
                return { id, svg:
                    `<g id="${id}" type="${shapeType}" fill="${f}" stroke="${s}" font-size="${fs}" font-family="sans-serif" stroke-width="1" transform="translate(${x},${y})" xml:space="preserve">` +
                    `<rect id="${id}" width="${w}" height="${h}" fill="none" stroke="${s}" stroke-width="1"/>` +
                    `</g>` };
            }
            if (type === 'svg-ext-ape') {
                const shapeName = (options && options.shapeName) || 'eli';
                return { id, svg:
                    `<g id="${id}" type="svg-ext-ape-${shapeName}" fill="${f}" stroke="${s}" font-size="${fs}" font-family="sans-serif" stroke-width="1" transform="translate(${x},${y})" xml:space="preserve">` +
                    `<rect id="${id}" width="${w}" height="${h}" fill="none"/>` +
                    `</g>` };
            }
            if (type === 'svg-ext-svg') {
                // Hand-drawn custom SVG: options.svg contains raw SVG inner content (paths, circles, etc.)
                const inner = (options && options.svg) || '';
                return { id, svg:
                    `<g id="${id}" type="svg-ext-svg" fill="${f}" stroke="${s}" font-size="${fs}" font-family="sans-serif" stroke-width="1" transform="translate(${x},${y})" xml:space="preserve">` +
                    `<rect id="${id}" width="${w}" height="${h}" fill="none" stroke="rgba(0,0,0,0)" stroke-width="0"/>` +
                    inner +
                    `</g>` };
            }
            return { id, svg: '' };
        }
    }
}

/**
 * Ensure svgcontent has a valid SVG wrapper.  If empty or missing, create one.
 */
function ensureSvgContainer(svgcontent, profile) {
    if (svgcontent && svgcontent.includes('</svg>')) return svgcontent;
    const pw = (profile && profile.width) || 1280;
    const ph = (profile && profile.height) || 720;
    const pbk = (profile && profile.bkcolor) || '#222222';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${pw} ${ph}" style="background-color:${pbk}"><title>Layer 1</title></svg>`;
}

/**
 * Inject an SVG fragment just before the closing </svg> tag.
 */
function appendSvgFragment(svgcontent, fragment) {
    const idx = svgcontent.lastIndexOf('</svg>');
    if (idx < 0) return svgcontent + fragment;
    return svgcontent.slice(0, idx) + fragment + svgcontent.slice(idx);
}

/**
 * Remove an SVG element (by id) from svgcontent.
 * Handles both self-closing and container elements.
 */
function removeSvgElement(svgcontent, elementId) {
    // Match <tag ... id="elementId" ...>...</tag> or <tag ... id="elementId" .../>
    const re = new RegExp(
        '<([a-zA-Z]+)\\b[^>]*\\bid=["\']' + elementId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*>([\\s\\S]*?)<\\/\\1>|' +
        '<([a-zA-Z]+)\\b[^>]*\\bid=["\']' + elementId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\'][^>]*/>',
        'g'
    );
    return svgcontent.replace(re, '');
}

/**
 * Update attributes on an SVG element (identified by id) in svgcontent.
 * Only updates top-level attributes on the matched element tag.
 */
function updateSvgAttributes(svgcontent, elementId, attrs) {
    const escId = elementId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return svgcontent.replace(
        new RegExp('(<[^>]*\\bid=["\']' + escId + '["\'][^>]*?)(\\s*\\/?>)', 'g'),
        (match, prefix, suffix) => {
            let tag = prefix;
            for (const [key, val] of Object.entries(attrs)) {
                const reAttr = new RegExp('\\b' + key + '=["\'][^"\']*["\']');
                if (reAttr.test(tag)) {
                    tag = tag.replace(reAttr, `${key}="${val}"`);
                } else {
                    tag += ` ${key}="${val}"`;
                }
            }
            return tag + suffix;
        }
    );
}

const GAUGE_TYPES = [
    // Controls
    'html-button', 'html-input', 'html-select', 'html-image',
    'value', 'gauge-progress', 'gauge-semaphore',
    'pipe', 'html-slider', 'html-switch',
    'html-chart', 'html-bag', 'html-graph-bar', 'html-graph-pie',
    'own_ctrl-table', 'own_ctrl-iframe', 'own_ctrl-panel',
    'own_ctrl-video', 'own_ctrl-scheduler',
    // General shapes (SVG drawing)
    'svg-ext-rect', 'svg-ext-ellipse', 'svg-ext-text', 'svg-ext-line',
    // Shape library
    'svg-ext-shapes', 'svg-ext-proceng', 'svg-ext-ape',
    // Custom hand-drawn SVG
    'svg-ext-svg'
];

// Map agent type -> SVG type attribute used by the frontend
const TYPE_ATTR_MAP = {
    'html-button': 'svg-ext-html_button',
    'html-input': 'svg-ext-html_input',
    'html-select': 'svg-ext-html_select',
    'html-image': 'svg-ext-own_ctrl-image',
    'value': 'svg-ext-value',
    'gauge-progress': 'svg-ext-gauge_progress',
    'gauge-semaphore': 'svg-ext-gauge_semaphore',
    'pipe': 'svg-ext-pipe',
    'html-slider': 'svg-ext-html_slider',
    'html-switch': 'svg-ext-html_switch',
    'html-chart': 'svg-ext-html_chart',
    'html-bag': 'svg-ext-html_bag',
    'html-graph-bar': 'svg-ext-html_graph',
    'html-graph-pie': 'svg-ext-html_graph',
    'own_ctrl-table': 'svg-ext-own_ctrl-table',
    'own_ctrl-iframe': 'svg-ext-own_ctrl-iframe',
    'own_ctrl-panel': 'svg-ext-own_ctrl-panel',
    'own_ctrl-video': 'svg-ext-own_ctrl-video',
    'own_ctrl-scheduler': 'svg-ext-own_ctrl-scheduler',
    'svg-ext-shapes': 'svg-ext-shapes',
    'svg-ext-proceng': 'svg-ext-proceng',
    'svg-ext-ape': 'svg-ext-ape'
};

// Shape subtypes: agent shapeName -> SVG type attribute suffix
const SHAPES_MAP = {
    rectangle: 'svg-ext-shapes-rectangle', rect: 'svg-ext-shapes-rectangle',
    circle: 'svg-ext-shapes-circle', ellipse: 'svg-ext-shapes-circle',
    diamond: 'svg-ext-shapes-diamond', triangle: 'svg-ext-shapes-triangle',
    halfcircle: 'svg-ext-shapes-halfcircle', pentagon: 'svg-ext-shapes-pentagon',
    octagon: 'svg-ext-shapes-octagon', star4: 'svg-ext-shapes-star4',
    arrow: 'svg-ext-shapes-arrow', doublearrow: 'svg-ext-shapes-doublearrow',
    cloud: 'svg-ext-shapes-cloud', cylinder: 'svg-ext-shapes-cylinder',
    heart: 'svg-ext-shapes-heart', cross: 'svg-ext-shapes-cross',
    drop: 'svg-ext-shapes-drop', cone: 'svg-ext-shapes-cone',
    tape: 'svg-ext-shapes-tape', docu: 'svg-ext-shapes-docu',
    display: 'svg-ext-shapes-display', ticket: 'svg-ext-shapes-ticket',
    nosymbol: 'svg-ext-shapes-nosymbol', corner: 'svg-ext-shapes-corner',
    tee: 'svg-ext-shapes-tee', switch: 'svg-ext-shapes-switch',
    parallelogram: 'svg-ext-shapes-parallelogram', offpage: 'svg-ext-shapes-offpage'
};

// Proc eng subtypes
const PROCENG_MAP = {
    centrifugal: 'svg-ext-proceng-centrifugal', motor: 'svg-ext-proceng-motor',
    valveax: 'svg-ext-proceng-valveax', valvebx: 'svg-ext-proceng-valvebx',
    valvecx: 'svg-ext-proceng-valvecx', tank1: 'svg-ext-proceng-tank1',
    tank2: 'svg-ext-proceng-tank2', tank3: 'svg-ext-proceng-tank3',
    exchheat: 'svg-ext-proceng-exchheat', exchfilter: 'svg-ext-proceng-exchfilter',
    exchtube: 'svg-ext-proceng-exchtube', compfan: 'svg-ext-proceng-compfan',
    comppiston: 'svg-ext-proceng-comppiston', compvoid: 'svg-ext-proceng-compvoid',
    nozzle: 'svg-ext-proceng-nozzle', feeder: 'svg-ext-proceng-feeder',
    'agitator-prop': 'svg-ext-proceng-agitator-prop', 'agitator-turbo': 'svg-ext-proceng-agitator-turbo',
    'agitator-disc': 'svg-ext-proceng-agitator-disc', 'agitator-paddle': 'svg-ext-proceng-agitator-paddle',
    centrifuge1: 'svg-ext-proceng-centrifuge1', crusher1: 'svg-ext-proceng-crusher1',
    drier1: 'svg-ext-proceng-drier1', filter2: 'svg-ext-proceng-filter2',
    webcam: 'svg-ext-proceng-webcam'
};

const TAG_SLOTS = ['value', 'visibility', 'blink', 'color', 'rotate'];

function descriptors() {
    return [
        {
            name: 'view_read',
            description: 'Read a compact JSON description of the active view: profile, list of items with id/type/x/y/w/h/name/tag bindings/events/actions, and view-level events (onopen/onclose).',
            input_schema: {
                type: 'object',
                properties: {
                    viewId: { type: 'string', description: 'Optional. Defaults to active view.' },
                    onlySelection: { type: 'boolean', description: 'When true, only return items in the user selection.' }
                }
            }
        },
        {
            name: 'view_list_tags',
            description: 'List Tags configured in the current project. Use to find an existing Tag id before binding it to a gauge.',
            input_schema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Optional substring filter on tag name.' },
                    limit: { type: 'number', minimum: 1, maximum: 200 }
                }
            }
        },
        {
            name: 'view_add_gauge',
            description: 'Add a gauge / shape on the active view.',
            input_schema: {
                type: 'object',
                required: ['type', 'x', 'y', 'w', 'h'],
                properties: {
                    type: { type: 'string', enum: GAUGE_TYPES },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    w: { type: 'number', minimum: 1 },
                    h: { type: 'number', minimum: 1 },
                    name: { type: 'string', maxLength: 64 },
                    text: { type: 'string', maxLength: 200 },
                    fill: { type: 'string', pattern: '^#[0-9A-Fa-f]{6,8}$' },
                    stroke: { type: 'string', pattern: '^#[0-9A-Fa-f]{6,8}$' },
                    fontSize: { type: 'number', minimum: 6, maximum: 120 },
                    tagId: { type: 'string', description: 'Optional Tag id to bind to the primary value slot.' },
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
                    ranges: {
                        type: 'array',
                        description: 'Conditional coloring ranges based on tag value. Each: {min, max, color, stroke?, text?}.',
                        items: {
                            type: 'object',
                            required: ['min', 'max', 'color'],
                            properties: {
                                min: { type: 'number' },
                                max: { type: 'number' },
                                color: { type: 'string' },
                                stroke: { type: 'string' },
                                text: { type: 'string' }
                            }
                        }
                    },
                    actions: {
                        type: 'array',
                        description: 'Tag-triggered animations: {variableId, type, range?, options?}. blink: toggles fill/stroke colors. rotate: spins element. move: repositions. color: changes fill/stroke.',
                        items: {
                            type: 'object',
                            required: ['variableId', 'type'],
                            properties: {
                                variableId: { type: 'string' },
                                bitmask: { type: 'number' },
                                type: { type: 'string', enum: [
                                    'shapes.action-hide', 'shapes.action-show',
                                    'shapes.action-blink', 'shapes.action-color',
                                    'shapes.action-stop', 'shapes.action-clockwise',
                                    'shapes.action-anticlockwise', 'shapes.action-downup',
                                    'shapes.action-rotate', 'shapes.action-move',
                                    'shapes.action-monitor', 'shapes.action-refreshImage',
                                    'shapes.action-start', 'shapes.action-pause',
                                    'shapes.action-reset'
                                ]},
                                range: {
                                    type: 'object',
                                    properties: {
                                        min: { type: 'number' },
                                        max: { type: 'number' },
                                        color: { type: 'string' },
                                        stroke: { type: 'string' },
                                        text: { type: 'string' }
                                    }
                                },
                                options: {
                                    type: 'object',
                                    properties: {
                                        fillA: { type: 'string' }, fillB: { type: 'string' },
                                        strokeA: { type: 'string' }, strokeB: { type: 'string' },
                                        interval: { type: 'number' },
                                        minAngle: { type: 'number' }, maxAngle: { type: 'number' },
                                        delay: { type: 'number' },
                                        toX: { type: 'number' }, toY: { type: 'number' },
                                        duration: { type: 'number' }
                                    }
                                }
                            }
                        }
                    },
                    options: {
                        type: 'object',
                        description: 'Type-specific options. shapeName for svg-ext-shapes/proceng/ape. pipeWidth/contentWidth/content/border for pipe. svg (raw SVG inner content) for svg-ext-svg — place <path>, <circle>, <polygon>, <text> etc. directly.',
                        properties: {
                            shapeName: { type: 'string', description: 'Shape subtype name (e.g. "rectangle", "centrifugal", "piston").' },
                            pipeWidth: { type: 'number' },
                            contentWidth: { type: 'number' },
                            content: { type: 'string' },
                            border: { type: 'string' },
                            svg: { type: 'string', description: 'Raw SVG inner content for type=svg-ext-svg. E.g. "<circle cx=25 cy=25 r=20/> <line x1=10 y1=25 x2=40 y2=25/>".' }
                        }
                    }
                }
            }
        },
        {
            name: 'view_update_gauge',
            description: 'Patch one or more existing gauges. If `ids` is omitted and the user has a selection, the update applies to the selection. Supports ranges (conditional coloring), actions (blink/rotate/move/color animations), and options.',
            input_schema: {
                type: 'object',
                properties: {
                    ids: { type: 'array', items: { type: 'string' } },
                    id: { type: 'string', description: 'Convenience for a single target.' },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    w: { type: 'number', minimum: 1 },
                    h: { type: 'number', minimum: 1 },
                    text: { type: 'string', maxLength: 200 },
                    fill: { type: 'string', pattern: '^#[0-9A-Fa-f]{6,8}$' },
                    stroke: { type: 'string', pattern: '^#[0-9A-Fa-f]{6,8}$' },
                    fontSize: { type: 'number', minimum: 6, maximum: 120 },
                    tagId: { type: 'string' },
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
                    ranges: {
                        type: 'array',
                        description: 'Conditional coloring ranges based on tag value. Each: {min, max, color, stroke?, text?}. When tag value falls in [min,max), gauge changes to that color.',
                        items: {
                            type: 'object',
                            required: ['min', 'max', 'color'],
                            properties: {
                                min: { type: 'number' },
                                max: { type: 'number' },
                                color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6,8}$', description: 'Fill color when value is in range.' },
                                stroke: { type: 'string', pattern: '^#[0-9A-Fa-f]{6,8}$', description: 'Stroke color when value is in range.' },
                                text: { type: 'string', description: 'Label for this range (e.g. "Low", "Normal", "High").' }
                            }
                        }
                    },
                    actions: {
                        type: 'array',
                        description: 'Tag-triggered animations. Each: {variableId, type, range?, options?}. type=blink toggles colors, type=rotate spins element, type=move repositions, type=color changes fill/stroke.',
                        items: {
                            type: 'object',
                            required: ['variableId', 'type'],
                            properties: {
                                variableId: { type: 'string', description: 'Tag id whose value triggers this action.' },
                                bitmask: { type: 'number', description: 'Bitmask for boolean/bit-level triggers.' },
                                type: { type: 'string', enum: [
                                    'shapes.action-hide', 'shapes.action-show',
                                    'shapes.action-blink', 'shapes.action-color',
                                    'shapes.action-stop', 'shapes.action-clockwise',
                                    'shapes.action-anticlockwise', 'shapes.action-downup',
                                    'shapes.action-rotate', 'shapes.action-move',
                                    'shapes.action-monitor', 'shapes.action-refreshImage',
                                    'shapes.action-start', 'shapes.action-pause',
                                    'shapes.action-reset'
                                ]},
                                range: {
                                    type: 'object',
                                    description: 'Condition: action fires when tag value is in [min,max].',
                                    properties: {
                                        min: { type: 'number' },
                                        max: { type: 'number' },
                                        color: { type: 'string' },
                                        stroke: { type: 'string' },
                                        text: { type: 'string' }
                                    }
                                },
                                options: {
                                    type: 'object',
                                    description: 'Action-specific options. blink: {fillA, fillB, strokeA, strokeB, interval}. rotate: {minAngle, maxAngle, delay}. move: {toX, toY, duration}.',
                                    properties: {
                                        fillA: { type: 'string' },
                                        fillB: { type: 'string' },
                                        strokeA: { type: 'string' },
                                        strokeB: { type: 'string' },
                                        interval: { type: 'number' },
                                        minAngle: { type: 'number' },
                                        maxAngle: { type: 'number' },
                                        delay: { type: 'number' },
                                        toX: { type: 'number' },
                                        toY: { type: 'number' },
                                        duration: { type: 'number' }
                                    }
                                }
                            }
                        }
                    },
                    options: {
                        type: 'object',
                        description: 'Gauge-specific display options (pipe config, progress bar settings, etc.).'
                    }
                }
            }
        },
        {
            name: 'view_delete_gauge',
            description: 'Delete one or more gauges. If `ids` is omitted and the user has a selection, the deletion applies to the selection. confirmDelete must be true.',
            input_schema: {
                type: 'object',
                required: ['confirmDelete'],
                properties: {
                    ids: { type: 'array', items: { type: 'string' } },
                    id: { type: 'string' },
                    confirmDelete: { type: 'boolean', enum: [true] }
                }
            }
        },
        {
            name: 'view_bind_tag',
            description: 'Bind a Tag to a slot of one or more gauges. Tag must already exist in the project (use view.list_tags).',
            input_schema: {
                type: 'object',
                required: ['tagId'],
                properties: {
                    ids: { type: 'array', items: { type: 'string' } },
                    id: { type: 'string' },
                    tagId: { type: 'string' },
                    slot: { type: 'string', enum: TAG_SLOTS }
                }
            }
        },
        {
            name: 'view_set_profile',
            description: 'Update view profile (size, background color) and view-level events (onopen/onclose).',
            input_schema: {
                type: 'object',
                properties: {
                    width: { type: 'number', minimum: 100, maximum: 8192 },
                    height: { type: 'number', minimum: 100, maximum: 8192 },
                    bkcolor: { type: 'string', pattern: '^#[0-9A-Fa-f]{6,8}$' },
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
                    }
                }
            }
        },
        {
            name: 'view_set_layout',
            description: 'Update HMI-wide layout (start view, navigation visibility, header title, theme colors).',
            input_schema: {
                type: 'object',
                properties: {
                    startView: { type: 'string', description: 'view name to use as start' },
                    headerTitle: { type: 'string', maxLength: 120 },
                    headerBkColor: { type: 'string', pattern: '^#[0-9A-Fa-f]{6,8}$' },
                    headerFgColor: { type: 'string', pattern: '^#[0-9A-Fa-f]{6,8}$' },
                    showNavigation: { type: 'boolean' }
                }
            }
        },
        {
            name: 'view_list_templates',
            description: 'List View / Gauge templates registered by installed asset-pack skills, plus a small set of built-ins.',
            input_schema: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['view', 'gauge'] }
                }
            }
        },
        {
            name: 'view_apply_template',
            description: 'Insert a registered template into the active view at given offset.',
            input_schema: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: { type: 'string' },
                    x: { type: 'number' },
                    y: { type: 'number' }
                }
            }
        },
        {
            name: 'view_save',
            description: 'Commit all pending changes for the active view in one transaction. Always call this once at the end.',
            input_schema: { type: 'object', properties: {} }
        }
    ];
}

/**
 * @param {object} ctx { runtime, viewId, buffer, logger, selection }
 *   selection?: { ids: string[] }
 */
function executors(ctx) {
    const { runtime, buffer, logger, selection } = ctx;

    const resolveTargets = (args) => {
        if (Array.isArray(args.ids) && args.ids.length) return args.ids;
        if (typeof args.id === 'string' && args.id) return [args.id];
        if (selection?.ids?.length) return selection.ids.slice();
        return [];
    };

    return {
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
        'view_list_tags': async (args = {}) => {
            const tags = collectTags(runtime);
            const q = (args.query || '').toLowerCase();
            const limit = args.limit || 50;
            return tags
                .filter(t => !q || (t.name || '').toLowerCase().includes(q))
                .slice(0, limit);
        },
        'view_add_gauge': async (args) => {
            const { svg, id: svgId } = buildSvg(
                args.type, args.x, args.y, args.w, args.h,
                args.fill, args.stroke, args.fontSize, args.text, args.options
            );
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
                    events: args.events || [],
                    ranges: args.ranges || undefined,
                    actions: args.actions || undefined,
                    options: args.options || undefined
                }
            };
            buffer.view.items = buffer.view.items || {};
            buffer.view.items[svgId] = item;
            // Append SVG markup so the canvas can render the element.
            buffer.view.svgcontent = ensureSvgContainer(buffer.view.svgcontent || '', buffer.view.profile);
            buffer.view.svgcontent = appendSvgFragment(buffer.view.svgcontent, svg);
            buffer.dirty = true;
            return { id: svgId };
        },
        'view_update_gauge': async (args = {}) => {
            const targets = resolveTargets(args);
            if (!targets.length) {
                return { error: 'no_target', message: 'Provide id/ids or use a canvas selection.' };
            }
            const items = buffer.view.items || {};
            const updated = [];
            const svgAttrs = {};
            if (args.fill !== undefined) svgAttrs.fill = args.fill;
            if (args.stroke !== undefined) svgAttrs.stroke = args.stroke;
            if (args.fontSize !== undefined) svgAttrs['font-size'] = args.fontSize;
            for (const tid of targets) {
                const it = items[tid];
                if (!it) { updated.push({ id: tid, error: 'not_found' }); continue; }
                it.property = it.property || {};
                const bbox = it.property.bbox || {};
                if (args.x !== undefined) bbox.x = args.x;
                if (args.y !== undefined) bbox.y = args.y;
                if (args.w !== undefined) bbox.w = args.w;
                if (args.h !== undefined) bbox.h = args.h;
                it.property.bbox = bbox;
                if (args.text !== undefined) it.property.text = args.text;
                if (args.fill !== undefined) it.property.fill = args.fill;
                if (args.stroke !== undefined) it.property.stroke = args.stroke;
                if (args.fontSize !== undefined) it.property.fontSize = args.fontSize;
                if (args.tagId !== undefined) it.property.variableId = args.tagId;
                if (args.events !== undefined) it.property.events = args.events;
                if (args.ranges !== undefined) it.property.ranges = args.ranges;
                if (args.actions !== undefined) it.property.actions = args.actions;
                if (args.options !== undefined) it.property.options = args.options;
                // Sync SVG attributes.
                if (buffer.view.svgcontent && Object.keys(svgAttrs).length) {
                    buffer.view.svgcontent = updateSvgAttributes(buffer.view.svgcontent, tid, svgAttrs);
                }
                // Update transform if position changed.
                if (buffer.view.svgcontent && (args.x !== undefined || args.y !== undefined)) {
                    const nx = args.x ?? bbox.x ?? 0;
                    const ny = args.y ?? bbox.y ?? 0;
                    buffer.view.svgcontent = updateSvgAttributes(buffer.view.svgcontent, tid, {
                        transform: `translate(${nx},${ny})`
                    });
                }
                updated.push({ id: tid, ok: true });
            }
            buffer.dirty = true;
            return { updated };
        },
        'view_delete_gauge': async (args = {}) => {
            if (args.confirmDelete !== true) {
                return { error: 'confirm_required' };
            }
            const targets = resolveTargets(args);
            if (!targets.length) {
                return { error: 'no_target' };
            }
            const items = buffer.view.items || {};
            const deleted = [];
            for (const tid of targets) {
                if (items[tid]) {
                    delete items[tid];
                    // Remove SVG element.
                    if (buffer.view.svgcontent) {
                        buffer.view.svgcontent = removeSvgElement(buffer.view.svgcontent, tid);
                    }
                    deleted.push(tid);
                }
            }
            buffer.dirty = true;
            return { deleted };
        },
        'view_bind_tag': async (args = {}) => {
            const targets = resolveTargets(args);
            if (!targets.length) return { error: 'no_target' };
            const items = buffer.view.items || {};
            const slot = args.slot || 'value';
            const ok = [];
            for (const tid of targets) {
                const it = items[tid];
                if (!it) continue;
                it.property = it.property || {};
                if (slot === 'value') {
                    it.property.variableId = args.tagId;
                } else {
                    it.property.bindings = it.property.bindings || {};
                    it.property.bindings[slot] = args.tagId;
                }
                ok.push(tid);
            }
            buffer.dirty = true;
            return { bound: ok, slot, tagId: args.tagId };
        },
        'view_set_profile': async (args = {}) => {
            buffer.view.profile = buffer.view.profile || {};
            if (args.width !== undefined) buffer.view.profile.width = args.width;
            if (args.height !== undefined) buffer.view.profile.height = args.height;
            if (args.bkcolor !== undefined) buffer.view.profile.bkcolor = args.bkcolor;
            if (args.viewEvents !== undefined) {
                buffer.view.property = buffer.view.property || {};
                buffer.view.property.events = args.viewEvents;
            }
            buffer.dirty = true;
            return buffer.view.profile;
        },
        'view_set_layout': async (args = {}) => {
            try {
                const layout = runtime?.project?.getHmiLayout?.() || {};
                if (args.startView !== undefined) layout.start = args.startView;
                if (args.showNavigation !== undefined) {
                    layout.navigation = layout.navigation || {};
                    layout.navigation.mode = args.showNavigation ? 'over' : 'hide';
                }
                if (args.headerTitle !== undefined || args.headerBkColor !== undefined || args.headerFgColor !== undefined) {
                    layout.header = layout.header || {};
                    if (args.headerTitle !== undefined) layout.header.title = args.headerTitle;
                    if (args.headerBkColor !== undefined) layout.header.bkcolor = args.headerBkColor;
                    if (args.headerFgColor !== undefined) layout.header.fgcolor = args.headerFgColor;
                }
                buffer.layoutPatch = layout;
                buffer.dirty = true;
                return layout;
            } catch (err) {
                return { error: 'layout_failed', message: String(err) };
            }
        },
        'view_list_templates': async (args = {}) => {
            const reg = runtime?.agentMgr?.getTemplateRegistry?.()?.list?.(args.kind) || [];
            return reg.map(t => ({ name: t.name, kind: t.kind, source: t.source, preview: t.preview }));
        },
        'view_apply_template': async (args = {}) => {
            const reg = runtime?.agentMgr?.getTemplateRegistry?.();
            if (!reg) return { error: 'no_templates' };
            const t = reg.find(args.name);
            if (!t) return { error: 'template_not_found', name: args.name };
            const dx = args.x ?? 0;
            const dy = args.y ?? 0;
            const created = [];
            for (const item of t.items || []) {
                const id = genId('gauge');
                const clone = JSON.parse(JSON.stringify(item));
                clone.id = id;
                if (clone.property?.bbox) {
                    clone.property.bbox.x = (clone.property.bbox.x || 0) + dx;
                    clone.property.bbox.y = (clone.property.bbox.y || 0) + dy;
                }
                buffer.view.items = buffer.view.items || {};
                buffer.view.items[id] = clone;
                created.push(id);
            }
            buffer.dirty = true;
            return { applied: t.name, created };
        },
        'view_save': async () => {
            buffer.commitRequested = true;
            return { ok: true };
        }
    };
}

function redactProperty(p) {
    if (!p) return null;
    const { text, fill, stroke, fontSize, variableId, bbox, bindings, events, actions } = p;
    return { text, fill, stroke, fontSize, variableId, bbox, bindings, events: events || [], actions: actions || [] };
}

function collectTags(runtime) {
    const out = [];
    try {
        const devices = runtime?.project?.getDevices?.() || {};
        for (const dname of Object.keys(devices)) {
            const dev = devices[dname];
            const tags = (dev && dev.tags) || {};
            for (const tid of Object.keys(tags)) {
                const t = tags[tid];
                out.push({
                    id: tid,
                    name: t.name,
                    device: dname,
                    type: t.type,
                    address: t.address
                });
            }
        }
    } catch (_) { /* defensive */ }
    return out;
}

module.exports = { descriptors, executors, GAUGE_TYPES, TAG_SLOTS };
