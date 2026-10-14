'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexReader, parseCodexLines, buildCodexLimits, windowName } = require('../src/codex');
const { History, forecast, sparkline, currentSegment } = require('../src/history');
const { buildViewState } = require('../src/viewState');

const NOW = Date.parse('2026-10-14T10:00:00Z');
const MIN = 60e3;

function tokenCount(ts, used, limits) {
    return JSON.stringify({
        timestamp: ts,
        type: 'event_msg',
        payload: {
            type: 'token_count',
            info: {
                total_token_usage: { input_tokens: 999999 },
                last_token_usage: { input_tokens: used, cached_input_tokens: used - 100, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: used + 50 },
                model_context_window: 258400
            },
            rate_limits: limits
        }
    });
}

const LIMITS = {
    primary: { used_percent: 34, window_minutes: 43200, resets_at: Math.floor(Date.parse('2026-10-20T00:00:00Z') / 1000) },
    secondary: { used_percent: 12.4, window_minutes: 300, resets_in_seconds: 3600 },
    credits: { has_credits: false, unlimited: false, balance: null },
    plan_type: 'plus'
};

test('windowName labels Codex windows by length', () => {
    assert.strictEqual(windowName(300), '5-hour');
    assert.strictEqual(windowName(10080), 'Weekly');
    assert.strictEqual(windowName(43200), '30-day');
    assert.strictEqual(windowName(0), 'Limit');
});

test('parseCodexLines reads newest usage, limits and model', () => {
    const lines = [
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-terra', cwd: 'c:\\repo' } }),
        tokenCount('2026-10-14T09:00:00Z', 50000, LIMITS),
        tokenCount('2026-10-14T09:30:00Z', 76242, null)
    ];
    const p = parseCodexLines(lines);
    assert.strictEqual(p.model, 'gpt-5.6-terra');
    assert.strictEqual(p.tokenEvent.info.last_token_usage.input_tokens, 76242);
    const lim = buildCodexLimits(p);
    assert.deepStrictEqual(lim.windows.map(w => [w.name, w.pct]), [['30-day', 34], ['5-hour', 12]]);
    assert.strictEqual(lim.windows[0].resetsAt, '2026-10-20T00:00:00.000Z');
    assert.strictEqual(lim.windows[1].resetsAt, '2026-10-14T10:00:00.000Z');
    assert.strictEqual(lim.plan, 'plus');
    assert.strictEqual(parseCodexLines(['{"type":"other"}']), null);
});

test('CodexReader prefers the open workspace for context, newest file for limits', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cx-'));
    const day = path.join(home, '.codex', 'sessions', '2026', '10', '14');
    fs.mkdirSync(day, { recursive: true });
    const meta = cwd => JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd, base_instructions: 'y'.repeat(500) } });
    const ws = path.join(home, 'my repo');
    const a = path.join(day, 'rollout-a.jsonl');
    const b = path.join(day, 'rollout-b.jsonl');
    fs.writeFileSync(a, [meta(ws), JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-ws' } }), tokenCount('2026-10-14T08:00:00Z', 20000, LIMITS)].join('\n'));
    fs.writeFileSync(b, [meta(path.join(home, 'other')), JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-other' } }),
        tokenCount('2026-10-14T09:00:00Z', 100000, { primary: { used_percent: 40, window_minutes: 43200, resets_at: 1791373820 } })].join('\n'));
    const real = Date.now();
    fs.utimesSync(a, new Date(real - 60 * MIN), new Date(real - 60 * MIN));
    fs.utimesSync(b, new Date(real), new Date(real));

    const r = new CodexReader(home);
    const out = await r.read([ws]);
    assert.strictEqual(out.context.model, 'gpt-ws');
    assert.strictEqual(out.context.windowTokens, 258400);
    assert.strictEqual(out.context.windowExact, true);
    assert.strictEqual(out.context.usedTokens, 20040);
    assert.strictEqual(out.limits.windows[0].pct, 40);
    assert.strictEqual((await r.read([])).context.model, 'gpt-other');

    fs.utimesSync(a, new Date(real - 48 * 3600e3), new Date(real - 48 * 3600e3));
    assert.strictEqual((await new CodexReader(home).read([ws])).context.model, 'gpt-other', 'stale workspace session must lose');
    assert.strictEqual(await new CodexReader(path.join(home, 'none')).read([]), null);
    fs.rmSync(home, { recursive: true, force: true });
});

