// @ts-check
(function () {
    // eslint-disable-next-line no-undef
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    const saved = vscode.getState() || {};
    const expanded = new Set(saved.expanded || ['active', 'claude', 'codex']);
    const SVG_NS = 'http://www.w3.org/2000/svg';
    let state = null;

    // Constant SVG markup only; user data always goes through textContent.
    const ICON = {
        refresh: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>',
        gear: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/><path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319z"/></svg>',
        eye: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5c-2.12 0-3.879-1.168-5.168-2.457A13.134 13.134 0 0 1 1.172 8z"/><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"/></svg>',
        bell: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 16a2 2 0 0 0 2-2H6a2 2 0 0 0 2 2zM8 1.918l-.797.161A4.002 4.002 0 0 0 4 6c0 .628-.134 2.197-.459 3.742-.16.767-.376 1.566-.663 2.258h10.244c-.287-.692-.502-1.49-.663-2.258C12.134 8.197 12 6.628 12 6a4.002 4.002 0 0 0-3.203-3.92L8 1.917zM14.22 12c.223.447.481.801.78 1H1c.299-.199.557-.553.78-1C2.68 10.2 3 6.88 3 6c0-2.42 1.72-4.44 4.005-4.901a1 1 0 1 1 1.99 0A5.002 5.002 0 0 1 13 6c0 .88.32 4.2 1.22 6z"/></svg>',
        chevron: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>'
    };

    function h(tag, attrs, ...kids) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') el.className = String(v);
            else if (k === 'html') el.innerHTML = String(v);
            else el.setAttribute(k, v === true ? '' : String(v));
        }
        for (const c of kids.flat()) {
            if (c === null || c === undefined || c === false || c === '') continue;
            el.append(c instanceof Node ? c : document.createTextNode(String(c)));
        }
        return el;
    }

    function iconBtn(action, icon, label, extra) {
        return h('button', Object.assign({ class: 'icon-btn', 'data-action': action, title: label, 'aria-label': label, html: ICON[icon] }, extra || {}));
    }

    function level(pctLeft) {
        return pctLeft <= 10 ? 'low' : pctLeft <= 30 ? 'warn' : 'ok';
    }

    function bar(pct, cls) {
        const fill = h('div', { class: `bar-fill ${cls}` });
        fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        return h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct) }, fill);
    }

    // points: [[x 0..100, y 0..100]] where y is percent used.
    function spark(points) {
        if (!points || points.length < 2) return null;
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'spark');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', 'Last 24 hours');
        const line = document.createElementNS(SVG_NS, 'polyline');
        line.setAttribute('points', points.map(([x, y]) => `${Number(x)},${Number(y)}`).join(' '));
        line.setAttribute('vector-effect', 'non-scaling-stroke');
        svg.append(line);
        return h('div', { class: 'spark-wrap', title: 'Last 24 hours' }, svg);
    }

    function mode() {
        return state && state.percentMode === 'left' ? 'left' : 'used';
    }

    // x carries both left and used; show the chosen one first.
    function pctText(x) {
        const m = mode();
        return `${x.estimated ? '~' : ''}${x[m]}% ${m}`;
    }

    function pctHead(x) {
        const o = mode() === 'used' ? 'left' : 'used';
        return h('span', { class: 'row-pct' }, pctText(x), h('span', { class: 'muted' }, ` (${x[o]}% ${o})`));
    }

    function ctxPct(c) {
        const used = Math.round(c.pct);
        return { used, left: 100 - used };
    }

    function notes(...lines) {
        return lines.filter(Boolean).map(t => h('div', { class: 'row-note' }, t));
    }

    function poolRow(p, withModels) {
        let reset;
        if (p.estimated) reset = 'Reset time has passed - likely full';
        else if (p.pct >= 100) reset = 'Full';
        else if (p.countdown) reset = `Resets in ${p.countdown} (${p.wall})`;
        return h('div', { class: 'row' },
            h('div', { class: 'row-head' },
                h('span', { class: 'row-name' }, p.name),
                pctHead(p)),
            bar(p[mode()], level(p.left)),
            notes(reset, p.forecast),
            withModels && p.models && p.models.length ? h('div', { class: 'row-note models' }, `Models: ${p.models.join(', ')}`) : null,
            spark(p.spark));
    }

    function limitRow(w) {
        let reset = '';
        if (w.estimated) reset = 'Reset time has passed - likely full';
        else if (w.left >= 100) reset = 'Full';
        else if (w.countdown) reset = `Resets in ${w.countdown} (${w.wall})`;
        return h('div', { class: 'row' },
            h('div', { class: 'row-head' },
                h('span', { class: 'row-name' }, `${w.name} limit`),
                pctHead(w)),
            bar(w[mode()], level(w.left)),
            notes(reset, w.forecast),
            spark(w.spark));
    }

    function contextRow(c) {
        const cls = c.pct >= 95 ? 'low' : c.pct >= 80 ? 'warn' : 'ok';
        const tip = c.pct >= 80 ? (c.source === 'codex' ? 'Nearly full: start a new session or /compact.' : 'Nearly full: /compact to keep going, /clear for a new task.') : '';
        const n = ctxPct(c);
        return h('div', { class: 'row' },
            h('div', { class: 'row-head' },
                h('span', { class: 'row-name' }, `Context - ${c.model}`),
                pctHead(n)),
            bar(n[mode()], cls),
            notes(`${c.left} tokens left${c.windowExact ? '' : ' (est.)'}`, tip));
    }

    function credits(cr) {
        const fmt = n => Number(n).toLocaleString();
        const parts = [];
        if (cr.prompt) parts.push(`Prompt credits ${fmt(cr.prompt.available)}${cr.prompt.monthly ? ' / ' + fmt(cr.prompt.monthly) : ''}`);
        if (cr.flow) parts.push(`Flow credits ${fmt(cr.flow.available)}${cr.flow.monthly ? ' / ' + fmt(cr.flow.monthly) : ''}`);
        return parts.length ? h('div', { class: 'muted small' }, parts.join(' · ')) : null;
    }

    function cardHeader(id, title, badges) {
        const open = expanded.has(id);
        return h('button', { class: 'card-head', 'data-action': 'toggle', 'data-id': id, 'aria-expanded': String(open) },
            h('span', { class: 'card-title' }, title),
            h('span', { class: 'badges' }, badges, h('span', { class: `chev${open ? ' up' : ''}`, html: ICON.chevron })));
    }

    function badge(text, cls) {
        return text ? h('span', { class: `badge ${cls || ''}` }, text) : null;
    }

    function activeCard(s) {
        const a = s.active;
        const open = expanded.has('active');
        return h('section', { class: 'card active' },
            cardHeader('active', h('span', null, h('span', { class: 'dot on' }), a.display),
                [badge(a.label, 'label'), badge('Active', 'on'), badge(a.planName, 'plan')]),
            h('div', { class: 'summary' }, a.pools.map(p => h('span', null, `${p.short} ${pctText(p)}`))),
            open ? h('div', { class: 'details' },
                a.pools.length ? a.pools.map(p => poolRow(p, true)) : h('div', { class: 'muted' }, 'No quota data reported.'),
                s.agContext ? contextRow(s.agContext) : null,
                credits(a.credits)) : null);
    }

    function toolCard(id, title, dotCls, badges, wins, context, footer) {
        const open = expanded.has(id);
        const sum = wins.map(w => h('span', null, `${w.name} ${pctText(w)}`));
        if (context) sum.push(h('span', null, `ctx ${Math.round(ctxPct(context)[mode()])}% ${mode()}`));
        return h('section', { class: 'card' },
            cardHeader(id, h('span', null, h('span', { class: `dot ${dotCls}` }), title), badges),
            h('div', { class: 'summary' }, sum),
            open ? h('div', { class: 'details' }, wins.map(limitRow), context ? contextRow(context) : null, footer) : null);
    }

    function otherCard(a) {
        const id = `acc:${a.email}`;
        const open = expanded.has(id);
        return h('section', { class: 'card' },
            cardHeader(id, h('span', null, h('span', { class: 'dot' }), a.display), [badge(a.label, 'label'), badge(a.planName, 'plan')]),
            h('div', { class: 'summary' },
                a.pools.length ? a.pools.map(p => h('span', null, `${p.short} ${pctText(p)}`)) : h('span', { class: 'muted' }, 'No snapshot yet')),
            open ? h('div', { class: 'details' },
                a.pools.map(p => poolRow(p, false)),
                h('div', { class: 'muted small' }, a.snapshotAgo ? `Last seen ${a.snapshotAgo}. Values update when this account is active.` : 'Sign in once to capture a snapshot.'),
                h('div', { class: 'actions' },
                    h('button', { class: 'btn primary', 'data-action': 'switch', 'data-email': a.email }, 'Switch to this account'),
                    h('button', { class: 'btn', 'data-action': 'rename', 'data-email': a.email }, 'Label'),
                    h('button', { class: 'btn danger', 'data-action': 'remove', 'data-email': a.email }, 'Remove'))) : null);
    }

    function render() {
        if (!state) {
            root.replaceChildren(h('div', { class: 'muted pad' }, 'Loading...'));
            return;
        }
        const s = state;
        const header = h('header', { class: 'top' },
            h('span', { class: 'brand' }, 'Quota Nexus'),
            h('span', { class: 'top-actions' },
                iconBtn('snooze', 'bell', s.snoozed ? 'Alerts snoozed - click to resume' : 'Snooze alerts for 1 hour', { 'aria-pressed': String(!!s.snoozed), class: `icon-btn${s.snoozed ? ' dim' : ''}` }),
                iconBtn('toggleMask', 'eye', s.mask ? 'Show emails' : 'Mask emails', { 'aria-pressed': String(s.mask) }),
                iconBtn('refresh', 'refresh', 'Refresh now'),
                iconBtn('openSettings', 'gear', 'Settings')));

        const body = [];
        if (s.active) body.push(activeCard(s));
        if (s.claude.show) {
            const extra = s.claude.usageEnabled
                ? (s.claude.usageError ? h('div', { class: 'muted small' }, s.claude.usageError) : null)
                : h('div', { class: 'actions' }, h('button', { class: 'btn', 'data-action': 'enableClaudeLimits' }, 'Show 5-hour and weekly limits'));
            body.push(toolCard('claude', 'Claude Code', 'cc', [badge('CLI', 'cc')], s.claude.windows, s.claude.context, extra));
        }
        if (s.codex.show) {
            const info = s.codex.idle
                ? `Codex not used for ${s.codex.lastUsedAgo.replace(/ ago$/, '')}. Hidden from the status bar until it runs again.`
                : [s.codex.credits, s.codex.windows.length ? `Limits as of ${s.codex.asOfAgo}` : ''].filter(Boolean).join(' · ');
            body.push(toolCard('codex', 'Codex', 'cx', [badge(s.codex.idle ? 'Idle' : '', 'plan'), badge(s.codex.plan, 'plan'), badge('CLI', 'cx')], s.codex.windows, s.codex.context,
                info ? h('div', { class: 'muted small' }, info) : null));
        }
        // Missing Antigravity goes below the tools that have data.
        if (!s.active && s.connecting) {
            body.push(h('section', { class: 'card notice' }, h('div', { class: 'muted small' }, 'Looking for Antigravity...')));
        } else if (!s.active) {
            body.push(h('section', { class: 'card notice' },
                h('strong', null, 'Antigravity not detected'),
                h('div', { class: 'muted small' }, 'Start agy or the Antigravity IDE. Quota Nexus connects to its local server automatically.'),
                h('div', { class: 'actions' }, h('button', { class: 'btn', 'data-action': 'diagnostics' }, 'Show diagnostics'))));
        }
        body.push(h('div', { class: 'section-label' }, `Other Antigravity accounts (${s.others.length})`));
        body.push(...s.others.map(otherCard));
        body.push(h('button', { class: 'btn wide', 'data-action': 'signIn' }, 'Sign in with another account'));
        body.push(h('footer', { class: 'muted small' },
            `Updated ${s.updatedAgo} · Unofficial · Local data only · `,
            h('button', { class: 'link', 'data-action': 'diagnostics' }, 'Diagnostics')));

        root.replaceChildren(header, ...body);
    }

    root.addEventListener('click', (e) => {
        const el = e.target instanceof Element ? e.target.closest('[data-action]') : null;
        if (!el) return;
        const action = el.getAttribute('data-action');
        if (action === 'toggle') {
            const id = el.getAttribute('data-id');
            if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
            vscode.setState({ expanded: [...expanded] });
            render();
            return;
        }
        if (action === 'refresh') el.classList.add('spin');
        vscode.postMessage({ type: action, email: el.getAttribute('data-email') || undefined });
    });

    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (msg && msg.type === 'state') {
            state = msg.state;
            render();
        }
    });

    render();
    vscode.postMessage({ type: 'ready' });
}());
