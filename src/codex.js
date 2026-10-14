'use strict';

const fsp = require('fs').promises;
const path = require('path');
const { readTail, statSafe, TAIL_STEPS, FRESH_MS } = require('./claudeCode');
const { contextWindowFor, formatTokens, pathsOverlap, clampPct } = require('./util');

const RECENT_FILES = 12;
const HEAD_BYTES = 16 * 1024;

function windowName(minutes) {
    const m = Number(minutes);
    if (!m) return 'Limit';
    if (m === 10080) return 'Weekly';
    if (m < 1440 && m % 60 === 0) return `${m / 60}-hour`;
    if (m % 1440 === 0) return `${m / 1440}-day`;
    return `${m}-min`;
}

function toIso(ms) {
    return typeof ms === 'number' && isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : null;
}

// Older Codex builds wrote resets_in_seconds instead of resets_at.
function limitWindow(w, eventMs) {
    if (!w || typeof w.used_percent !== 'number' || !isFinite(w.used_percent)) return null;
    let resetMs = null;
    if (typeof w.resets_at === 'number') resetMs = w.resets_at > 1e12 ? w.resets_at : w.resets_at * 1000;
    else if (typeof w.resets_in_seconds === 'number' && eventMs) resetMs = eventMs + w.resets_in_seconds * 1000;
    const minutes = typeof w.window_minutes === 'number' && isFinite(w.window_minutes) ? w.window_minutes : 0;
    return { name: windowName(minutes), minutes, pct: Math.round(clampPct(w.used_percent)), resetsAt: toIso(resetMs) };
}

// Scans a session tail for the newest token_count event and model.
function parseCodexLines(lines) {
    let tokenEvent = null;
    let limitsEvent = null;
    let model = '';
    for (let i = lines.length - 1; i >= 0 && !(tokenEvent && limitsEvent && model); i--) {
        const line = lines[i];
        const isToken = line.includes('"token_count"');
        const isTurn = !model && line.includes('"turn_context"');
        if (!isToken && !isTurn) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { continue; }
        const p = o && o.payload;
        if (!p) continue;
        if (o.type === 'turn_context' && typeof p.model === 'string') model = p.model.slice(0, 100);
        if (p.type === 'token_count') {
            const ts = Date.parse(o.timestamp || '') || 0;
            if (!tokenEvent && p.info && p.info.last_token_usage) tokenEvent = { info: p.info, ts };
            if (!limitsEvent && p.rate_limits && (p.rate_limits.primary || p.rate_limits.secondary)) limitsEvent = { rl: p.rate_limits, ts };
        }
    }
    if (!tokenEvent && !limitsEvent) return null;
    return { tokenEvent, limitsEvent, model };
}

function buildCodexContext(parsed, mtime) {
    const t = parsed.tokenEvent;
    if (!t) return null;
    const last = t.info.last_token_usage || {};
    const total = last.total_tokens || ((last.input_tokens || 0) + (last.output_tokens || 0));
    const usedTokens = Math.max(0, total - (last.reasoning_output_tokens || 0));
    if (!usedTokens) return null;
    const model = parsed.model || 'Codex';
    const mcw = t.info.model_context_window;
    const exact = typeof mcw === 'number' && isFinite(mcw) && mcw > 0;
    const windowTokens = exact ? mcw : contextWindowFor(model);
    return {
        source: 'codex',
        model,
        usedTokens,
        windowTokens,
        windowExact: exact,
        pct: Math.min(100, Math.round((usedTokens / windowTokens) * 1000) / 10),
        inputTokens: last.input_tokens || 0,
        cacheReadTokens: last.cached_input_tokens || 0,
        left: `${formatTokens(Math.max(0, windowTokens - usedTokens))} / ${formatTokens(windowTokens)}`,
        timestamp: t.ts || mtime
    };
}

