'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const u = require('../src/util');
const { evaluateAlerts } = require('../src/alerts');
const { buildViewState } = require('../src/viewState');
const { Accounts } = require('../src/accounts');
const { ClaudeContextReader, findLastUsage, encodeProjectDir } = require('../src/claudeCode');

const NOW = Date.parse('2026-10-14T10:00:00Z');
const pool = (id, pct, resetTime) => ({ id, name: id, short: id, remainingPct: pct, resetTime: resetTime || null, models: [] });

test('util formatting', () => {
    assert.strictEqual(u.formatCountdown('2026-10-16T13:30:00Z', NOW), '2d 3h');
    assert.strictEqual(u.formatCountdown('2026-10-14T10:20:00Z', NOW), '20m');
    assert.strictEqual(u.formatCountdown('2026-10-14T09:00:00Z', NOW), 'now');
    assert.strictEqual(u.formatCountdown('', NOW), '');
    assert.strictEqual(u.maskEmail('alice.dev@x.com'), 'ali****@x.com');
    assert.strictEqual(u.maskEmail('ab@x.com'), 'a****@x.com');
    assert.strictEqual(u.maskEmail('ab@x.com', false), 'ab@x.com');
    assert.strictEqual(u.formatTokens(1500000), '1.5M');
    assert.strictEqual(u.textBar(50, 4), '\u2588\u2588\u2591\u2591');
    assert.strictEqual(u.escapeMarkdown('[x](command:evil)'), '\\[x\\]\\(command:evil\\)');
    assert.ok(u.pathsOverlap('file:///c%3A/repo/sub', 'C:\\repo'));
    assert.ok(!u.pathsOverlap('file:///c%3A/repo2', 'C:\\repo'));
    assert.strictEqual(u.contextWindowFor('Claude Sonnet 4.6 (Thinking)'), 1000000);
    assert.strictEqual(u.contextWindowFor('claude-3-5-haiku'), 200000);
});

test('alerts fire once per threshold and re-arm after recovery', () => {
    const opts = { thresholds: [20, 5], notifyOnReset: true };
    let r = evaluateAlerts({}, [pool('g', 50)], opts);
    assert.deepStrictEqual(r.events, []);
    r = evaluateAlerts(r.next, [pool('g', 18)], opts);
    assert.deepStrictEqual(r.events.map(e => [e.type, e.threshold]), [['low', 20]]);
    r = evaluateAlerts(r.next, [pool('g', 15)], opts);
    assert.deepStrictEqual(r.events, []);
    r = evaluateAlerts(r.next, [pool('g', 3)], opts);
    assert.deepStrictEqual(r.events.map(e => e.threshold), [5]);
    r = evaluateAlerts(r.next, [pool('g', 100)], opts);
    assert.deepStrictEqual(r.events.map(e => e.type), ['reset']);
    r = evaluateAlerts(r.next, [pool('g', 10)], opts);
    assert.deepStrictEqual(r.events.map(e => e.threshold), [20]);
});

test('alerts on first sight jump straight to the lowest crossed level', () => {
    const r = evaluateAlerts({}, [pool('g', 2)], { thresholds: [20, 5], notifyOnReset: true });
    assert.deepStrictEqual(r.events.map(e => [e.type, e.threshold]), [['low', 5]]);
    assert.deepStrictEqual(r.next.g.fired, [20, 5]);
});

function memento(init) {
    const data = Object.assign({}, init);
    return { data, get: k => data[k], update: (k, v) => { if (v === undefined) delete data[k]; else data[k] = v; return Promise.resolve(); } };
}

test('accounts record, label and remove', () => {
    const m = memento({
        'nexus.accounts.v2': [{ email: 'a@x.com', name: 'A', label: '', planName: '', lastActive: 7, snapshot: null }]
    });
    const acc = new Accounts(m);
    assert.deepStrictEqual(acc.all().map(a => a.email), ['a@x.com']);
    assert.deepStrictEqual(new Accounts(memento({})).all(), []);
    acc.recordActive({ email: 'b@x.com', name: 'B', planName: 'Pro', pools: [pool('g', 40)], credits: {} });
    assert.strictEqual(acc.all().length, 2);
    acc.setLabel('B@X.com', 'Work');
    assert.strictEqual(acc.find('b@x.com').label, 'Work');
    acc.remove('a@x.com');
    assert.deepStrictEqual(m.data['nexus.accounts.v2'].map(a => a.email), ['b@x.com']);
});

test('view state estimates refilled pools for inactive accounts', () => {
    const accounts = [
        { email: 'me@x.com', label: '', planName: 'Pro', lastActive: NOW, snapshot: { pools: [pool('g', 40, '2026-10-14T12:00:00Z')], capturedAt: NOW } },
        { email: 'old@x.com', label: 'Work', planName: 'Free', lastActive: NOW - 3600e3, snapshot: { pools: [pool('g', 10, '2026-10-14T09:00:00Z')], capturedAt: NOW - 3600e3 } }
    ];
    const v = buildViewState({
        now: NOW, mask: true, connected: true, accounts, updatedAt: NOW,
        status: { email: 'me@x.com', planName: 'Pro', pools: [pool('g', 40, '2026-10-14T12:00:00Z')], credits: {} },
        claude: { enabled: true, usageEnabled: false, context: null }
    });
    assert.strictEqual(v.active.display, 'm****@x.com');
    assert.strictEqual(v.active.pools[0].countdown, '2h 0m');
    assert.strictEqual(v.others.length, 1);
    assert.deepStrictEqual([v.others[0].pools[0].pct, v.others[0].pools[0].estimated], [100, true]);
    assert.strictEqual(v.minPct, 40);
    assert.strictEqual(v.claude.show, false);

    const off = buildViewState({ now: NOW, connected: false, status: null, accounts, claude: {} });
    assert.strictEqual(off.active, null);
    assert.strictEqual(off.others.length, 2);
});

test('findLastUsage skips sidechain and synthetic entries', () => {
    const lines = [
        JSON.stringify({ message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 90 } }, timestamp: '2026-10-14T09:00:00Z' }),
        JSON.stringify({ isSidechain: true, message: { model: 'claude-haiku', usage: { input_tokens: 5 } } }),
        JSON.stringify({ message: { model: '<synthetic>', usage: { input_tokens: 0 } } }),
        'not json "usage"'
    ];
    const f = findLastUsage(lines);
    assert.strictEqual(f.model, 'claude-opus-5-5');
    assert.strictEqual(encodeProjectDir('c:\\work\\my-app'), 'c--work-my-app');
});

test('ClaudeContextReader reads the workspace project tail', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-'));
    const ws = path.join(home, 'my repo');
    const dir = path.join(home, '.claude', 'projects', encodeProjectDir(ws));
    fs.mkdirSync(dir, { recursive: true });
    const filler = JSON.stringify({ type: 'user', text: 'x'.repeat(2000) });
    const usageLine = JSON.stringify({ message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 1000, cache_read_input_tokens: 19000, cache_creation_input_tokens: 0 } } });
    fs.writeFileSync(path.join(dir, 's.jsonl'), [usageLine, ...Array(100).fill(filler)].join('\n'));
    const r = new ClaudeContextReader(home);
    const c = await r.read([ws]);
    assert.strictEqual(c.usedTokens, 20000);
    assert.strictEqual(c.windowTokens, 200000);
    assert.strictEqual(c.pct, 10);
    assert.strictEqual(await r.read([ws]), c);
    fs.rmSync(home, { recursive: true, force: true });
});
