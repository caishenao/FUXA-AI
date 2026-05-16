/**
 * Zero-dependency Pencil (.pen) file parser.
 *
 * .pen files are ZIP archives containing document.xml (page/shape definitions)
 * and image assets.  This module extracts the ZIP, parses the XML, and returns
 * a normalised structure suitable for the design-import agent tools.
 *
 * Uses the same ZIP central-directory approach as skills/zip.js.
 */
'use strict';

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;

function _findEOCD(buf) {
    const min = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) return i;
    }
    return -1;
}

function _extractEntries(buf) {
    const eocd = _findEOCD(buf);
    if (eocd < 0) throw new Error('pen: not a valid ZIP file');
    const totalEntries = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const entries = {};
    let p = cdOffset;
    for (let i = 0; i < totalEntries; i++) {
        if (buf.readUInt32LE(p) !== CDH_SIG) throw new Error('pen: bad central dir at entry ' + i);
        const compMethod = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const lfhOffset = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        p += 46 + nameLen + extraLen + commentLen;

        const lfhNameLen = buf.readUInt16LE(lfhOffset + 26);
        const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
        const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
        const data = buf.slice(dataStart, dataStart + compSize);
        let out;
        if (compMethod === 0) out = data;
        else if (compMethod === 8) out = zlib.inflateRawSync(data);
        else continue;
        entries[name] = out;
    }
    return entries;
}

// ---- Minimal XML parser ----

function _parseXml(xmlStr) {
    xmlStr = xmlStr.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    const tokens = [];
    const re = /<([^>]+)>/g;
    let lastIdx = 0;
    let m;
    while ((m = re.exec(xmlStr)) !== null) {
        if (m.index > lastIdx) {
            const txt = xmlStr.slice(lastIdx, m.index).trim();
            if (txt) tokens.push({ type: 'text', value: txt });
        }
        const inner = m[1];
        if (inner.startsWith('?')) { lastIdx = m.index + m[0].length; continue; }
        if (inner.startsWith('!')) { lastIdx = m.index + m[0].length; continue; }
        if (inner.startsWith('/')) {
            tokens.push({ type: 'close', tag: inner.slice(1).trim() });
        } else if (inner.endsWith('/')) {
            const trimmed = inner.slice(0, -1).trim();
            const { tag, attrs } = _parseTag(trimmed);
            tokens.push({ type: 'selfclose', tag, attrs });
        } else {
            const { tag, attrs } = _parseTag(inner);
            tokens.push({ type: 'open', tag, attrs });
        }
        lastIdx = m.index + m[0].length;
    }
    const root = { tag: '__root__', attrs: {}, children: [] };
    const stack = [root];
    for (const t of tokens) {
        const cur = stack[stack.length - 1];
        if (t.type === 'text') {
            cur.children.push({ tag: '__text__', text: t.value, children: [] });
        } else if (t.type === 'open') {
            const node = { tag: t.tag, attrs: t.attrs, children: [] };
            cur.children.push(node);
            stack.push(node);
        } else if (t.type === 'selfclose') {
            cur.children.push({ tag: t.tag, attrs: t.attrs, children: [] });
        } else if (t.type === 'close') {
            stack.pop();
        }
    }
    return root;
}

function _parseTag(s) {
    const attrs = {};
    const attrRe = /([\w:.\-]+)\s*=\s*"([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(s)) !== null) {
        attrs[am[1]] = am[2];
    }
    const tag = s.split(/\s+/)[0];
    return { tag, attrs };
}

// ---- Pencil DOM helpers ----

function _localName(tag) {
    const idx = tag.indexOf(':');
    return idx >= 0 ? tag.slice(idx + 1) : tag;
}

function _find(nodes, localName) {
    return nodes.filter(n => _localName(n.tag) === localName);
}

function _findDeep(node, localName) {
    const found = [];
    function walk(n) {
        if (_localName(n.tag) === localName) found.push(n);
        for (const c of n.children) walk(c);
    }
    walk(node);
    return found;
}

function _textOf(node) {
    if (!node) return '';
    for (const c of node.children) {
        if (c.tag === '__text__') return c.text;
    }
    // Try CDATA-like content (already stripped by parser)
    for (const c of node.children) {
        const t = _textOf(c);
        if (t) return t;
    }
    return '';
}

