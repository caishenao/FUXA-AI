/**
 * Local skill catalog — scans the builtins/ directory and provides
 * search/list/installDir resolution.
 */
'use strict';

const fs = require('fs');
const path = require('path');

class Catalog {
    constructor(builtinsDir) {
        this.builtinsDir = builtinsDir;
        /** @type {Map<string, {name, slug, version, kind, description, author, dir}>} */
        this.entries = new Map();
    }

    async init() {
        if (!fs.existsSync(this.builtinsDir)) return;
        const dirs = await fs.promises.readdir(this.builtinsDir, { withFileTypes: true });
        for (const ent of dirs) {
            if (!ent.isDirectory()) continue;
            const dir = path.join(this.builtinsDir, ent.name);
            const manifestPath = path.join(dir, 'skill.json');
            try {
                const raw = await fs.promises.readFile(manifestPath, 'utf8');
                const m = JSON.parse(raw);
                if (m.slug) {
                    this.entries.set(m.slug, {
                        name: m.name || m.slug,
                        slug: m.slug,
                        version: m.version || null,
                        kind: m.kind,
                        description: m.description || '',
                        author: m.author || '',
                        dir
                    });
                }
            } catch (_) { /* skip bad manifests */ }
        }
    }

    list() {
        return Array.from(this.entries.values());
    }

    search(query) {
        if (!query) return this.list();
        const q = query.toLowerCase();
        return this.list().filter(e =>
            e.name.toLowerCase().includes(q) ||
            e.slug.includes(q) ||
            e.description.toLowerCase().includes(q)
        );
    }

    getInstallDir(slug) {
        const e = this.entries.get(slug);
        return e ? e.dir : null;
    }
}

module.exports = { Catalog };
