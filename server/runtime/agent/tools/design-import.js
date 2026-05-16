/**
 * Design-import tools: exposed to the LLM for converting design files
 * (Pencil .pen) into FUXA view elements.
 *
 * Follows the same ChangeBuffer pattern as view.js / device.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parsePen } = require('../pen-parser');

function genId(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ID_PREFIX = {
    'svg-ext-rect': 'SHE_', 'svg-ext-ellipse': 'SHE_',
    'svg-ext-text': 'svg_', 'svg-ext-line': 'svg_',
    'html-button': 'HXB_', 'value': 'VAL_',
};

function _gaugeSvgId(type) {
    return (ID_PREFIX[type] || 'svg_') + Math.random().toString(36).slice(2, 10);
}

function _buildSvg(type, x, y, w, h, fill, stroke, fontSize, text) {
    const f = fill || '#1565c0';
    const s = stroke || '#0D47A1';
    const fs = fontSize || 14;
    const id = _gaugeSvgId(type);
    switch (type) {
        case 'svg-ext-rect':
            return { id, svg:
                `<g id="${id}" type="svg-ext-shapes-rectangle" fill="${f}" stroke="${s}" font-size="${fs}" font-family="sans-serif" text-anchor="middle" transform="translate(${x},${y})">` +
                `<rect id="${id}" width="${w}" height="${h}"/>` +
                `</g>` };
        case 'svg-ext-ellipse': {
            const rx = w / 2, ry = h / 2;
            return { id, svg:
                `<g id="${id}" type="svg-ext-shapes-circle" fill="${f}" stroke="${s}" font-size="${fs}" font-family="sans-serif" text-anchor="middle" transform="translate(${x},${y})">` +
                `<ellipse id="${id}" cx="${rx}" cy="${ry}" rx="${rx}" ry="${ry}"/>` +
                `</g>` };
        }
        case 'svg-ext-text':
            return { id, svg:
                `<text xml:space="preserve" text-anchor="middle" font-family="sans-serif" font-size="${fs}" id="${id}" y="${y + fs}" x="${x + w / 2}" stroke-width="0" stroke="${s}" fill="${f}">${_esc(text || 'Text')}</text>` };
        case 'svg-ext-line':
            return { id, svg:
                `<line fill="none" stroke="${s}" x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" stroke-width="2" id="${id}"/>` };
        case 'value':
            return { id, svg:
                `<g id="${id}" type="svg-ext-value" fill="${f}" stroke="${s}" font-size="${fs}" stroke-width="0" font-family="sans-serif" text-anchor="middle">` +
                `<text stroke-width="0" id="${id}" fill="${f}" stroke="${s}" font-size="${fs}" font-family="sans-serif" text-anchor="middle" xml:space="preserve" x="${x + w / 2}" y="${y + fs}">${_esc(text || '##.##')}</text>` +
                `</g>` };
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
        default:
            return { id, svg: '' };
    }
}

function _ensureSvgContainer(svgcontent, profile) {
    if (svgcontent && svgcontent.includes('</svg>')) return svgcontent;
    const pw = (profile && profile.width) || 1280;
    const ph = (profile && profile.height) || 720;
    const pbk = (profile && profile.bkcolor) || '#222222';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${pw} ${ph}" style="background-color:${pbk}"><title>Layer 1</title></svg>`;
}

function _appendSvgFragment(svgcontent, fragment) {
    const idx = svgcontent.lastIndexOf('</svg>');
    if (idx < 0) return svgcontent + fragment;
    return svgcontent.slice(0, idx) + fragment + svgcontent.slice(idx);
}

const TYPE_MAP = {
    rect: 'svg-ext-rect',
    ellipse: 'svg-ext-ellipse',
    text: 'svg-ext-text',
    line: 'svg-ext-line',
    button: 'html-button',
    value: 'value',
};

function descriptors() {
    return [
        {
            name: 'design_parse_pen',
            description: 'Parse a Pencil (.pen) design file and extract structured elements (rectangles, text, ellipses, images, lines). Returns page list with element data.',
            input_schema: {
                type: 'object',
                required: ['filePath'],
                properties: {
                    filePath: { type: 'string', description: 'Path to the .pen file (relative to upload dir, or absolute path)' },
                    pageIndex: { type: 'number', description: 'Which page to extract (0-based). Defaults to 0.' }
                }
            }
        },
        {
            name: 'design_place_elements',
            description: 'Convert parsed design elements into FUXA view items and place them on the canvas. Supports rect, ellipse, text, line, button, and value types.',
            input_schema: {
                type: 'object',
                required: ['elements'],
                properties: {
                    elements: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['type', 'x', 'y', 'w', 'h'],
                            properties: {
                                type: { type: 'string', enum: ['rect', 'ellipse', 'text', 'line', 'button', 'value'] },
                                x: { type: 'number' }, y: { type: 'number' },
                                w: { type: 'number' }, h: { type: 'number' },
                                fill: { type: 'string' }, stroke: { type: 'string' },
                                text: { type: 'string' }, fontSize: { type: 'number' }
                            }
                        }
                    },
                    profileWidth: { type: 'number' },
                    profileHeight: { type: 'number' },
                    profileBkcolor: { type: 'string' }
                }
            }
        },
        {
            name: 'design_set_background',
            description: 'Set a background image for the current view. The image should already be uploaded to the server.',
            input_schema: {
                type: 'object',
                required: ['imagePath'],
                properties: {
                    imagePath: { type: 'string', description: 'Server-relative path to the image (e.g., /uploadfiles/design.png)' },
                    width: { type: 'number', description: 'View width. Defaults to 1280.' },
                    height: { type: 'number', description: 'View height. Defaults to 720.' }
                }
            }
        }
    ];
}

function executors(ctx) {
    const { runtime, buffer, logger } = ctx;

    return {
        async design_parse_pen(args) {
            const filePath = args.filePath;
            const pageIndex = args.pageIndex || 0;

            let fullPath = filePath;
            if (!path.isAbsolute(filePath)) {
                const uploadDir = runtime.settings.uploadFileDir || '';
                fullPath = path.join(uploadDir, filePath);
            }

            if (!fs.existsSync(fullPath)) {
                return { ok: false, error: 'file_not_found', path: fullPath };
            }

            const buf = fs.readFileSync(fullPath);
            const result = parsePen(buf);

            if (!result.pages.length) {
                return { ok: false, error: 'no_pages_found' };
            }

            const page = result.pages[Math.min(pageIndex, result.pages.length - 1)];
            logger?.info?.(`design_parse_pen: parsed page "${page.name}" with ${page.elements.length} elements`);

            return {
                ok: true,
                pages: result.pages.map(p => ({ name: p.name, width: p.width, height: p.height, elementCount: p.elements.length })),
                selectedPage: pageIndex,
                page: { name: page.name, width: page.width, height: page.height, elements: page.elements }
            };
        },

        async design_place_elements(args) {
            const elements = args.elements || [];
            if (!elements.length) return { ok: false, error: 'no_elements' };

            if (args.profileWidth || args.profileHeight) {
                buffer.view.profile = buffer.view.profile || {};
                if (args.profileWidth) buffer.view.profile.width = args.profileWidth;
                if (args.profileHeight) buffer.view.profile.height = args.profileHeight;
                if (args.profileBkcolor) buffer.view.profile.bkcolor = args.profileBkcolor;
            }

            buffer.view.svgcontent = _ensureSvgContainer(buffer.view.svgcontent, buffer.view.profile);
            const placed = [];

            for (const elem of elements) {
                const fuxaType = TYPE_MAP[elem.type];
                if (!fuxaType) continue;

                const { id, svg } = _buildSvg(
                    fuxaType, elem.x, elem.y, elem.w, elem.h,
                    elem.fill, elem.stroke, elem.fontSize, elem.text
                );

                if (!svg) continue;

                buffer.view.items[id] = {
                    id, name: elem.text || '', type: fuxaType,
                    label: '', hide: false, lock: false,
                    property: {
                        text: elem.text || '', fill: elem.fill || '#1565c0',
                        stroke: elem.stroke || '#0D47A1', fontSize: elem.fontSize || 14,
                        variableId: '', bbox: { x: elem.x, y: elem.y, w: elem.w, h: elem.h },
                        events: []
                    }
                };

                buffer.view.svgcontent = _appendSvgFragment(buffer.view.svgcontent, svg);
                placed.push({ id, type: elem.type, x: elem.x, y: elem.y });
            }

            buffer.dirty = true;
            logger?.info?.(`design_place_elements: placed ${placed.length} elements`);
            return { ok: true, count: placed.length, items: placed };
        },

        async design_set_background(args) {
            const imagePath = args.imagePath;

            buffer.view.profile = buffer.view.profile || {};
            if (args.width) buffer.view.profile.width = args.width;
            if (args.height) buffer.view.profile.height = args.height;

            const w = buffer.view.profile.width || 1280;
            const h = buffer.view.profile.height || 720;
            const id = 'bg_' + Math.random().toString(36).slice(2, 10);

            const svg = `<g id="${id}" type="svg-ext-own_ctrl-image" transform="translate(0,0)"><image href="${_esc(imagePath)}" width="${w}" height="${h}"/></g>`;
            buffer.view.svgcontent = _ensureSvgContainer(buffer.view.svgcontent, buffer.view.profile);

            const titleEnd = buffer.view.svgcontent.indexOf('</title>');
            if (titleEnd > 0) {
                buffer.view.svgcontent = buffer.view.svgcontent.slice(0, titleEnd + 8) + svg + buffer.view.svgcontent.slice(titleEnd + 8);
            } else {
                buffer.view.svgcontent = _appendSvgFragment(buffer.view.svgcontent, svg);
            }

            buffer.view.items[id] = {
                id, name: 'background', type: 'svg-ext-own_ctrl-image',
                label: '', hide: false, lock: true,
                property: {
                    address: imagePath, text: '', variableId: '',
                    bbox: { x: 0, y: 0, w, h }, events: []
                }
            };

            buffer.dirty = true;
            logger?.info?.(`design_set_background: set ${imagePath}`);
            return { ok: true, id, width: w, height: h };
        }
    };
}

module.exports = { descriptors, executors };
