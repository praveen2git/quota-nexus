'use strict';

const KEY = 'nexus.history.v1';
const KEEP_MS = 7 * 24 * 3600e3;
const SAMPLE_GAP_MS = 5 * 60e3;
const SAVE_GAP_MS = 5 * 60e3;
const FIT_WINDOW_MS = 3 * 3600e3;

// Series hold [timestamp, percentLeft]; a jump up marks a quota reset.
class History {
    constructor(memento) {
        this.m = memento;
        const stored = memento.get(KEY);
        this.data = stored && typeof stored === 'object' ? stored : {};
        this.dirty = false;
        this.lastSave = 0;
    }

    add(id, pctLeft, now = Date.now()) {
        if (typeof pctLeft !== 'number' || !isFinite(pctLeft)) return;
        const s = this.data[id] || (this.data[id] = []);
        const last = s[s.length - 1];
        const reset = last && pctLeft - last[1] >= 5;
        if (last && now - last[0] < SAMPLE_GAP_MS && !reset) return;
        s.push([now, pctLeft]);
        while (s.length && now - s[0][0] > KEEP_MS) s.shift();
        this.dirty = true;
    }

    series(id) {
        return this.data[id] || [];
    }

    save(force) {
        if (!this.dirty || (!force && Date.now() - this.lastSave < SAVE_GAP_MS)) return;
        const now = Date.now();
        for (const [id, s] of Object.entries(this.data)) {
            if (!s.length || now - s[s.length - 1][0] > KEEP_MS) delete this.data[id];
        }
        this.dirty = false;
        this.lastSave = now;
        this.m.update(KEY, this.data);
    }
}

// Points since the last reset only; small upticks are rounding noise.
function currentSegment(points) {
    let i = points.length - 1;
    while (i > 0 && points[i - 1][1] >= points[i][1] - 1) i--;
    return points.slice(i);
}

function forecast(points, pctLeft, resetTime, now = Date.now()) {
    const seg = currentSegment(points.concat([[now, pctLeft]])).filter(p => now - p[0] <= FIT_WINDOW_MS);
    if (seg.length < 3 || seg[seg.length - 1][0] - seg[0][0] < 15 * 60e3) return null;
    if (seg[0][1] - pctLeft < 2) return { status: 'steady' };
    const n = seg.length;
    const mx = seg.reduce((a, p) => a + p[0], 0) / n;
    const my = seg.reduce((a, p) => a + p[1], 0) / n;
    let num = 0;
    let den = 0;
    for (const [x, y] of seg) {
        num += (x - mx) * (y - my);
        den += (x - mx) * (x - mx);
    }
    const slope = den ? num / den : 0;
    if (slope >= 0) return { status: 'steady', drainPerHour: 0 };
    const drainPerHour = Math.round(-slope * 3600e3 * 10) / 10;
    const runOutAt = now + pctLeft / -slope;
    const resetMs = Date.parse(resetTime || '');
    if (!isNaN(resetMs) && runOutAt >= resetMs) return { status: 'lasts', resetAt: resetMs, drainPerHour };
    return { status: 'runsOut', at: runOutAt, drainPerHour };
}

const SPARK_MIN_POINTS = 4;
const SPARK_MIN_SPAN_MS = 2 * 3600e3;

// Last 24h, normalised to a 100 x 100 box; hidden until there is enough to draw a trend.
function sparkline(points, now = Date.now(), spanMs = 24 * 3600e3, maxPoints = 60) {
    const recent = points.filter(p => now - p[0] <= spanMs);
    if (recent.length < SPARK_MIN_POINTS || recent[recent.length - 1][0] - recent[0][0] < SPARK_MIN_SPAN_MS) return null;
    const step = Math.max(1, Math.ceil(recent.length / maxPoints));
    const picked = recent.filter((_, i) => i % step === 0 || i === recent.length - 1);
    return picked.map(([t, v]) => [Math.round(((t - (now - spanMs)) / spanMs) * 1000) / 10, Math.round(100 - v)]);
}

module.exports = { History, forecast, sparkline, currentSegment };
