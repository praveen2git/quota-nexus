'use strict';

const test = require('node:test');
const assert = require('node:assert');
const p = require('../src/parse');

const cfgs = (rows) => rows.map(([label, frac, reset, model]) => ({
    label, modelOrAlias: { model: model || label.toUpperCase() }, quotaInfo: frac === undefined ? {} : { remainingFraction: frac, resetTime: reset }
}));

const SAMPLE = {
    userStatus: {
        email: 'dev@example.com',
        name: 'Dev',
        planStatus: { planInfo: { planName: 'Pro', monthlyPromptCredits: 50000 }, availablePromptCredits: 49000 },
        cascadeModelConfigData: {
            clientModelConfigs: cfgs([
                ['Gemini 3.8 Flash (High)', 1, '2026-10-14T11:54:33Z', 'M1'],
                ['Gemini 3.8 Flash (Low)', 1, '2026-10-14T11:54:33Z'],
                ['Claude Sonnet 4.6 (Thinking)', 0.2186, '2026-10-16T10:28:47Z'],
                ['Claude Opus 4.6 (Thinking)', 0.2186, '2026-10-16T10:28:47Z'],
                ['GPT-OSS 120B (Medium)', 0.2186, '2026-10-16T10:28:47Z'],
                ['Gemini 4 Argon', undefined]
            ])
        }
    }
};

test('parseUserStatus groups models into quota pools', () => {
    const s = p.parseUserStatus(SAMPLE);
    assert.strictEqual(s.email, 'dev@example.com');
    assert.strictEqual(s.planName, 'Pro');
    assert.deepStrictEqual(s.pools.map(x => [x.id, x.name, x.short, x.remainingPct]), [
        ['gemini', 'Gemini', 'Gem', 100],
        ['claude-gpt-oss', 'Claude / GPT-OSS', 'Cl/GPT', 22]
    ]);
    assert.strictEqual(s.modelLabels.M1, 'Gemini 3.8 Flash (High)');
    assert.deepStrictEqual(s.credits.prompt, { available: 49000, monthly: 50000 });
});

test('parseUserStatus gives the same pools whatever order the server uses', () => {
    const rows = SAMPLE.userStatus.cascadeModelConfigData.clientModelConfigs;
    const flipped = { userStatus: { ...SAMPLE.userStatus, cascadeModelConfigData: { clientModelConfigs: rows.slice().reverse() } } };
    const view = s => s.pools.map(x => [x.id, x.name, x.short, x.models.join('|')]);
    assert.deepStrictEqual(view(p.parseUserStatus(flipped)), view(p.parseUserStatus(SAMPLE)));
    assert.strictEqual(p.parseUserStatus(flipped).pools[1].name, 'Claude / GPT-OSS');
});

test('parseUserStatus names same-family pools apart', () => {
    const s = p.parseUserStatus({ userStatus: { cascadeModelConfigData: { clientModelConfigs: cfgs([
        ['Gemini 3.8 Flash (High)', 0.5, 'a'],
        ['Gemini 3.1 Pro (High)', 0.9, 'b']
    ]) } } });
    assert.deepStrictEqual(s.pools.map(x => x.name), ['Gemini 3.1 Pro', 'Gemini 3.8 Flash']);
    assert.strictEqual(new Set(s.pools.map(x => x.id)).size, 2);
});

test('parseUserStatus rejects junk', () => {
    assert.strictEqual(p.parseUserStatus(null), null);
    assert.strictEqual(p.parseUserStatus({}), null);
});

test('parseProcessLines finds agy and language server with ports', () => {
    const text = [
        '5876 C:\\Users\\x\\.gemini\\bin\\agy.exe --hub --hub-port=61866 --csrf_token=abc-123 --add-dir=c:\\repo',
        '7000 "C:\\Program Files\\Antigravity\\language_server_windows_x64.exe" --csrf_token def --extension_server_port 5555',
        '8000 C:\\tools\\other.exe --csrf_token=zzz --port=1',
        '9000 C:\\Users\\x\\bin\\agy.exe --hub'
    ].join('\r\n');
    assert.deepStrictEqual(p.parseProcessLines(text), [
        { pid: 5876, csrf: 'abc-123', ports: [61866], started: 0 },
        { pid: 7000, csrf: 'def', ports: [5555], started: 0 }
    ]);
});

test('parseNetstatListening and parseLsofListening', () => {
    const net = '  TCP    127.0.0.1:61866   0.0.0.0:0   LISTENING   5876\n  TCP    127.0.0.1:1234   0.0.0.0:0   LISTENING   1\n  TCP    127.0.0.1:63587   0.0.0.0:0   LISTENING   5876';
    assert.deepStrictEqual(p.parseNetstatListening(net, 5876), [61866, 63587]);
    const lsof = 'agy 42 me 10u IPv4 0x1 0t0 TCP 127.0.0.1:61866 (LISTEN)\nagy 42 me 11u IPv4 0x1 0t0 TCP 127.0.0.1:61867 (LISTEN)';
    assert.deepStrictEqual(p.parseLsofListening(lsof), [61866, 61867]);
});

