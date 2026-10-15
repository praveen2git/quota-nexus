'use strict';

const { formatCountdown, formatWallClock, formatAgo, maskEmail } = require('./util');
const { forecast, sparkline } = require('./history');

const IDLE_MS = 7 * 24 * 3600e3;

const seriesId = {
    ag: (email, poolId) => `ag:${String(email).toLowerCase()}:${poolId}`,
    cc: id => `cc:${id}`,
    cx: id => `cx:${id}`
};

function toIso(ms) {
    return new Date(ms).toISOString();
}

function forecastText(points, pctLeft, resetTime, now) {
    if (!points || pctLeft >= 100) return '';
    const f = forecast(points, pctLeft, resetTime, now);
    if (!f || f.status === 'steady') return '';
    const rate = f.drainPerHour && f.drainPerHour >= 1 ? `↓ ${f.drainPerHour}%/hr · ` : '';
    if (f.status === 'lasts') return `${rate}At this pace it lasts until the reset`;
    const iso = toIso(f.at);
    return `${rate}At this pace it runs out in ${formatCountdown(iso, now)} (${formatWallClock(iso, now)})`;
}

// Snapshots of inactive accounts go stale; a passed reset time means the pool has refilled.
function poolView(p, now, fromSnapshot, points) {
    const resetMs = Date.parse(p.resetTime || '');
    const resetPassed = fromSnapshot && !isNaN(resetMs) && resetMs <= now;
    const pct = resetPassed ? 100 : p.remainingPct;
    const f = points && pct < 100 ? forecast(points, pct, p.resetTime, now) : null;
    let pacePct = null;
    if (!isNaN(resetMs) && resetMs > now) {
        const rem = resetMs - now;
        const dur = rem > 24 * 3600e3 ? 7 * 24 * 3600e3 : (rem > 5 * 3600e3 ? 24 * 3600e3 : 5 * 3600e3);
        if (rem <= dur) pacePct = Math.round(Math.max(0, Math.min(100, (1 - rem / dur) * 100)));
    }
    return {
        id: p.id,
        name: p.name,
        short: p.short,
        models: [...new Set(p.models || [])],
        pct,
        left: pct,
        used: 100 - pct,
        estimated: resetPassed,
        pacePct,
        drainRate: f && f.drainPerHour && f.drainPerHour >= 1 ? f.drainPerHour : null,
        countdown: pct >= 100 ? '' : formatCountdown(p.resetTime, now),
        wall: pct >= 100 ? '' : formatWallClock(p.resetTime, now),
        spark: points ? sparkline(points, now) : null,
        forecast: points ? forecastText(points, pct, p.resetTime, now) : ''
    };
}

// "Used" windows (Claude Code, Codex). Log-based values may predate a reset.
function usedView(w, now, mayBeStale, points) {
    const resetMs = Date.parse(w.resetsAt || '');
    const resetPassed = mayBeStale && !isNaN(resetMs) && resetMs <= now;
    const pct = resetPassed ? 0 : w.pct;
    const f = points && pct > 0 ? forecast(points, 100 - pct, w.resetsAt, now) : null;
    let pacePct = null;
    let dur = 0;
    if (w.name.includes('5-hour') || w.name.includes('5h')) dur = 5 * 3600e3;
    else if (w.name.includes('Weekly') || w.name.includes('wk') || w.name.includes('7-day')) dur = 7 * 24 * 3600e3;
    else if (w.name.includes('Daily') || w.name.includes('24h') || w.name.includes('1-day')) dur = 24 * 3600e3;
    if (dur && !isNaN(resetMs) && resetMs > now) {
        const rem = resetMs - now;
        if (rem <= dur) pacePct = Math.round(Math.max(0, Math.min(100, (1 - rem / dur) * 100)));
    }
    return {
        id: w.id,
        name: w.name,
        pct,
        left: 100 - pct,
        used: pct,
        estimated: resetPassed,
        pacePct,
        drainRate: f && f.drainPerHour && f.drainPerHour >= 1 ? f.drainPerHour : null,
        countdown: resetPassed ? '' : formatCountdown(w.resetsAt, now),
        wall: resetPassed ? '' : formatWallClock(w.resetsAt, now),
        spark: points ? sparkline(points, now) : null,
        forecast: points ? forecastText(points, 100 - pct, w.resetsAt, now) : ''
    };
}

function claudeWindows(usage) {
    if (!usage) return [];
    return [['cc-5h', '5-hour', usage.fiveHour], ['cc-wk', 'Weekly', usage.weekly]]
        .filter(([, , w]) => w)
        .map(([id, name, w]) => ({ id, name, pct: w.pct, resetsAt: w.resetsAt }));
}

