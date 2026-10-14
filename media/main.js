// @ts-check
(function () {
    // eslint-disable-next-line no-undef
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    const saved = vscode.getState() || {};
    const expanded = new Set(saved.expanded || ['active', 'claude', 'codex']);
    const SVG_NS = 'http://www.w3.org/2000/svg';
    let state = null;
    let settingsOpen = !!saved.settingsOpen;
    // While settings are open, skip redraws that change nothing there, so an open dropdown stays open.
    let shownSig = '';

    // Constant SVG markup only; user data always goes through textContent.
    const ICON = {
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

    function level(pctLeft) {
        return pctLeft <= 10 ? 'low' : pctLeft <= 30 ? 'warn' : 'ok';
    }

    function bar(pct, cls) {
        const fill = h('div', { class: `bar-fill ${cls}` });
        fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        return h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct) }, fill);
    }

    // points: [[x 0..100, y 0..100]], y = 100 - left (SVG top = full); flipped in used mode.
    function spark(points) {
        if (!points || points.length < 2) return null;
        if (mode() === 'used') points = points.map(([x, y]) => [x, 100 - y]);
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

    function saveView() {
        vscode.setState({ expanded: [...expanded], settingsOpen });
    }

    function settingControl(i) {
        if (i.kind === 'bool') {
            return h('input', { type: 'checkbox', class: 'switch', 'data-setting': i.key, checked: !!i.value, disabled: i.disabled, 'aria-label': i.label });
        }
        if (i.kind === 'enum') {
            return h('select', { 'data-setting': i.key, disabled: i.disabled, 'aria-label': i.label },
                i.options.map((o, idx) => h('option', { value: String(idx), selected: o.value === i.value }, o.label)));
        }
        const list = Array.isArray(i.value) ? i.value.map(n => `${Number(n)}%`).join(', ') + ' left' : String(i.value);
        return h('span', { class: 'muted' }, list);
    }

    // Grouped like VS Code Settings; lists such as alert levels are edited there.
    function settingsPanel(s) {
        return [
            h('div', { class: 'set-head' },
                h('strong', null, 'Settings'),
                h('button', { class: 'btn', 'data-action': 'toggleSettings' }, 'Done')),
            ...(s.settings || []).map(g => h('section', { class: 'card set-group' },
                h('div', { class: 'set-title' }, g.title),
                g.items.map(i => h('label', { class: `set-row${i.disabled ? ' dim' : ''}`, title: i.help },
                    h('span', { class: 'set-label' }, i.label), settingControl(i))))),
            h('div', { class: 'actions' }, h('button', { class: 'btn', 'data-action': 'openSettings' }, 'All settings in VS Code'))
        ];
    }

    function render() {
        if (!state) {
            root.replaceChildren(h('div', { class: 'muted pad' }, 'Loading...'));
            return;
        }
        const s = state;
        // Actions live in the view's title bar only, so nothing is shown twice.
        if (settingsOpen) {
            root.replaceChildren(...settingsPanel(s));
            return;
        }
        const body = [];
        if (s.snoozed) {
            body.push(h('div', { class: 'muted small snoozed' }, 'Alerts snoozed for up to 1 hour. ',
                h('button', { class: 'link', 'data-action': 'snooze' }, 'Resume')));
        }
        if (s.active) body.push(activeCard(s));
        if (s.claude.show) {
            const extra = s.claude.usageEnabled
                ? (s.claude.usageError ? h('div', { class: 'muted small' }, s.claude.usageError + (s.claude.usageAgo ? `. Showing values from ${s.claude.usageAgo}.` : '')) : null)
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
        // Missing Antigravity goes below the tools that have data; nothing at all when it is turned off.
        const agOn = s.antigravityEnabled !== false;
        if (agOn && !s.active && s.connecting) {
            body.push(h('section', { class: 'card notice' }, h('div', { class: 'muted small' }, 'Looking for Antigravity...')));
        } else if (agOn && !s.active) {
            body.push(h('section', { class: 'card notice' },
                h('strong', null, 'Antigravity not detected'),
                h('div', { class: 'muted small' }, 'Start agy or the Antigravity IDE. Quota Nexus connects to its local server automatically.'),
                h('div', { class: 'actions' }, h('button', { class: 'btn', 'data-action': 'diagnostics' }, 'Show diagnostics'))));
        }
        if (agOn) {
            body.push(h('div', { class: 'section-label' }, `Other Antigravity accounts (${s.others.length})`));
            body.push(...s.others.map(otherCard));
            body.push(h('button', { class: 'btn wide', 'data-action': 'signIn' }, 'Sign in with another account'));
        }
        if (!body.length) {
            body.push(h('section', { class: 'card notice' },
                h('div', { class: 'muted small' }, 'Every tool is turned off or has no data yet.'),
                h('div', { class: 'actions' }, h('button', { class: 'btn', 'data-action': 'toggleSettings' }, 'Open settings'))));
        }
        body.push(h('footer', { class: 'muted small' },
            `Updated ${s.updatedAgo} · Unofficial · Local data only · `,
            h('button', { class: 'link', 'data-action': 'diagnostics' }, 'Diagnostics')));

        root.replaceChildren(...body);
    }

    root.addEventListener('click', (e) => {
        const el = e.target instanceof Element ? e.target.closest('[data-action]') : null;
        if (!el) return;
        const action = el.getAttribute('data-action');
        if (action === 'toggle') {
            const id = el.getAttribute('data-id');
            if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
            saveView();
            render();
            return;
        }
        if (action === 'toggleSettings') {
            settingsOpen = !settingsOpen;
            saveView();
            render();
            return;
        }
        vscode.postMessage({ type: action, email: el.getAttribute('data-email') || undefined });
    });

    root.addEventListener('change', (e) => {
        const el = e.target;
        if (!(el instanceof HTMLElement) || !el.dataset.setting || !state) return;
        const item = (state.settings || []).flatMap(g => g.items).find(i => i.key === el.dataset.setting);
        if (!item) return;
        const value = item.kind === 'bool' ? /** @type {HTMLInputElement} */ (el).checked : item.options[Number(/** @type {HTMLSelectElement} */ (el).value)].value;
        shownSig = '';
        vscode.postMessage({ type: 'setSetting', key: item.key, value });
    });
    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (msg && msg.type === 'showSettings') {
            settingsOpen = msg.mode === 'toggle' ? !settingsOpen : true;
            saveView();
            render();
            return;
        }
        if (msg && msg.type === 'state') {
            state = msg.state;
            const sig = settingsOpen ? JSON.stringify([state.settings, state.snoozed, state.mask]) : '';
            if (sig && sig === shownSig) return;
            shownSig = sig;
            render();
        }
    });

    render();
    vscode.postMessage({ type: 'ready' });
}());
