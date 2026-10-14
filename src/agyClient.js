'use strict';

const http = require('http');
const { execFile } = require('child_process');
const {
    parseUserStatus, parseProcessLines, parseNetstatListening, parseLsofListening,
    pickTrajectory, parseGeneratorMetadata, orderPorts
} = require('./parse');

const META = { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } };
const RPC_PATH = '/exa.language_server_pb.LanguageServerService/';
const DISCOVERY_BACKOFF_MS = 20000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const IS_WIN = process.platform === 'win32';

function run(cmd, args, timeout = 6000) {
    return new Promise((resolve) => {
        execFile(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout) => resolve(err && !stdout ? '' : (stdout || '')));
    });
}

function rpc(port, csrf, name, body, timeout = 4000) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body || {});
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: RPC_PATH + name,
            method: 'POST',
            timeout,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': csrf
            }
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', c => {
                size += c.length;
                if (size > MAX_BODY_BYTES) return req.destroy(new Error('RESPONSE_TOO_LARGE'));
                chunks.push(c);
            });
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
        req.end(payload);
    });
}

async function listProcesses() {
    if (IS_WIN) {
        const ps = "Get-CimInstance Win32_Process -Filter \"Name LIKE 'agy%' OR Name LIKE 'language_server%'\" | " +
            "ForEach-Object { [string]$_.ProcessId + ' ' + $_.CommandLine }";
        return parseProcessLines(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]));
    }
    return parseProcessLines(await run('ps', ['-A', '-ww', '-o', 'pid=,args=']));
}

async function listeningPorts(pid, netstatCache) {
    if (IS_WIN) {
        if (!netstatCache.p) netstatCache.p = run('netstat', ['-ano', '-p', 'tcp'], 4000);
        return parseNetstatListening(await netstatCache.p, pid);
    }
    return parseLsofListening(await run('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], 4000));
}

function firstOk(promises) {
    return new Promise((resolve) => {
        let pending = promises.length;
        if (pending === 0) return resolve(null);
        for (const p of promises) {
            p.then(v => { if (v) resolve(v); }, () => {}).finally(() => { if (--pending === 0) resolve(null); });
        }
    });
}

const NOOP_LOG = { info() {}, warn() {} };

// Diagnostics never include the csrf token.
class AgyClient {
    constructor(log) {
        this.log = log || NOOP_LOG;
        this.server = null;
        this.discovering = null;
        this.lastFailedDiscovery = 0;
        this.ctxCache = null;
        this.diag = { lastOkAt: 0, lastError: '', processes: 0, probed: 0, lastDiscoveryAt: 0 };
    }

    fail(msg) {
        if (this.diag.lastError !== msg) this.log.warn(`Antigravity: ${msg}`);
        this.diag.lastError = msg;
    }

    probe(port, csrf, pid) {
        return rpc(port, csrf, 'GetUserStatus', META, 2500)
            .then(data => (data && data.userStatus ? { port, csrf, pid, data } : null));
    }

    discover() {
        if (this.discovering) return this.discovering;
        if (Date.now() - this.lastFailedDiscovery < DISCOVERY_BACKOFF_MS) return Promise.resolve(null);
        this.discovering = (async () => {
            const procs = await listProcesses();
            const netstatCache = {};
            const plans = await Promise.all(procs.map(async p => ({ p, ...orderPorts(p.ports, await listeningPorts(p.pid, netstatCache)) })));
            const probes = [];
            for (const { p, ports, verified } of plans) {
                if (!verified) this.log.info(`Antigravity: could not verify ports of pid ${p.pid}; using its command-line ports only`);
                for (const port of ports) probes.push(this.probe(port, p.csrf, p.pid));
            }
            const probed = probes.length;
            const found = await firstOk(probes);
            this.diag.processes = procs.length;
            this.diag.probed = probed;
            this.diag.lastDiscoveryAt = Date.now();
            if (found) {
                this.server = { port: found.port, csrf: found.csrf, pid: found.pid };
                this.log.info(`Antigravity: connected to pid ${found.pid} on port ${found.port}`);
            } else {
                this.lastFailedDiscovery = Date.now();
                this.fail(procs.length ? `found ${procs.length} process(es) but no port answered` : 'no agy or language server process found');
            }
            return found;
        })().finally(() => { this.discovering = null; });
        return this.discovering;
    }

    async getStatus() {
        let data = null;
        if (this.server) {
            try {
                data = await rpc(this.server.port, this.server.csrf, 'GetUserStatus', META);
            } catch (e) {
                this.log.info(`Antigravity: port ${this.server.port} stopped answering (${e.message}); rediscovering`);
                this.server = null;
            }
        }
        if (!data || !data.userStatus) {
            const found = await this.discover();
            if (!found) return null;
            data = found.data;
        }
        const parsed = parseUserStatus(data);
        if (parsed) {
            this.diag.lastOkAt = Date.now();
            this.diag.lastError = '';
        } else {
            this.fail('server answered without user status');
        }
        return parsed;
    }

    async getContext(wsPaths, modelLabels) {
        const s = this.server;
        if (!s) return null;
        const traj = await rpc(s.port, s.csrf, 'GetAllCascadeTrajectories', {});
        const picked = pickTrajectory(traj && traj.trajectorySummaries, wsPaths);
        if (!picked) return null;
        const c = this.ctxCache;
        if (c && c.id === picked.id && c.time === picked.time && c.port === s.port) return c.result;
        const meta = await rpc(s.port, s.csrf, 'GetCascadeTrajectoryGeneratorMetadata', { cascade_id: picked.id });
        const result = parseGeneratorMetadata(meta, modelLabels, picked);
        this.ctxCache = { id: picked.id, time: picked.time, port: s.port, result };
        return result;
    }
}

module.exports = { AgyClient, rpc, MAX_BODY_BYTES };
