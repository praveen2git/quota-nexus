'use strict';

const fsp = require('fs').promises;
const path = require('path');
const https = require('https');
const { contextWindowFor, formatTokens, clampPct } = require('./util');

const TAIL_STEPS = [64 * 1024, 1024 * 1024, 8 * 1024 * 1024];
const FALLBACK_DIRS = 5;
const MAX_BODY_BYTES = 1024 * 1024;
// A workspace session older than this loses to the newest session anywhere.
const FRESH_MS = 12 * 3600e3;
const USER_AGENT = 'quota-nexus/1.2.0';

// Claude Code names each project folder after its cwd with non-alphanumerics as '-'.
function encodeProjectDir(p) {
    return String(p || '').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}

function findLastUsage(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"usage"')) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }
        if (!obj || obj.isSidechain) continue;
        const msg = obj.message;
        if (!msg || !msg.usage || msg.model === '<synthetic>') continue;
        const model = typeof msg.model === 'string' ? msg.model.slice(0, 100) : '';
        return { model, usage: msg.usage, timestamp: Date.parse(obj.timestamp || '') || 0 };
    }
    return null;
}

async function readTail(file, size, bytes) {
    const start = Math.max(0, size - bytes);
    const fh = await fsp.open(file, 'r');
    try {
        const buf = Buffer.alloc(size - start);
        await fh.read(buf, 0, buf.length, start);
        const lines = buf.toString('utf8').split('\n');
        if (start > 0) lines.shift();
        return lines;
    } finally {
        await fh.close();
    }
}

function buildContext(found, mtime) {
    const u = found.usage;
    const n = v => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);
    const inputTokens = n(u.input_tokens);
    const cacheRead = n(u.cache_read_input_tokens);
    const cacheCreation = n(u.cache_creation_input_tokens);
    const usedTokens = inputTokens + cacheRead + cacheCreation;
    const windowTokens = contextWindowFor(found.model);
    return {
        source: 'claudeCode',
        model: found.model || 'Claude',
        usedTokens,
        windowTokens,
        pct: Math.min(100, Math.round((usedTokens / windowTokens) * 1000) / 10),
        inputTokens,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        left: `${formatTokens(Math.max(0, windowTokens - usedTokens))} / ${formatTokens(windowTokens)}`,
        timestamp: found.timestamp || mtime
    };
}

async function statSafe(p) {
    try { return await fsp.stat(p); } catch (e) { return null; }
}

class ClaudeContextReader {
    constructor(home) {
        this.projectsDir = path.join(home, '.claude', 'projects');
        this.cache = null;
    }

    async dirNames() {
        try {
            return (await fsp.readdir(this.projectsDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
        } catch (e) {
            return [];
        }
    }

    async recentDirs(dirs) {
        const stats = await Promise.all(dirs.map(async d => {
            const full = path.join(this.projectsDir, d);
            const st = await statSafe(full);
            return { full, mtime: st ? st.mtimeMs : 0 };
        }));
        return stats.sort((a, b) => b.mtime - a.mtime).slice(0, FALLBACK_DIRS).map(s => s.full);
    }

    async candidateFiles(wsPaths) {
        const dirs = await this.dirNames();
        const wanted = new Set((wsPaths || []).map(encodeProjectDir));
        const preferred = dirs.filter(d => wanted.has(d.toLowerCase())).map(d => path.join(this.projectsDir, d));
        if (preferred.length) {
            const files = await this.newestFiles(preferred);
            if (files.length && Date.now() - files[0].mtime <= FRESH_MS) return files;
        }
        return this.newestFiles(await this.recentDirs(dirs));
    }

    async newestFiles(dirs) {
        const files = [];
        await Promise.all(dirs.map(async dir => {
            let names;
            try { names = await fsp.readdir(dir); } catch (e) { return; }
            await Promise.all(names.filter(n => n.endsWith('.jsonl')).map(async n => {
                const full = path.join(dir, n);
                const st = await statSafe(full);
                if (st) files.push({ path: full, mtime: st.mtimeMs, size: st.size });
            }));
        }));
        return files.sort((a, b) => b.mtime - a.mtime).slice(0, 3);
    }

    async read(wsPaths) {
        const files = await this.candidateFiles(wsPaths);
        for (const f of files) {
            const c = this.cache;
            if (c && c.path === f.path && c.mtime === f.mtime && c.size === f.size) return c.result;
            let found = null;
            for (const step of TAIL_STEPS) {
                try { found = findLastUsage(await readTail(f.path, f.size, step)); } catch (e) { break; }
                if (found || step >= f.size) break;
            }
            if (found) {
                const result = buildContext(found, f.mtime);
                this.cache = { path: f.path, mtime: f.mtime, size: f.size, result };
                return result;
            }
        }
        return null;
    }
}

function getJson(url, headers, timeout = 8000) {
    return new Promise((resolve) => {
        const req = https.request(url, {
            method: 'GET',
            timeout,
            headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers }
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', c => {
                size += c.length;
                if (size > MAX_BODY_BYTES) return req.destroy(new Error('RESPONSE_TOO_LARGE'));
                chunks.push(c);
            });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* non-JSON body */ }
                resolve({ status: res.statusCode, data: json });
            });
        });
        req.on('error', () => resolve({ status: 0, data: null }));
        req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
        req.end();
    });
}

// Opt-in. Read-only: never refreshes or rewrites the Claude Code token file.
async function fetchClaudeUsage(home) {
    let creds;
    try {
        creds = JSON.parse(await fsp.readFile(path.join(home, '.claude', '.credentials.json'), 'utf8'));
    } catch (e) {
        return { error: 'Claude Code sign-in file not found' };
    }
    const o = creds && creds.claudeAiOauth;
    if (!o || typeof o.accessToken !== 'string' || !/^[\x21-\x7e]{10,4096}$/.test(o.accessToken)) {
        return { error: 'Claude Code is not signed in' };
    }
    if (o.expiresAt && Date.now() >= o.expiresAt - 60000) {
        return { error: 'Token expired - run Claude Code once to renew it' };
    }
    const res = await getJson('https://api.anthropic.com/api/oauth/usage', {
        Authorization: `Bearer ${o.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20'
    });
    const d = res.data;
    if (res.status !== 200 || !d || !d.five_hour) return { error: `Usage request failed (HTTP ${res.status || 'error'})` };
    const win = w => ({
        pct: Math.round(clampPct(w && w.utilization)),
        resetsAt: w && typeof w.resets_at === 'string' && !isNaN(Date.parse(w.resets_at)) ? w.resets_at : null
    });
    return { updatedAt: Date.now(), fiveHour: win(d.five_hour), weekly: win(d.seven_day) };
}

module.exports = { ClaudeContextReader, fetchClaudeUsage, findLastUsage, encodeProjectDir, readTail, statSafe, TAIL_STEPS, FRESH_MS };