function buildCodexLimits(parsed) {
    const l = parsed.limitsEvent;
    if (!l) return null;
    const windows = [l.rl.primary, l.rl.secondary].map(w => limitWindow(w, l.ts)).filter(Boolean);
    if (!windows.length) return null;
    const c = l.rl.credits || {};
    let credits = null;
    if (c.unlimited) credits = 'Unlimited credits';
    else if (c.has_credits && (typeof c.balance === 'number' || typeof c.balance === 'string')) credits = `Credits: ${String(c.balance).slice(0, 20)}`;
    return { windows, plan: typeof l.rl.plan_type === 'string' ? l.rl.plan_type.slice(0, 40) : '', credits, at: l.ts };
}

async function sortedDirs(dir) {
    try {
        return (await fsp.readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
    } catch (e) {
        return [];
    }
}

// sessions/YYYY/MM/DD/rollout-*.jsonl; walk newest days first.
async function recentFiles(root, max) {
    const out = [];
    for (const y of await sortedDirs(root)) {
        for (const m of await sortedDirs(path.join(root, y))) {
            for (const d of await sortedDirs(path.join(root, y, m))) {
                const dir = path.join(root, y, m, d);
                let names = [];
                try { names = (await fsp.readdir(dir)).filter(n => n.endsWith('.jsonl')); } catch (e) { /* unreadable day */ }
                const stats = await Promise.all(names.map(async n => {
                    const full = path.join(dir, n);
                    const st = await statSafe(full);
                    return st ? { path: full, mtime: st.mtimeMs, size: st.size } : null;
                }));
                out.push(...stats.filter(Boolean));
                if (out.length >= max) return out.sort((a, b) => b.mtime - a.mtime).slice(0, max);
            }
        }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
}

class CodexReader {
    constructor(home) {
        this.root = path.join(home, '.codex', 'sessions');
        this.parsed = new Map();
        this.cwds = new Map();
    }

    async parse(f) {
        const c = this.parsed.get(f.path);
        if (c && c.mtime === f.mtime && c.size === f.size) return c.result;
        let result = null;
        for (const step of TAIL_STEPS) {
            try { result = parseCodexLines(await readTail(f.path, f.size, step)); } catch (e) { break; }
            if ((result && result.tokenEvent && result.model) || step >= f.size) break;
        }
        this.parsed.set(f.path, { mtime: f.mtime, size: f.size, result });
        return result;
    }

    async cwdOf(f) {
        if (this.cwds.has(f.path)) return this.cwds.get(f.path);
        let cwd = '';
        try {
            const fh = await fsp.open(f.path, 'r');
            try {
                const buf = Buffer.alloc(Math.min(HEAD_BYTES, f.size));
                await fh.read(buf, 0, buf.length, 0);
                const m = buf.toString('utf8').match(/"cwd":"((?:[^"\\]|\\.)*)"/);
                if (m) cwd = JSON.parse(`"${m[1]}"`);
            } finally {
                await fh.close();
            }
        } catch (e) { /* no cwd */ }
        this.cwds.set(f.path, cwd);
        return cwd;
    }

    async read(wsPaths) {
        const files = await recentFiles(this.root, RECENT_FILES);
        if (!files.length) return null;
        const live = new Set(files.map(f => f.path));
        for (const k of this.parsed.keys()) if (!live.has(k)) this.parsed.delete(k);

        let limits = null;
        for (const f of files.slice(0, 3)) {
            const p = await this.parse(f);
            limits = p && buildCodexLimits(p);
            if (limits) break;
        }

        let target = files[0];
        if (wsPaths && wsPaths.length) {
            for (const f of files.filter(x => Date.now() - x.mtime <= FRESH_MS)) {
                const cwd = await this.cwdOf(f);
                if (cwd && wsPaths.some(ws => pathsOverlap(cwd, ws))) { target = f; break; }
            }
        }
        const p = await this.parse(target);
        const context = p ? buildCodexContext(p, target.mtime) : null;
        return context || limits ? { context, limits } : null;
    }
}

module.exports = { CodexReader, parseCodexLines, buildCodexContext, buildCodexLimits, windowName };
