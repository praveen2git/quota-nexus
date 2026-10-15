'use strict';

const { contextWindowFor, formatTokens, pathsOverlap } = require('./util');

const SHORT = { gemini: 'Gem', claude: 'Cl', 'gpt-oss': 'GPT' };
// The server lists models in a varying order; sort so pool names and ids stay stable.
const FAMILY_ORDER = ['gemini', 'claude', 'gpt-oss'];

function familyRank(f) {
    const i = FAMILY_ORDER.indexOf(f.toLowerCase());
    return i < 0 ? FAMILY_ORDER.length : i;
}

function byFamily(a, b) {
    return familyRank(a) - familyRank(b) || a.localeCompare(b);
}

function familyOf(label) {
    return String(label || 'Other').trim().split(/\s+/)[0] || 'Other';
}

function shortOf(family) {
    return SHORT[family.toLowerCase()] || family.slice(0, 3);
}

function commonPrefix(labels) {
    const clean = labels.map(l => l.replace(/\s*\(.*?\)\s*/g, ' ').trim());
    if (clean.length === 0) return '';
    let p = clean[0];
    for (const l of clean.slice(1)) {
        while (p && !l.startsWith(p)) p = p.slice(0, -1);
    }
    return p.trim();
}

function str(v, max) {
    return typeof v === 'string' ? v.slice(0, max) : '';
}

function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
}

// Arg ports first; anything the pid does not actually listen on is dropped.
function orderPorts(argPorts, listening) {
    if (!listening || !listening.length) return { ports: argPorts.slice(), verified: false };
    const owned = new Set(listening);
    const first = argPorts.filter(p => owned.has(p));
    return { ports: first.concat(listening.filter(p => !first.includes(p))), verified: true };
}

function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pool';
}

// Models that share one quota report identical fraction + reset time, so group by that.
function parseUserStatus(raw) {
    const us = raw && raw.userStatus;
    if (!us) return null;
    const configs = (us.cascadeModelConfigData && us.cascadeModelConfigData.clientModelConfigs) || [];
    const modelLabels = {};
    const groups = new Map();

    for (const c of Array.isArray(configs) ? configs : []) {
        if (!c || typeof c !== 'object') continue;
        const label = str(c.label, 100);
        const model = c.modelOrAlias && str(c.modelOrAlias.model, 200);
        if (model && label) modelLabels[model] = label;
        if (c.modelId && label) modelLabels[str(c.modelId, 200)] = label;
        const q = c.quotaInfo || {};
        const hasFrac = typeof q.remainingFraction === 'number' && isFinite(q.remainingFraction);
        const resetTime = typeof q.resetTime === 'string' && !isNaN(Date.parse(q.resetTime)) ? q.resetTime : null;
        if (!hasFrac && !resetTime) continue;
        const frac = hasFrac ? Math.max(0, Math.min(1, q.remainingFraction)) : 0;
        const key = `${frac}|${resetTime || ''}`;
        if (!groups.has(key)) {
            groups.set(key, { remainingPct: Math.round(frac * 100), resetTime, models: [] });
        }
        groups.get(key).models.push(label);
    }

    const pools = [...groups.values()].map(g => {
        const models = g.models.slice().sort((a, b) => a.localeCompare(b));
        const families = [...new Set(models.map(familyOf))].sort(byFamily);
        return { ...g, models, families, name: families.join(' / '), short: families.map(shortOf).join('/') };
    }).sort((a, b) => byFamily(a.families[0], b.families[0]) || a.name.localeCompare(b.name) || a.models[0].localeCompare(b.models[0]));
    const nameCount = {};
    for (const p of pools) nameCount[p.name] = (nameCount[p.name] || 0) + 1;
    const usedIds = new Set();
    for (const p of pools) {
        if (nameCount[p.name] > 1) p.name = commonPrefix(p.models) || p.name;
        let id = slug(p.name);
        while (usedIds.has(id)) id += '-x';
        usedIds.add(id);
        p.id = id;
        delete p.families;
    }

    const ps = us.planStatus || {};
    const pi = ps.planInfo || {};
    const credits = {};
    if (num(ps.availablePromptCredits) !== null) {
        credits.prompt = { available: ps.availablePromptCredits, monthly: num(pi.monthlyPromptCredits) };
    }
    if (num(ps.availableFlowCredits) !== null) {
        credits.flow = { available: ps.availableFlowCredits, monthly: num(pi.monthlyFlowCredits) };
    }

    return {
        email: str(us.email, 320),
        name: str(us.name, 200),
        planName: str(pi.planName, 60) || (us.userTier && str(us.userTier.name, 60)) || 'Unknown',
        credits,
        pools,
        modelLabels
    };
}