function memento() {
    const data = {};
    return { data, get: k => data[k], update: (k, v) => { data[k] = v; return Promise.resolve(); } };
}

test('History samples every 5 minutes but always keeps resets', () => {
    const h = new History(memento());
    h.add('s', 80, NOW);
    h.add('s', 79, NOW + MIN);
    h.add('s', 78, NOW + 5 * MIN);
    h.add('s', 100, NOW + 6 * MIN);
    assert.deepStrictEqual(h.series('s').map(p => p[1]), [80, 78, 100]);
    h.add('s', 'bad', NOW + 20 * MIN);
    assert.strictEqual(h.series('s').length, 3);
});

test('forecast predicts run-out, lasts-until-reset and needs enough data', () => {
    const pts = [0, 10, 20, 30, 40].map(m => [NOW + m * MIN, 60 - m / 2]);
    const end = NOW + 40 * MIN;
    const f = forecast(pts, 40, '2026-10-15T00:00:00Z', end);
    assert.strictEqual(f.status, 'runsOut');
    assert.ok(Math.abs(f.at - (end + 80 * MIN)) < 2 * MIN);
    assert.strictEqual(forecast(pts, 40, new Date(end + 30 * MIN).toISOString(), end).status, 'lasts');
    assert.strictEqual(forecast(pts.slice(0, 1), 40, null, NOW + 5 * MIN), null);
    assert.strictEqual(forecast([[NOW, 50], [NOW + 10 * MIN, 50], [NOW + 20 * MIN, 50]], 50, null, NOW + 30 * MIN).status, 'steady');
});

test('currentSegment starts after the last reset', () => {
    assert.deepStrictEqual(currentSegment([[1, 10], [2, 100], [3, 90], [4, 91], [5, 80]]).map(p => p[0]), [2, 3, 4, 5]);
});

test('sparkline maps the last 24h into a 100x100 box', () => {
    const H = 3600e3;
    const s = sparkline([[NOW - 48 * H, 10], [NOW - 12 * H, 80], [NOW - 6 * H, 70], [NOW - 3 * H, 60], [NOW, 20]], NOW);
    assert.deepStrictEqual(s, [[50, 20], [75, 30], [87.5, 40], [100, 80]]);
    assert.strictEqual(sparkline([[NOW, 1]], NOW), null);
    assert.strictEqual(sparkline([[NOW - 3 * MIN, 9], [NOW - 2 * MIN, 8], [NOW - MIN, 7], [NOW, 6]], NOW), null, 'too short a span');
});

test('view state builds Codex and Claude windows with stale handling', () => {
    const v = buildViewState({
        now: NOW, connected: false, accounts: [],
        claude: { enabled: true, usageEnabled: true, usage: { fiveHour: { pct: 30, resetsAt: '2026-10-14T12:00:00Z' }, weekly: { pct: 70, resetsAt: null } } },
        codex: { enabled: true, data: { context: null, limits: { windows: [
            { name: '30-day', pct: 34, resetsAt: '2026-10-20T00:00:00Z' },
            { name: '5-hour', pct: 90, resetsAt: '2026-10-14T09:00:00Z' }
        ], plan: 'plus', credits: null, at: NOW - 3600e3 } } }
    });
    assert.deepStrictEqual(v.claude.windows.map(w => [w.id, w.pct, w.left]), [['cc-5h', 30, 70], ['cc-wk', 70, 30]]);
    assert.deepStrictEqual(v.codex.windows.map(w => [w.id, w.left, w.estimated]), [['cx-30-day', 66, false], ['cx-5-hour', 100, true]]);
    assert.strictEqual(v.codex.show, true);
    assert.strictEqual(v.codex.idle, false);
    assert.strictEqual(v.codex.asOfAgo, '1h ago');
    assert.strictEqual(v.minPct, 30);
});

test('Codex unused for over 7 days is idle and leaves the minimum alone', () => {
    const v = buildViewState({
        now: NOW, connected: false, accounts: [],
        codex: { enabled: true, data: { context: null, limits: { windows: [{ name: '30-day', pct: 95, resetsAt: '2026-11-20T00:00:00Z' }], plan: 'go', credits: null, at: NOW - 37 * 24 * 3600e3 } } }
    });
    assert.strictEqual(v.codex.idle, true);
    assert.strictEqual(v.codex.lastUsedAgo, '37d ago');
    assert.strictEqual(v.codex.show, true, 'still on the dashboard');
    assert.strictEqual(v.minPct, null, 'idle Codex must not colour the status bar');
});