function _parseBox(val) {
    if (!val) return null;
    const m = val.match(/\{[^}]*x\s*:\s*([\d.]+)[^}]*y\s*:\s*([\d.]+)[^}]*w\s*:\s*([\d.]+)[^}]*h\s*:\s*([\d.]+)/);
    if (m) return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
    return null;
}

function _parseColor(val) {
    if (!val) return null;
    // Pencil stores colors as {r,g,b,a} or #hex
    if (val.startsWith('#')) return val;
    const m = val.match(/\{[^}]*r\s*:\s*([\d.]+)[^}]*g\s*:\s*([\d.]+)[^}]*b\s*:\s*([\d.]+)/);
    if (m) {
        const r = Math.round(+m[1] * 255);
        const g = Math.round(+m[2] * 255);
        const b = Math.round(+m[3] * 255);
        return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }
    return val;
}

function _collectProperties(shapeNode) {
    const props = {};
    // <p:Properties><p:Property name="box" ...> or <Property name="fillColor" value="..."/>
    const propContainers = _find(shapeNode.children, 'Properties');
    for (const pc of propContainers) {
        for (const child of pc.children) {
            const name = child.attrs.name || '';
            if (name) props[name] = _textOf(child) || child.attrs.value || '';
        }
    }
    // Also direct Property children
    for (const child of shapeNode.children) {
        if (_localName(child.tag) === 'Property') {
            const name = child.attrs.name || '';
            if (name) props[name] = _textOf(child) || child.attrs.value || '';
        }
    }
    return props;
}

function _collectContent(shapeNode) {
    const contentNodes = _find(shapeNode.children, 'Content');
    for (const cn of contentNodes) {
        const t = _textOf(cn);
        if (t) return t;
    }
    return '';
}

function _mapShape(shapeNode) {
    const def = shapeNode.attrs.def || '';
    const props = _collectProperties(shapeNode);
    const box = _parseBox(props.box);

    let type = null;
    if (/Rectangle|RoundRect/i.test(def)) type = 'rect';
    else if (/Circle|Ellipse/i.test(def)) type = 'ellipse';
    else if (/PlainText|PlainTextBox/i.test(def)) type = 'text';
    else if (/Line|Connector/i.test(def)) type = 'line';
    else if (/Image/i.test(def)) type = 'image';
    else if (/Button/i.test(def)) type = 'button';
    else return null;

    const elem = {
        type,
        x: box ? Math.round(box.x) : 0,
        y: box ? Math.round(box.y) : 0,
        w: box ? Math.round(box.w) : 100,
        h: box ? Math.round(box.h) : 30,
    };

    const fill = _parseColor(props.fillColor);
    const stroke = _parseColor(props.strokeColor);
    if (fill) elem.fill = fill;
    if (stroke) elem.stroke = stroke;
    if (props.fontSize) elem.fontSize = parseFloat(props.fontSize) || 14;
    if (props.fontFamily) elem.fontFamily = props.fontFamily;

    if (type === 'text' || type === 'button') {
        elem.text = _collectContent(shapeNode) || props.text || '';
    }

    return elem;
}

function _parsePage(pageNode) {
    const name = pageNode.attrs.name || 'Page';
    const page = { name, width: 1024, height: 768, elements: [] };

    const props = _collectProperties(pageNode);
    if (props.width) page.width = parseInt(props.width, 10) || 1024;
    if (props.height) page.height = parseInt(props.height, 10) || 768;

    const shapes = _findDeep(pageNode, 'Shape');
    for (const s of shapes) {
        const elem = _mapShape(s);
        if (elem) page.elements.push(elem);
    }

    return page;
}

/**
 * Parse a .pen file buffer.
 * @param {Buffer} buf - raw .pen file content
 * @returns {{ pages: Array<{name: string, width: number, height: number, elements: Array}> }}
 */
function parsePen(buf) {
    const entries = _extractEntries(buf);

    const docKey = Object.keys(entries).find(k => k.toLowerCase().endsWith('document.xml'));
    if (!docKey) throw new Error('pen: document.xml not found in archive');

    const xmlStr = entries[docKey].toString('utf8');
    const tree = _parseXml(xmlStr);

    const pages = [];
    const pageNodes = _findDeep(tree, 'Page');
    for (const pn of pageNodes) {
        pages.push(_parsePage(pn));
    }

    return { pages };
}

module.exports = { parsePen };
