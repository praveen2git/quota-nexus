'use strict';

const KEY = 'nexus.accounts.v2';
const SAVE_EVERY_MS = 5 * 60000;

function sig(pools) {
    return JSON.stringify((pools || []).map(p => [p.id, p.remainingPct, p.resetTime]));
}

class Accounts {
    constructor(memento) {
        this.m = memento;
        this.lastSaved = 0;
        const stored = memento.get(KEY);
        this.list = Array.isArray(stored) ? stored : [];
    }

    all() {
        return this.list.slice();
    }

    find(email) {
        const e = String(email || '').toLowerCase();
        return this.list.find(a => a.email.toLowerCase() === e) || null;
    }

    recordActive(status) {
        if (!status || !status.email) return;
        const now = Date.now();
        let acc = this.find(status.email);
        let changed = false;
        if (!acc) {
            acc = { email: status.email, name: '', label: '', planName: '', lastActive: 0, snapshot: null };
            this.list.push(acc);
            changed = true;
        }
        if (acc.name !== status.name || acc.planName !== status.planName) changed = true;
        if (!acc.snapshot || sig(acc.snapshot.pools) !== sig(status.pools)) changed = true;
        acc.name = status.name;
        acc.planName = status.planName;
        acc.lastActive = now;
        acc.snapshot = { pools: status.pools, credits: status.credits, capturedAt: now };
        if (changed || now - this.lastSaved > SAVE_EVERY_MS) this.save();
    }

    setLabel(email, label) {
        const acc = this.find(email);
        if (!acc) return;
        acc.label = String(label || '').slice(0, 40);
        this.save();
    }

    remove(email) {
        const e = String(email || '').toLowerCase();
        this.list = this.list.filter(a => a.email.toLowerCase() !== e);
        this.save();
    }

    save() {
        this.lastSaved = Date.now();
        return this.m.update(KEY, this.list);
    }
}

module.exports = { Accounts };