function codexWindows(limits) {
    if (!limits) return [];
    return limits.windows.map(w => ({ id: `cx-${w.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: w.name, pct: w.pct, resetsAt: w.resetsAt }));
}

// Reported times can lag (agy summaries); a token change marks the session active now.
function markActive(seen, c, now) {
    if (!c) return c;
    const sig = `${c.model}|${c.usedTokens}`;
    const prev = seen[c.source];
    if (!prev) seen[c.source] = { sig, at: 0 };
    else if (prev.sig !== sig) seen[c.source] = { sig, at: now };
    return { ...c, timestamp: Math.max(c.timestamp || 0, seen[c.source].at) };
}

function findBetterAccount(active, others) {
    if (!active || !active.pools || !active.pools.length || !others || !others.length) return null;
    const lowPools = active.pools.filter(p => p.left <= 25 || (p.forecast && p.forecast.includes('runs out')));
    if (!lowPools.length) return null;
    lowPools.sort((a, b) => a.left - b.left);
    const tight = lowPools[0];
    let best = null;
    for (const other of others) {
        if (!other.pools || !other.pools.length) continue;
        const matching = other.pools.find(p => p.id === tight.id || p.short === tight.short || p.name === tight.name) || other.pools[0];
        if (matching && matching.left >= Math.max(60, tight.left + 30)) {
            if (!best || matching.left > best.betterPct) {
                best = {
                    poolName: tight.name,
                    currentPct: tight.left,
                    betterEmail: other.email,
                    betterDisplay: other.display,
                    betterLabel: other.label || '',
                    betterPct: matching.left
                };
            }
        }
    }
    return best;
}

function buildViewState(input) {
    const now = input.now || Date.now();
    const mask = !!input.mask;
    const hist = input.history || (() => null);
    const s = input.connected ? input.status : null;
    const activeEmail = s ? s.email.toLowerCase() : '';
    const activeAcc = s ? (input.accounts.find(a => a.email.toLowerCase() === activeEmail) || {}) : null;

    const active = s ? {
        email: s.email,
        display: maskEmail(s.email, mask) || 'Signed-in account',
        label: activeAcc.label || '',
        planName: s.planName,
        pools: s.pools.map(p => poolView(p, now, false, hist(seriesId.ag(s.email, p.id)))),
        credits: s.credits || {}
    } : null;

    const agOn = input.antigravityEnabled !== false;
    const others = !agOn ? [] : input.accounts
        .filter(a => a.email.toLowerCase() !== activeEmail)
        .map((a, idx) => ({
            email: a.email,
            display: maskEmail(a.email, mask),
            label: a.label || '',
            planName: a.planName || '',
            order: idx + 1,
            lastActiveAgo: formatAgo(a.lastActive, now),
            snapshotAgo: a.snapshot ? formatAgo(a.snapshot.capturedAt, now) : '',
            pools: a.snapshot ? a.snapshot.pools.map(p => poolView(p, now, true, null)) : []
        }));

    const suggestion = findBetterAccount(active, others);

    const cc = input.claude || {};
    const ccWins = cc.usageEnabled ? claudeWindows(cc.usage).map(w => usedView(w, now, false, hist(seriesId.cc(w.id)))) : [];
    const claude = {
        enabled: !!cc.enabled,
        usageEnabled: !!cc.usageEnabled,
        context: cc.enabled ? (cc.context || null) : null,
        windows: ccWins,
        usageError: cc.usageEnabled ? (cc.usageError || '') : '',
        usageAgo: cc.usageEnabled && cc.usage ? formatAgo(cc.usage.updatedAt, now) : ''
    };
    claude.show = claude.enabled && !!(claude.context || ccWins.length || claude.usageError);

    const cx = input.codex || {};
    const cxData = cx.enabled ? cx.data : null;
    const lim = cxData && cxData.limits;
    const lastUsed = Math.max((lim && lim.at) || 0, (cxData && cxData.context && cxData.context.timestamp) || 0);
    const codex = {
        enabled: !!cx.enabled,
        context: cxData ? cxData.context : null,
        windows: codexWindows(lim).map(w => usedView(w, now, true, hist(seriesId.cx(w.id)))),
        plan: lim ? lim.plan : '',
        credits: lim ? lim.credits : null,
        asOfAgo: lim ? formatAgo(lim.at, now) : '',
        // Codex only writes limits while it runs; old data stays off the status bar.
        idle: !!lastUsed && now - lastUsed > IDLE_MS,
        lastUsedAgo: lastUsed ? formatAgo(lastUsed, now) : ''
    };
    codex.show = codex.enabled && !!(codex.context || codex.windows.length);

    const lefts = [];
    if (active) lefts.push(...active.pools.map(p => p.pct));
    lefts.push(...ccWins.map(w => w.left));
    if (!codex.idle) lefts.push(...codex.windows.map(w => w.left));

    return {
        mask,
        percentMode: input.percentMode === 'left' ? 'left' : 'used',
        connected: !!s,
        connecting: !s && !!input.connecting,
        antigravityEnabled: agOn,
        active,
        others,
        suggestion,
        agContext: s ? (input.agContext || null) : null,
        claude,
        codex,
        updatedAgo: formatAgo(input.updatedAt, now),
        minPct: lefts.length ? Math.min(...lefts) : null
    };
}

module.exports = { buildViewState, findBetterAccount, seriesId, claudeWindows, codexWindows, markActive, IDLE_MS };