// One "pid commandline" per line; keeps processes that carry a csrf token.
// ps etime: [[dd-]hh:]mm:ss
function etimeMs(s) {
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s || '');
    if (!m) return null;
    return ((+(m[1] || 0) * 24 + +(m[2] || 0)) * 3600 + +m[3] * 60 + +m[4]) * 1000;
}

// Lines are "pid [start] command": start is epoch ms (Windows) or ps etime (macOS/Linux).
function parseProcessLines(text, now = Date.now()) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(?:(\d{12,14}|(?:\d+-)?(?:\d+:)?\d+:\d+)\s+)?(.+)$/);
        if (!m) continue;
        const cmd = m[3];
        if (!/(^|[\\/\s"])agy(\.exe)?["\s]|language_server/i.test(cmd + ' ')) continue;
        const csrf = cmd.match(/--csrf_token[=\s]+["']?([^\s"']+)/);
        if (!csrf) continue;
        const ports = [...cmd.matchAll(/--[a-z_-]*port[=\s]+(\d+)/gi)].map(x => parseInt(x[1], 10));
        const age = m[2] && m[2].includes(':') ? etimeMs(m[2]) : null;
        const started = m[2] ? (age === null ? Number(m[2]) : now - age) : 0;
        out.push({ pid: parseInt(m[1], 10), csrf: csrf[1], ports: [...new Set(ports)], started });
    }
    return out;
}

// Newest server first: after a switch the old agy hub can linger, still signed in to the old account.
function newestFirst(found) {
    return [...found].sort((a, b) => (b.started || 0) - (a.started || 0) || b.pid - a.pid);
}

function parseNetstatListening(text, pid) {
    const ports = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        if (parseInt(parts[parts.length - 1], 10) !== pid) continue;
        const pm = (parts[1] || '').match(/:(\d+)$/);
        if (pm) ports.push(parseInt(pm[1], 10));
    }
    return [...new Set(ports)];
}

function parseLsofListening(text) {
    return [...new Set([...String(text || '').matchAll(/:(\d+) \(LISTEN\)/g)].map(m => parseInt(m[1], 10)))];
}

function trajectoryTime(sum) {
    const t = Date.parse(sum.lastModifiedTime || sum.lastUserInputTime || '');
    return isNaN(t) ? 0 : t;
}

// Newest conversation, preferring ones tied to an open workspace folder.
function pickTrajectory(summaries, wsPaths) {
    let best = null;
    let bestScore = -1;
    for (const [id, sum] of Object.entries(summaries || {})) {
        const t = trajectoryTime(sum);
        const inWs = Array.isArray(sum.workspaces) && (wsPaths || []).some(ws =>
            sum.workspaces.some(w => pathsOverlap(w.workspaceFolderAbsoluteUri, ws)));
        const score = (inWs ? 1e13 : 0) + t;
        if (score > bestScore) {
            bestScore = score;
            best = { id, summary: sum, time: t };
        }
    }
    return best;
}

// gemini-3.8-flash-n -> "Gemini 3.8 Flash": match a known label, else title-case the id.
function prettyModel(raw, modelLabels) {
    if (!raw || typeof raw !== 'string') return 'Unknown model';
    if (modelLabels && modelLabels[raw]) return modelLabels[raw];
    const s = raw.replace(/^models[/_-]/i, '').replace(/-n$/i, '');
    if (/^MODEL_PLACEHOLDER_/i.test(s)) return 'Unknown model';
    const words = s.toLowerCase().split(/[-_\s]+/).filter(Boolean).join(' ');
    const base = l => l.replace(/\s*\(.*?\)\s*/g, ' ').trim();
    const hit = Object.values(modelLabels || {}).map(base).find(l => l.toLowerCase() === words);
    if (hit) return hit;
    return words.replace(/\b[a-z]/g, c => c.toUpperCase()).slice(0, 100);
}

