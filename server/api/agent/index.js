/**
 * 'api/agent': REST endpoints for the Agent (settings, sessions, messages, undo).
 */
'use strict';

const express = require('express');
const authJwt = require('../jwt-helper');

let runtime;
let secureFnc;
let checkGroupsFnc;

module.exports = {
    init: function (_runtime, _secureFnc, _checkGroupsFnc) {
        runtime = _runtime;
        secureFnc = _secureFnc;
        checkGroupsFnc = _checkGroupsFnc;
    },
    app: function () {
        const app = express();

        app.use(function (req, res, next) {
            if (!runtime || !runtime.agentMgr) {
                return res.status(503).json({ error: 'agent_not_ready' });
            }
            next();
        });

        // ---- Settings (admin-only) ----

        app.get('/api/agent/settings', secureFnc, function (req, res) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) {
                runtime.logger.error('api get agent.settings: Token Expired');
                return;
            }
            if (!authJwt.haveAdminPermission(permission)) {
                return res.status(401).json({ error: 'unauthorized_error', message: 'Unauthorized!' });
            }
            try {
                res.json(runtime.agentMgr.getSettingsStore().getPublic());
            } catch (err) {
                res.status(500).json({ error: 'agent_settings_read', message: String(err) });
            }
        });

        app.put('/api/agent/settings', secureFnc, function (req, res) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) {
                runtime.logger.error('api put agent.settings: Token Expired');
                return;
            }
            if (!authJwt.haveAdminPermission(permission)) {
                return res.status(401).json({ error: 'unauthorized_error', message: 'Unauthorized!' });
            }
            try {
                const out = runtime.agentMgr.getSettingsStore().update(req.body || {});
                res.json(out);
            } catch (err) {
                res.status(400).json({ error: 'agent_settings_write', message: String(err) });
            }
        });

        app.post('/api/agent/settings/test', secureFnc, async function (req, res) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) {
                return;
            }
            if (!authJwt.haveAdminPermission(permission)) {
                return res.status(401).json({ error: 'unauthorized_error' });
            }
            try {
                const r = await runtime.agentMgr.testConnection(req.body || {});
                res.json(r);
            } catch (err) {
                // Return 200 with ok:false so the frontend can display the error cleanly.
                res.json({
                    ok: false,
                    error: err?.response?.data?.error || err?.response?.data || String(err?.message || err)
                });
            }
        });

        // ---- Skills (admin-only) ----

        function requireAdmin(req, res) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) return false;
            if (!authJwt.haveAdminPermission(permission)) {
                res.status(401).json({ error: 'unauthorized_error' });
                return false;
            }
            return true;
        }

        function requireEditorOrAdmin(req, res) {
            const permission = checkGroupsFnc(req);
            if (res.statusCode === 403) return false;
            // FUXA does not expose haveEditorPermission yet; falls back to admin check.
            const editorOk = typeof authJwt.haveEditorPermission === 'function'
                ? authJwt.haveEditorPermission(permission) : false;
            if (!editorOk && !authJwt.haveAdminPermission(permission)) {
                res.status(401).json({ error: 'unauthorized_error' });
                return false;
            }
            return true;
        }

        app.get('/api/agent/skills', secureFnc, function (req, res) {
            if (!requireAdmin(req, res)) return;
            try {
                const mgr = runtime.agentMgr.getSkillManager();
                if (!mgr) return res.json([]);
                res.json(mgr.list());
            } catch (err) {
                res.status(500).json({ error: 'skills_list', message: String(err) });
            }
        });

        const rawZip = require('body-parser').raw({ type: ['application/zip', 'application/octet-stream'], limit: '20mb' });
        app.post('/api/agent/skills/install', secureFnc, rawZip, async function (req, res) {
            if (!requireAdmin(req, res)) return;
            const buf = req.body;
            if (!Buffer.isBuffer(buf) || buf.length < 22) {
                return res.status(400).json({ error: 'empty_zip' });
            }
            try {
                const mgr = runtime.agentMgr.getSkillManager();
                const out = await mgr.installFromZipBuffer(buf);
                res.json(out);
            } catch (err) {
                runtime.logger?.error?.('agent.skills.install: ' + err.message);
                res.status(400).json({ error: 'install_failed', message: String(err.message || err) });
            }
        });

        app.post('/api/agent/skills/:slug/enable', secureFnc, async function (req, res) {
            if (!requireAdmin(req, res)) return;
            try {
                const enabled = !!(req.body && req.body.enabled);
                const out = runtime.agentMgr.getSkillManager().setEnabled(req.params.slug, enabled);
                res.json(out);
            } catch (err) {
                res.status(400).json({ error: 'skill_enable_failed', message: String(err.message || err) });
            }
        });

        app.delete('/api/agent/skills/:slug', secureFnc, async function (req, res) {
            if (!requireAdmin(req, res)) return;
            try {
                const out = await runtime.agentMgr.getSkillManager().uninstall(req.params.slug);
                res.json(out);
            } catch (err) {
                res.status(400).json({ error: 'skill_uninstall_failed', message: String(err.message || err) });
            }
        });

        // ---- Sessions & Messages (editor / admin) ----

        // POST one-shot turn against the active view.
        app.post('/api/agent/sessions/:viewId/messages', secureFnc, async function (req, res) {
            if (!requireEditorOrAdmin(req, res)) return;
            const { viewId } = req.params;
            const { text, attachments, selection, sessionId } = req.body || {};

            const storage = runtime.agentMgr.getStorage();

            // Get or create a session for this view.
            let sid = sessionId;
            if (!sid && storage) {
                try {
                    let existing = await storage.getSessionByView(viewId, 'web');
                    if (existing) {
                        sid = existing.id;
                    } else {
                        sid = genId();
                        await storage.createSession(sid, viewId, 'web');
                    }
                } catch (_) {
                    sid = sid || genId();
                }
            }
            sid = sid || genId();

            try {
                const result = await runtime.agentMgr.getOrchestrator().runWebTurn({
                    viewId, userText: text, attachments, selection, sessionId: sid
                });
                res.json({ ...result, sessionId: sid });
            } catch (err) {
                runtime.logger?.error?.(`api agent.message: ${err}`);
                res.status(400).json({
                    error: err.code || 'agent_turn_failed',
                    message: String(err?.message || err)
                });
            }
        });

        // GET session history for a view.
        app.get('/api/agent/sessions/:viewId', secureFnc, async function (req, res) {
            if (!requireEditorOrAdmin(req, res)) return;
            const storage = runtime.agentMgr.getStorage();
            if (!storage) return res.json({ messages: [] });
            try {
                const session = await storage.getSessionByView(req.params.viewId, 'web');
                if (!session) return res.json({ sessionId: null, messages: [] });
                const messages = await storage.getMessages(session.id);
                res.json({
                    sessionId: session.id,
                    viewId: session.view_id,
                    messages: messages.map(m => ({
                        id: m.id,
                        role: m.role,
                        content: JSON.parse(m.content),
                        createdAt: m.created_at
                    }))
                });
            } catch (err) {
                res.status(500).json({ error: 'session_read', message: String(err) });
            }
        });

        // DELETE clear session history for a view.
        app.delete('/api/agent/sessions/:viewId', secureFnc, async function (req, res) {
            if (!requireEditorOrAdmin(req, res)) return;
            const storage = runtime.agentMgr.getStorage();
            if (!storage) return res.json({ ok: true });
            try {
                const session = await storage.getSessionByView(req.params.viewId, 'web');
                if (session) {
                    await storage.deleteMessages(session.id);
                    await storage.deleteChanges(session.id);
                }
                res.json({ ok: true });
            } catch (err) {
                res.status(500).json({ error: 'session_clear', message: String(err) });
            }
        });

        // POST undo last agent change on a view.
        app.post('/api/agent/sessions/:viewId/undo', secureFnc, async function (req, res) {
            if (!requireEditorOrAdmin(req, res)) return;
            try {
                const result = await runtime.agentMgr.getOrchestrator().undo(req.params.viewId);
                res.json(result);
            } catch (err) {
                runtime.logger?.error?.(`api agent.undo: ${err}`);
                res.status(400).json({ error: 'undo_failed', message: String(err?.message || err) });
            }
        });

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

        return app;
    }
};

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
