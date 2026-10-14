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

test('parseUserStatus names same-family pools apart', () => {
    const s = p.parseUserStatus({ userStatus: { cascadeModelConfigData: { clientModelConfigs: cfgs([
        ['Gemini 3.8 Flash (High)', 0.5, 'a'],
        ['Gemini 3.1 Pro (High)', 0.9, 'b']
    ]) } } });
    assert.deepStrictEqual(s.pools.map(x => x.name), ['Gemini 3.8 Flash', 'Gemini 3.1 Pro']);
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
        { pid: 5876, csrf: 'abc-123', ports: [61866] },
        { pid: 7000, csrf: 'def', ports: [5555] }
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