function parseGeneratorMetadata(data, modelLabels, picked) {
    const metas = (data && (data.generatorMetadata || data.generator_metadata)) || [];
    if (metas.length === 0) return null;
    const last = metas[metas.length - 1];
    const chat = last.chatModel || last.chat_model || {};
    const usage = chat.usage || {};
    const start = chat.chatStartMetadata || chat.chat_start_metadata || {};
    const cw = start.contextWindowMetadata || start.context_window_metadata || {};

    const inputTokens = parseInt(usage.inputTokens || 0, 10) || 0;
    const outputTokens = parseInt(usage.outputTokens || 0, 10) || 0;
    const cacheReadTokens = parseInt(usage.cacheReadTokens || 0, 10) || 0;
    const usedTokens = parseInt(cw.estimatedTokensUsed || 0, 10) || (inputTokens + cacheReadTokens);
    if (!usedTokens) return null;

    const model = prettyModel(last.responseModel || chat.responseModel || chat.model, modelLabels);
    const windowTokens = contextWindowFor(model);
    const totalIn = inputTokens + cacheReadTokens;
    const sum = (picked && picked.summary) || {};
    return {
        source: 'antigravity',
        title: str(sum.summary, 200) || (sum.annotations && str(sum.annotations.title, 200)) || 'Active conversation',
        model,
        usedTokens,
        windowTokens,
        pct: Math.min(100, Math.round((usedTokens / windowTokens) * 1000) / 10),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheHitRate: totalIn > 0 ? Math.round((cacheReadTokens / totalIn) * 1000) / 10 : 0,
        left: `${formatTokens(Math.max(0, windowTokens - usedTokens))} / ${formatTokens(windowTokens)}`,
        timestamp: (picked && picked.time) || Date.now()
    };
}

const WINDOW_ORDER = ['5-hour', 'Daily', 'Weekly'];

// "Five Hour Limit Remaining" or a window like "18000s" -> "5-hour".
function windowName(label, window) {
    const secs = /^(\d+)s$/.exec(window || '');
    const s = secs ? { 18000: '5-hour', 86400: 'Daily', 604800: 'Weekly' }[secs[1]] : '';
    if (/five[\s-]*hour|\b5[\s-]*h/i.test(label)) return '5-hour';
    if (/week|\b7[\s-]*d/i.test(label)) return 'Weekly';
    if (/daily|\bday\b|24[\s-]*h/i.test(label)) return 'Daily';
    return s || label.replace(/\s*limit\s*(remaining)?\s*$/i, '').trim() || 'Limit';
}

// RetrieveUserQuotaSummary: per-group 5-hour / weekly buckets, as in Antigravity's View Usage.
function parseQuotaSummary(raw) {
    const r = raw && raw.response;
    if (!r || typeof r !== 'object') return null;
    let groups = Array.isArray(r.groups) ? r.groups : [];
    if (!groups.length && Array.isArray(r.buckets)) groups = [{ displayName: 'Antigravity', buckets: r.buckets }];
    const usedIds = new Set();
    const out = [];
    for (const g of groups) {
        if (!g || typeof g !== 'object') continue;
        const name = str(g.displayName, 100) || 'Models';
        let id = slug(name);
        while (usedIds.has(id)) id += '-x';
        usedIds.add(id);
        const windows = [];
        for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
            if (!b || typeof b !== 'object' || b.disabled === true) continue;
            if (typeof b.remainingFraction !== 'number' || !isFinite(b.remainingFraction)) continue;
            const wName = windowName(str(b.displayName, 100), str(b.window, 40));
            let wid = `${id}-${slug(wName)}`;
            while (windows.some(w => w.id === wid)) wid += '-x';
            windows.push({
                id: wid,
                name: wName,
                remainingPct: Math.round(Math.max(0, Math.min(1, b.remainingFraction)) * 100),
                resetTime: typeof b.resetTime === 'string' && !isNaN(Date.parse(b.resetTime)) ? b.resetTime : null
            });
        }
        const rank = w => (WINDOW_ORDER.indexOf(w.name) + 1) || 99;
        windows.sort((a, b) => rank(a) - rank(b));
        if (windows.length) out.push({ id, name, windows });
    }
    return out.length ? out : null;
}

// A pool's left % is its group's tightest limit; no match means stale or another account's limits.
function limitsMatch(pools, groups) {
    if (!groups || !groups.length || !pools || !pools.length) return true;
    const mins = groups.map(g => Math.min(...g.windows.map(w => w.remainingPct)));
    return pools.every(p => mins.some(m => Math.abs(m - p.remainingPct) <= 3));
}

module.exports = {
    parseUserStatus, parseProcessLines, parseNetstatListening, parseLsofListening,
    pickTrajectory, parseGeneratorMetadata, familyOf, orderPorts, newestFirst, etimeMs,
    parseQuotaSummary, limitsMatch
};
