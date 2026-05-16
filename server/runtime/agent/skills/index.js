/**
 * SkillManager.
 *
 * Owns the on-disk skills directory and an in-memory registry of loaded skills.
 * Layout under `<workDir>/agent-skills/`:
 *   <slug>/skill.json
 *   <slug>/<main.js>   (tool-pack)
 *   <slug>/templates.json (asset-pack)
 *
 * One state file at the root: `<workDir>/agent-skills/state.json`
 *   { "<slug>": { "enabled": true|false, "installedAt": <ts> } }
 *
 * Loading is "trust install": tool-pack JS modules are required() into the
 * server process when enabled. The SCADA admin opted in by uploading the file
 * — same trust model FUXA uses for plugins. We DO NOT sandbox.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { validate } = require('./manifest');
const { TemplateRegistry } = require('./template-registry');
const { extractZip } = require('./zip');
const { Catalog } = require('./catalog');
const { RemoteRegistry } = require('./remote-registry');

class SkillManager {
    /**
     * @param {object} opts { workDir, logger, runtime }
     */
    constructor(opts) {
        this.runtime = opts.runtime;
        this.logger = opts.logger;
        this.root = path.join(opts.workDir, 'agent-skills');
        this.statePath = path.join(this.root, 'state.json');
        /** @type {Map<string, {manifest, dir, enabled, kind, pack?, error?}>} */
        this.skills = new Map();
        this.templates = new TemplateRegistry();
        this.builtinsDir = path.join(__dirname, 'builtins');
        this.catalog = new Catalog(this.builtinsDir);
        this.remoteRegistry = null;
        this._instructions = new Map();
    }

    async init() {
        try { await fsp.mkdir(this.root, { recursive: true }); } catch (_) {}
        const state = this._readState();
        const entries = await fsp.readdir(this.root, { withFileTypes: true }).catch(() => []);
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            const slug = ent.name;
            const dir = path.join(this.root, slug);
            try {
                const manifest = this._readManifest(dir);
                if (manifest.slug !== slug) {
                    this.logger?.warn?.(`agent.skills: slug mismatch for ${slug} (manifest says ${manifest.slug}); skipping`);
                    continue;
                }
                const enabled = state[slug]?.enabled !== false;
                this.skills.set(slug, {
                    manifest, dir, enabled, kind: manifest.kind, installedAt: state[slug]?.installedAt
                });
                if (enabled) this._activate(slug);
            } catch (err) {
                this.logger?.warn?.(`agent.skills: failed to load ${slug}: ${err.message}`);
                this.skills.set(slug, { manifest: { slug }, dir, enabled: false, error: String(err.message) });
            }
        }
        // Auto-install built-in skills.
        await this.catalog.init();
        for (const entry of this.catalog.list()) {
            if (this.skills.has(entry.slug)) continue;
            try {
                await this._installFromDir(entry.dir);
                this.logger?.info?.(`agent.skills: auto-installed builtin ${entry.slug}`);
            } catch (err) {
                this.logger?.warn?.(`agent.skills: auto-install ${entry.slug} failed: ${err.message}`);
            }
        }
        this.logger?.info?.(`agent.skills: ${this.skills.size} loaded`);
    }

    list() {
        return Array.from(this.skills.values()).map(s => ({
            slug: s.manifest.slug,
            name: s.manifest.name || s.manifest.slug,
            version: s.manifest.version || null,
            kind: s.kind,
            description: s.manifest.description || '',
            author: s.manifest.author || '',
            enabled: !!s.enabled,
            installedAt: s.installedAt || null,
            error: s.error || null
        }));
    }

    /** Tool packs that the tool-router should expose to the LLM. */
    getToolPacks() {
        const out = [];
        for (const s of this.skills.values()) {
            if (s.enabled && s.kind === 'tool-pack' && s.pack) out.push(s.pack);
        }
        return out;
    }

    getInstructions() {
        const parts = [];
        for (const [slug, text] of this._instructions) {
            const s = this.skills.get(slug);
            if (s?.enabled) parts.push(`## ${s.manifest.name || slug}\n\n${text}`);
        }
        return parts.join('\n\n');
    }

    async installFromDir(srcDir) {
        return this._installFromDir(srcDir);
    }

    getCatalog() {
        return this.catalog;
    }

    getRemoteRegistry() {
        return this.remoteRegistry;
    }

    setRemoteApiKey(key) {
        this.remoteRegistry = key ? new RemoteRegistry(key) : null;
    }

    setEnabled(slug, enabled) {
        const s = this.skills.get(slug);
        if (!s) throw new Error('skill not found: ' + slug);
        if (s.enabled === enabled) return this._public(s);
        s.enabled = !!enabled;
        if (s.enabled) this._activate(slug);
        else this._deactivate(slug);
        this._writeState();
        return this._public(s);
    }

    /**
     * Install from an in-memory zip buffer. The skill slug is taken from
     * skill.json after extraction; if a skill with the same slug exists it is
     * replaced.
     */
    async installFromZipBuffer(buf) {
        const tmp = path.join(this.root, '.staging-' + Date.now());
        const tmpZip = tmp + '.zip';
        await fsp.mkdir(this.root, { recursive: true });
        await fsp.writeFile(tmpZip, buf);
        try {
            await fsp.mkdir(tmp, { recursive: true });
            extractZip(tmpZip, tmp);

            // Skill payload may live at tmp/ or tmp/<one-folder>/ — flatten if needed.
            let payloadDir = tmp;
            const entries = await fsp.readdir(tmp, { withFileTypes: true });
            const hasManifest = entries.some(e => e.isFile() && e.name === 'skill.json');
            if (!hasManifest) {
                const dirs = entries.filter(e => e.isDirectory());
                if (dirs.length === 1) {
                    const inner = path.join(tmp, dirs[0].name);
                    if (fs.existsSync(path.join(inner, 'skill.json'))) {
                        payloadDir = inner;
                    }
                }
            }

            const manifest = this._readManifest(payloadDir);
            const slug = manifest.slug;
            const target = path.join(this.root, slug);

            if (fs.existsSync(target)) {
                await this._rmrf(target);
            }
            await this._move(payloadDir, target);

            const state = this._readState();
            state[slug] = { enabled: true, installedAt: Date.now() };
            this._writeState(state);

            this.skills.set(slug, {
                manifest, dir: target, enabled: true, kind: manifest.kind, installedAt: state[slug].installedAt
            });
            this._activate(slug);
            return this._public(this.skills.get(slug));
        } finally {
            try { await fsp.unlink(tmpZip); } catch (_) {}
            try { await this._rmrf(tmp); } catch (_) {}
        }
    }

    async uninstall(slug) {
        const s = this.skills.get(slug);
        if (!s) throw new Error('skill not found: ' + slug);
        this._deactivate(slug);
        this.skills.delete(slug);
        const state = this._readState();
        delete state[slug];
        this._writeState(state);
        try { await this._rmrf(s.dir); } catch (_) {}
        return { ok: true, slug };
    }

    // ---- internal ----
    _public(s) {
        return {
            slug: s.manifest.slug,
            name: s.manifest.name || s.manifest.slug,
            version: s.manifest.version || null,
            kind: s.kind,
            enabled: !!s.enabled,
            installedAt: s.installedAt || null,
            error: s.error || null
        };
    }

    _readManifest(dir) {
        const p = path.join(dir, 'skill.json');
        const raw = fs.readFileSync(p, 'utf8');
        const m = JSON.parse(raw);
        const errs = validate(m);
        if (errs.length) throw new Error('invalid skill.json: ' + errs.join('; '));
        return m;
    }

    async _installFromDir(srcDir) {
        if (!fs.existsSync(srcDir)) throw new Error('source dir not found: ' + srcDir);
        const manifest = this._readManifest(srcDir);
        const slug = manifest.slug;
        const target = path.join(this.root, slug);

        if (fs.existsSync(target)) {
            await this._rmrf(target);
        }
        await this._copyDir(srcDir, target);

        const state = this._readState();
        state[slug] = { enabled: true, installedAt: Date.now() };
        this._writeState(state);

        this.skills.set(slug, {
            manifest, dir: target, enabled: true, kind: manifest.kind, installedAt: state[slug].installedAt
        });
        this._activate(slug);
        return this._public(this.skills.get(slug));
    }

    _activate(slug) {
        const s = this.skills.get(slug);
        if (!s) return;
        s.error = null;
        try {
            if (s.kind === 'tool-pack') {
                const main = path.resolve(s.dir, s.manifest.main);
                if (!main.startsWith(path.resolve(s.dir))) throw new Error('main escapes skill dir');
                delete require.cache[require.resolve(main)];
                const mod = require(main);
                if (typeof mod.descriptors !== 'function' || typeof mod.executors !== 'function') {
                    throw new Error('tool-pack must export descriptors() and executors(ctx)');
                }
                s.pack = this._wrapPack(s.manifest.slug, mod);
            } else if (s.kind === 'asset-pack') {
                const tplPath = path.resolve(s.dir, s.manifest.templates);
                if (!tplPath.startsWith(path.resolve(s.dir))) throw new Error('templates escapes skill dir');
                const defs = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
                this.templates.unregisterSource(s.manifest.slug);
                this.templates.register(s.manifest.slug, Array.isArray(defs) ? defs : (defs.templates || []));
            } else if (s.kind === 'instruction-pack') {
                const instrFile = path.resolve(s.dir, s.manifest.instructions);
                if (!instrFile.startsWith(path.resolve(s.dir))) throw new Error('instructions escapes skill dir');
                const text = fs.readFileSync(instrFile, 'utf8');
                this._instructions.set(slug, text);
            } else if (s.kind === 'mcp-bridge') {
                // Phase 4 — accepted but not started yet.
            }
        } catch (err) {
            s.error = String(err.message || err);
            s.enabled = false;
            this.logger?.warn?.(`agent.skills: activate ${slug} failed: ${s.error}`);
        }
    }

    _deactivate(slug) {
        const s = this.skills.get(slug);
        if (!s) return;
        if (s.kind === 'asset-pack') {
            this.templates.unregisterSource(slug);
        }
        if (s.pack) {
            s.pack = null;
        }
        if (s.kind === 'instruction-pack') {
            this._instructions.delete(slug);
        }
        if (s.kind === 'tool-pack') {
            try {
                const main = path.resolve(s.dir, s.manifest.main || 'index.js');
                delete require.cache[require.resolve(main)];
            } catch (_) {}
        }
    }

    _wrapPack(slug, mod) {
        // Namespace every descriptor name as "<slug>.<original>" and route
        // executors by stripping the same prefix back off.
        return {
            slug,
            descriptors() {
                const list = mod.descriptors() || [];
                return list.map(d => Object.assign({}, d, {
                    name: `${slug}.${d.name}`
                }));
            },
            executors(ctx) {
                const inner = mod.executors(ctx) || {};
                const out = {};
                for (const [k, fn] of Object.entries(inner)) {
                    out[`${slug}.${k}`] = fn;
                }
                return out;
            }
        };
    }

    _readState() {
        try { return JSON.parse(fs.readFileSync(this.statePath, 'utf8')); }
        catch (_) { return {}; }
    }

    _writeState(state) {
        const data = state || {};
        if (!state) {
            for (const [slug, s] of this.skills) {
                data[slug] = { enabled: s.enabled, installedAt: s.installedAt || null };
            }
        }
        fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2));
    }

    async _rmrf(p) {
        if (!fs.existsSync(p)) return;
        await fsp.rm(p, { recursive: true, force: true });
    }

    async _move(src, dst) {
        try {
            await fsp.rename(src, dst);
        } catch (_) {
            // cross-device fallback: copy + remove
            await this._copyDir(src, dst);
            await this._rmrf(src);
        }
    }

    async _copyDir(src, dst) {
        await fsp.mkdir(dst, { recursive: true });
        const entries = await fsp.readdir(src, { withFileTypes: true });
        for (const e of entries) {
            const s = path.join(src, e.name);
            const d = path.join(dst, e.name);
            if (e.isDirectory()) await this._copyDir(s, d);
            else await fsp.copyFile(s, d);
        }
    }
}

module.exports = { SkillManager };
