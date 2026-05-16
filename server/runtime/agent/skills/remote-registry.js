/**
 * Remote registry client for skills.sh API.
 * Provides search and download capabilities.
 */
'use strict';

const http = require('http');
const https = require('https');

const BASE_URL = 'https://skills.sh';

class RemoteRegistry {
    constructor(apiKey) {
        this.apiKey = apiKey || '';
    }

    get available() {
        return !!this.apiKey;
    }

    async search(query, limit = 20) {
        if (!this.apiKey) return [];
        try {
            const data = await this._get(`/api/v1/skills/search?q=${encodeURIComponent(query)}&limit=${limit}`);
            if (!Array.isArray(data?.data)) return [];
            return data.data.map(s => ({
                slug: s.slug || s.id,
                name: s.name || s.slug,
                version: null,
                kind: 'instruction-pack',
                description: s.description || '',
                author: s.source || '',
                source: 'skills-sh',
                installUrl: s.installUrl || ''
            }));
        } catch (err) {
            return [];
        }
    }

    async getDetail(source, skill) {
        if (!this.apiKey) return null;
        try {
            return await this._get(`/api/v1/skills/${source}/${skill}`);
        } catch (_) {
            return null;
        }
    }

    _get(pathname) {
        return new Promise((resolve, reject) => {
            const url = `${BASE_URL}${pathname}`;
            const mod = url.startsWith('https') ? https : http;
            const req = mod.get(url, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            }, res => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch (_) { reject(new Error('invalid json')); }
                });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
        });
    }
}

module.exports = { RemoteRegistry };
