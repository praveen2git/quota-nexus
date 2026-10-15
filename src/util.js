'use strict';

function clampPct(n) {
    const v = Number(n);
    if (!isFinite(v)) return 0;
    return Math.max(0, Math.min(100, v));
}

function formatCountdown(iso, now = Date.now()) {
    const t = Date.parse(iso || '');
    if (isNaN(t)) return '';
    const diff = t - now;
    if (diff <= 0) return 'now';
    const mins = Math.floor(diff / 60000);
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${Math.max(1, m)}m`;
}

function formatWallClock(iso, now = Date.now()) {
    const t = Date.parse(iso || '');
    if (isNaN(t)) return '';
    const d = new Date(t);
    const opts = { hour: 'numeric', minute: '2-digit' };
    if (new Date(now).toDateString() !== d.toDateString()) opts.weekday = 'short';
    try {
        return d.toLocaleString(undefined, opts).replace(',', '');
    } catch (e) {
        return d.toISOString();
    }
}

function formatAgo(ts, now = Date.now()) {
    if (!ts) return 'never';
    const s = Math.round((now - ts) / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

function formatTokens(n) {
    const v = Number(n);
    if (!isFinite(v)) return '0';
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(v));
}

function maskEmail(email, on = true) {
    if (!on || !email) return email || '';
    const at = email.indexOf('@');
    if (at <= 0) return email;
    const user = email.slice(0, at);
    return user.slice(0, user.length > 3 ? 3 : 1) + '****' + email.slice(at);
}

function textBar(pct, width = 10) {
    const filled = Math.round((clampPct(pct) / 100) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// Markdown-escape untrusted text before it goes into a hover tooltip.
function escapeMarkdown(s) {
    return String(s == null ? '' : s).replace(/[\\`*_{}[\]()#+\-.!|<>~$]/g, '\\$&');
}

// Rough window sizes; the local server does not report them.
function contextWindowFor(model) {
    const m = String(model || '').toLowerCase();
    if (/\[1m\]|-1m\b/.test(m)) return 1000000;
    if (m.includes('gemini')) return 1000000;
    if (m.includes('haiku')) return 200000;
    if (/(opus|sonnet)[\s-]*(4[.-][6-9]|[5-9])/.test(m)) return 1000000;
    if (/claude|opus|sonnet/.test(m)) return 200000;
    return 1000000;
}

function normalizePath(p) {
    let s = String(p || '');
    try { s = decodeURIComponent(s); } catch (e) { /* keep raw */ }
    return s.replace(/^file:\/\//i, '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
}

function pathsOverlap(a, b) {
    const x = normalizePath(a);
    const y = normalizePath(b);
    if (!x || !y) return false;
    return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}

// "Claude and GPT models" or "Claude / GPT-OSS" -> "Claude"; GPT only names a group without Claude.
function friendlyGroup(name) {
    const n = String(name || '').toLowerCase();
    const parts = [['gemini', 'Gemini'], ['claude', 'Claude']].filter(([k]) => n.includes(k)).map(([, v]) => v);
    if (!parts.length && n.includes('gpt')) parts.push('GPT');
    return parts.length ? parts.join(' / ') : String(name || '').split(/\s+/)[0];
}

module.exports = {
    clampPct, formatCountdown, formatWallClock, formatAgo, formatTokens, maskEmail,
    textBar, escapeMarkdown, contextWindowFor, normalizePath, pathsOverlap, friendlyGroup
};