test('pickTrajectory prefers the open workspace over a newer one', () => {
    const map = {
        a: { lastModifiedTime: '2026-10-14T10:00:00Z', workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c%3A/work/my-app' }] },
        b: { lastModifiedTime: '2026-10-14T11:00:00Z', workspaces: [{ workspaceFolderAbsoluteUri: 'file:///c%3A/other' }] }
    };
    assert.strictEqual(p.pickTrajectory(map, ['c:\\work\\my-app']).id, 'a');
    assert.strictEqual(p.pickTrajectory(map, []).id, 'b');
    assert.strictEqual(p.pickTrajectory({}, []), null);
});

test('parseGeneratorMetadata maps model id to label and computes fill', () => {
    const data = { generatorMetadata: [{ chatModel: {
        model: 'M1',
        usage: { inputTokens: '1000', cacheReadTokens: '9000', outputTokens: '50' },
        chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 100000 } }
    } }] };
    const c = p.parseGeneratorMetadata(data, { M1: 'Gemini 3.8 Flash (High)' }, { summary: { summary: 'Fix bug' }, time: 5 });
    assert.strictEqual(c.model, 'Gemini 3.8 Flash (High)');
    assert.strictEqual(c.windowTokens, 1000000);
    assert.strictEqual(c.pct, 10);
    assert.strictEqual(c.cacheHitRate, 90);
    assert.strictEqual(c.title, 'Fix bug');
    assert.strictEqual(c.timestamp, 5);
    assert.strictEqual(p.parseGeneratorMetadata({ generatorMetadata: [] }, {}, null), null);

    const meta = model => ({ generatorMetadata: [{ responseModel: model, chatModel: { usage: { inputTokens: '10' } } }] });
    const labels = { M1: 'Gemini 3.8 Flash (High)', M2: 'Claude Sonnet 4.6 (Thinking)' };
    assert.strictEqual(p.parseGeneratorMetadata(meta('gemini-3.8-flash-n'), labels, null).model, 'Gemini 3.8 Flash');
    assert.strictEqual(p.parseGeneratorMetadata(meta('gemini-9-ultra'), labels, null).model, 'Gemini 9 Ultra');
    assert.strictEqual(p.parseGeneratorMetadata(meta('MODEL_PLACEHOLDER_M9'), labels, null).model, 'Unknown model');
});

test('process start times are read on Windows and Unix, and the newest server wins', () => {
    const { parseProcessLines, newestFirst, etimeMs } = require('../src/parse');
    const now = 1_800_000_000_000;
    const win = parseProcessLines([
        '19764 1792046589000 C:/Users/u/.gemini/bin/agy.exe --hub --hub-port=63541 --csrf_token=aaaa',
        '24020 1792049994000 C:/Users/u/.gemini/bin/agy.exe --hub --hub-port=64000 --csrf_token=bbbb',
        '555 C:/Users/u/.gemini/bin/agy.exe --csrf_token=cccc'
    ].join('\r\n'), now);
    assert.deepStrictEqual(win.map(p => [p.pid, p.started]), [[19764, 1792046589000], [24020, 1792049994000], [555, 0]]);
    assert.deepStrictEqual(newestFirst(win).map(p => p.pid), [24020, 19764, 555], 'newest first, no start time last');
    const unix = parseProcessLines('  812  01:02:03 /home/u/.gemini/bin/agy --hub --csrf_token=dddd\n 900 1-00:00:05 /home/u/.gemini/bin/agy --csrf_token=eeee', now);
    assert.deepStrictEqual(unix.map(p => [p.pid, now - p.started]), [[812, 3723e3], [900, 86405e3]]);
    assert.strictEqual(etimeMs('05:09'), 309e3);
    assert.strictEqual(etimeMs('garbage'), null);
});

test('parseQuotaSummary reads 5-hour and weekly buckets per model group', () => {
    const b = (displayName, remainingFraction, resetTime, extra) => ({ displayName, remainingFraction, resetTime, ...extra });
    const raw = { response: { groups: [
        { displayName: 'Gemini Models', buckets: [b('Weekly Limit Remaining', 0.97, '2026-10-22T08:00:00Z'), b('Five Hour Limit Remaining', 0.86, '2026-10-15T17:00:00Z')] },
        { displayName: 'Claude and GPT models', buckets: [b('', 0.18, '2026-10-16T10:00:00Z', { window: '604800s' }), b('Off', 1, null, { disabled: true }), b('No fraction')] },
        { displayName: 'Empty', buckets: [] }
    ] } };
    const g = p.parseQuotaSummary(raw);
    assert.deepStrictEqual(g.map(x => [x.id, x.name, x.windows.map(w => [w.id, w.name, w.remainingPct])]), [
        ['gemini-models', 'Gemini Models', [['gemini-models-5-hour', '5-hour', 86], ['gemini-models-weekly', 'Weekly', 97]]],
        ['claude-and-gpt-models', 'Claude and GPT models', [['claude-and-gpt-models-weekly', 'Weekly', 18]]]
    ]);
    assert.strictEqual(g[0].windows[0].resetTime, '2026-10-15T17:00:00Z');
    assert.strictEqual(p.parseQuotaSummary({ response: { buckets: [b('Five Hour Limit Remaining', 2)] } })[0].windows[0].remainingPct, 100);
    assert.strictEqual(p.parseQuotaSummary({}), null);
    assert.strictEqual(p.parseQuotaSummary({ response: { groups: 'x' } }), null);
});

test('limitsMatch rejects limits that belong to another account', () => {
    const g = (a, b) => ({ windows: [{ remainingPct: a }, { remainingPct: b }] });
    const groups = [g(86, 97), g(93, 18)];
    assert.strictEqual(p.limitsMatch([{ remainingPct: 86 }, { remainingPct: 18 }], groups), true);
    assert.strictEqual(p.limitsMatch([{ remainingPct: 100 }, { remainingPct: 100 }], groups), false);
    assert.strictEqual(p.limitsMatch([], groups), true);
    assert.strictEqual(p.limitsMatch([{ remainingPct: 50 }], null), true);
});
