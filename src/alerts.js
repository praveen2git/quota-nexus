'use strict';

// prev: { [poolId]: { pct, fired: number[] } }. A threshold re-arms once quota rises above it.
function evaluateAlerts(prev, pools, opts) {
    const thresholds = [...new Set((opts.thresholds || []).map(Number).filter(n => n > 0 && n < 100))];
    const next = {};
    const events = [];
    for (const p of pools || []) {
        const pct = p.remainingPct;
        const before = (prev && prev[p.id]) || { pct, fired: [] };
        let fired = (before.fired || []).filter(t => pct <= t);
        const crossed = thresholds.filter(t => pct <= t && !fired.includes(t));
        if (crossed.length) {
            events.push({ type: 'low', pool: p, threshold: Math.min(...crossed) });
            fired = fired.concat(crossed);
        }
        if (opts.notifyOnReset && before.pct < 100 && pct >= 100) events.push({ type: 'reset', pool: p });
        next[p.id] = { pct, fired: fired.sort((a, b) => b - a) };
    }
    return { next, events };
}

module.exports = { evaluateAlerts };
