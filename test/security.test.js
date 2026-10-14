'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { orderPorts, parseUserStatus, parseGeneratorMetadata } = require('../src/parse');
const { buildCodexLimits, parseCodexLines } = require('../src/codex');
const { findLastUsage } = require('../src/claudeCode');
const { rpc, MAX_BODY_BYTES } = require('../src/agyClient');

test('orderPorts drops ports the process does not own', () => {
    assert.deepStrictEqual(orderPorts([61866, 5555], [63587, 61866]), { ports: [61866, 63587], verified: true });
    assert.deepStrictEqual(orderPorts([5555], [63587]), { ports: [63587], verified: true });
    assert.deepStrictEqual(orderPorts([61866], []), { ports: [61866], verified: false });
});

test('parseUserStatus survives hostile values', () => {
    const s = parseUserStatus({ userStatus: {
        email: { evil: 1 },
        name: 'x'.repeat(5000),
        planStatus: { availablePromptCredits: 'lots', planInfo: { planName: 42 } },
        cascadeModelConfigData: { clientModelConfigs: [
            null,
            'junk',
            { label: 'Gemini A', quotaInfo: { remainingFraction: 7, resetTime: 'not a date' } },
            { label: 'Claude B', quotaInfo: { remainingFraction: -3, resetTime: '2026-10-14T10:00:00Z' } },
            { label: { x: 1 }, quotaInfo: { remainingFraction: NaN } }
        ] }
    } });
    assert.strictEqual(s.email, '');
    assert.strictEqual(s.name.length, 200);
    assert.strictEqual(s.planName, 'Unknown');
    assert.deepStrictEqual(s.credits, {});
    assert.deepStrictEqual(s.pools.map(p => [p.name, p.remainingPct, p.resetTime]), [
        ['Gemini', 100, null],
        ['Claude', 0, '2026-10-14T10:00:00Z']
    ]);
    assert.strictEqual(parseUserStatus({ userStatus: { cascadeModelConfigData: { clientModelConfigs: 'x' } } }).pools.length, 0);
});

test('parseGeneratorMetadata ignores non-string titles', () => {
    const data = { generatorMetadata: [{ chatModel: { usage: { inputTokens: '10' } } }] };
    assert.strictEqual(parseGeneratorMetadata(data, {}, { summary: { summary: { bad: 1 } }, time: 1 }).title, 'Active conversation');
});

test('Codex limits clamp and reject junk', () => {
    const lim = buildCodexLimits({ limitsEvent: { ts: 0, rl: {
        primary: { used_percent: 250, window_minutes: 'x', resets_at: 1e30 },
        secondary: { used_percent: 'high' },
        credits: { has_credits: true, balance: { nested: true } },
        plan_type: 'p'.repeat(200)
    } } });
    assert.deepStrictEqual(lim.windows, [{ name: 'Limit', minutes: 0, pct: 100, resetsAt: null }]);
    assert.strictEqual(lim.credits, null);
    assert.strictEqual(lim.plan.length, 40);
    const p = parseCodexLines([JSON.stringify({ type: 'turn_context', payload: { model: { evil: 1 } } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: {}, model_context_window: -5 } } })]);
    assert.strictEqual(p.model, '');
});

test('Claude log parser ignores non-string models', () => {
    const f = findLastUsage([JSON.stringify({ message: { model: ['x'], usage: { input_tokens: 'many' } } })]);
    assert.strictEqual(f.model, '');
});

test('rpc refuses oversized responses', async () => {
    const big = Buffer.alloc(MAX_BODY_BYTES + 1024, 0x61);
    const server = http.createServer((req, res) => { res.writeHead(200); res.end(big); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
        await assert.rejects(rpc(port, 'csrf', 'GetUserStatus', {}, 4000), /RESPONSE_TOO_LARGE|socket hang up|aborted/);
    } finally {
        server.closeAllConnections && server.closeAllConnections();
        await new Promise(r => server.close(r));
    }
});

test('rpc only talks to 127.0.0.1 and sends the csrf header', async () => {
    let seen = null;
    const server = http.createServer((req, res) => {
        seen = { host: req.socket.localAddress, csrf: req.headers['x-codeium-csrf-token'] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
        assert.deepStrictEqual(await rpc(server.address().port, 'tok', 'X', {}), { ok: true });
        assert.deepStrictEqual(seen, { host: '127.0.0.1', csrf: 'tok' });
    } finally {
        await new Promise(r => server.close(r));
    }
});

test('Claude limits: one request per gap across windows, backing off after 429', () => {
    const { usageDue, usageResult, retryAfterMs } = require('../src/claudeCode');
    const GAP = 5 * 60e3;
    let s = {};
    const t0 = 1e12;
    assert.strictEqual(usageDue(s, t0, GAP, false), true, 'first run asks');
    s = usageResult(s, { error: 'limited', limited: true }, t0, GAP);
    assert.strictEqual(s.until, t0 + GAP);
    assert.strictEqual(usageDue(s, t0 + 60e3, GAP, true), false, 'manual refresh waits out the backoff');
    s = usageResult(s, { error: 'limited', limited: true }, t0 + GAP, GAP);
    assert.strictEqual(s.until - (t0 + GAP), 2 * GAP, 'doubles');
    for (let i = 0; i < 5; i++) s = usageResult(s, { error: 'limited', limited: true }, t0, GAP);
    assert.strictEqual(s.until - t0, 30 * 60e3, 'capped at 30 minutes');
    s = usageResult(s, { error: 'limited', retryAfterMs: 45 * 60e3 }, t0, GAP);
    assert.strictEqual(s.until - t0, 45 * 60e3, 'Retry-After wins when longer');
    const ok = usageResult(s, { updatedAt: t0, fiveHour: { pct: 1 } }, t0, GAP);
    assert.deepStrictEqual([ok.fails, ok.until, ok.error], [0, 0, '']);
    assert.strictEqual(usageDue(ok, t0 + 2 * 60e3, GAP, false), false, 'another window reuses the result');
    assert.strictEqual(usageDue(ok, t0 + 2 * 60e3, GAP, true), true, 'manual refresh after a minute');
    const local = usageResult(ok, { error: 'expired', noRequest: true }, t0 + 9e5, GAP);
    assert.deepStrictEqual([local.at, local.until, local.data], [ok.at, 0, ok.data], 'local errors keep data and do not back off');
    assert.strictEqual(retryAfterMs('120'), 120e3);
    assert.strictEqual(retryAfterMs('999999'), 3600e3, 'capped at 1 hour');
    assert.strictEqual(retryAfterMs('garbage'), 0);
});
