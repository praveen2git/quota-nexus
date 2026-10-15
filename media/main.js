// @ts-check
(function () {
    // eslint-disable-next-line no-undef
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    const saved = vscode.getState() || {};
    const expanded = new Set(saved.expanded || ['active', 'claude', 'codex']);
    let state = null;
    let settingsOpen = !!saved.settingsOpen;
    // While settings are open, skip redraws that change nothing there, so an open dropdown stays open.
    let shownSig = '';

    // Constant SVG markup only (codicon-style, 16px); user data always goes through textContent.
    const svg = d => `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="${d}"/></svg>`;
    const ICON = {
        chevron: svg('M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z'),
        up: svg('M8 3.3l4.85 4.85-.7.7L8.5 5.2V13h-1V5.2L3.85 8.85l-.7-.7L8 3.3z'),
        down: svg('M8 12.7L3.15 7.85l.7-.7 3.65 3.65V3h1v7.8l3.65-3.65.7.7L8 12.7z'),
        tag: svg('M2 2h5.6L14 8.4 8.4 14 2 7.6V2zm1 1v4.2l5.4 5.4 4.2-4.2L7.2 3H3zm2 1.25a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5z'),
        trash: svg('M6 1.5h4v1h3.5v1h-1v10a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-10h-1v-1H6v-1zm-1.5 2v10h7v-10h-7zm2 2h1v6h-1v-6zm2 0h1v6h-1v-6z'),
        plus: svg('M7.5 2h1v5.5H14v1H8.5V14h-1V8.5H2v-1h5.5V2z'),
        warn: svg('M8 1.5l7 12.5H1L8 1.5zm0 2.05L2.7 13h10.6L8 3.55zM7.5 6h1v4h-1V6zm0 5h1v1h-1v-1z')
    };

    function h(tag, attrs, ...kids) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') el.className = String(v);
            else if (k === 'html') el.innerHTML = String(v);
            else el.setAttribute(k, v === true ? '' : String(v));
        }
        for (const c of kids.flat(Infinity)) {
            if (c === null || c === undefined || c === false || c === '') continue;
            el.append(c instanceof Node ? c : document.createTextNode(String(c)));
        }
        return el;
    }

    function icon(name) {
        return h('span', { class: 'ico', html: ICON[name] });
    }

    function level(pctLeft) {
        return pctLeft <= 10 ? 'low' : pctLeft <= 30 ? 'warn' : 'ok';
    }

    function mode() {
        return state && state.percentMode === 'left' ? 'left' : 'used';
    }

    function pctText(x) {
        const m = mode();
        return `${x.estimated ? '~' : ''}${x[m]}% ${m}`;
    }

    function resetsText(x) {
        return x.countdown === 'now' ? `Resets now (${x.wall})` : `Resets in ${x.countdown} (${x.wall})`;
    }

    function fmtK(n) {
        if (!n || n <= 0) return '0';
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(n);
    }

    // "Claude and GPT models" -> "Claude", "Gemini Models" -> "Gemini"; GPT only names a group without Claude.
    function groupShort(name) {
        const n = String(name || '').toLowerCase();
        const parts = [['gemini', 'Gemini'], ['claude', 'Claude']].filter(([k]) => n.includes(k)).map(([, v]) => v);
        if (!parts.length && n.includes('gpt')) parts.push('GPT');
        return parts.length ? parts.join(' / ') : String(name || '').split(/\s+/)[0];
    }

    function meter(pct, lv, pace, label) {
        const fill = h('div', { class: `meter-fill ${lv}` });
        fill.style.width = `${pct}%`;
        const track = h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': label }, fill);
        if (typeof pace === 'number' && pace >= 0 && pace <= 100) {
            const tick = h('div', { class: 'meter-pace' });
            tick.style.left = `${Math.min(99, Math.max(1, pace))}%`;
            track.append(tick);
        }
        return track;
    }

    // Collapsed view: equal-width cells (name, value, thin bar) so every card reads the same way.
    function miniGrid(items, cols) {
        const m = mode();
        const grid = h('div', { class: 'mini-grid' }, items.map(([label, x, unit, short], i) => {
            const u = unit || m;
            const pct = Math.max(0, Math.min(100, Math.round(x[u])));
            const lv = level(x.left);
            return h('div', { class: `mini${i === items.length - 1 && i % cols === 0 ? ' full' : ''}`, title: `${label}: ${x.estimated ? '~' : ''}${pct}% ${u}` },
                h('div', { class: 'mini-top' },
                    h('span', { class: 'mini-k' }, h('span', { class: 'lf' }, label), short ? h('span', { class: 'ls' }, short) : null),
                    h('span', { class: `mini-v ${lv}` }, `${x.estimated ? '~' : ''}${pct}%`, h('span', { class: 'mini-u' }, ` ${u}`))),
                meter(pct, lv, null, `${label} ${pct}% ${u}`));
        }));
        grid.style.gridTemplateColumns = `repeat(${Math.max(1, cols)}, minmax(0, 1fr))`;
        return grid;
    }

    function agSummary(a) {
        if (a.limits && a.limits.length) {
            const cols = Math.max(...a.limits.map(g => g.windows.length));
            return miniGrid(a.limits.flatMap(g => g.windows.map(w => [`${groupShort(g.name)} ${w.name}`, w, null, `${groupShort(g.name)} ${{ '5-hour': '5h', Weekly: 'wk' }[w.name] || w.name}`])), cols);
        }
        return miniGrid(a.pools.map(p => [groupShort(p.name), p]), Math.min(2, a.pools.length));
    }

    function limitRow(w) {
        const m = mode();
        const pct = Math.max(0, Math.min(100, Math.round(w[m])));
        const lv = level(w.left);
        // Pace tick follows the bar: time gone in "used" mode, time left in "left" mode.
        const pace = typeof w.pacePct === 'number' ? (m === 'left' ? 100 - w.pacePct : w.pacePct) : null;
        const paceNote = pace === null ? '' : ` · Tick: ${pace}% of the window ${m === 'left' ? 'left' : 'gone'}`;
        const rate = w.drainRate ? ` · ↓ ${w.drainRate}%/hr` : '';
        const tip = `${w.group ? w.group + ' · ' : ''}${w.name}: ${pctText(w)}${w.countdown ? ' · ' + resetsText(w) : ''}${paceNote}${rate}${w.forecast ? ' · ' + w.forecast : ''}`;
        const reset = w.estimated ? 'Reset due' : (w.countdown || '-');
        return h('div', { class: 'lim', title: tip },
            h('span', { class: 'lim-name' }, w.short ? groupShort(w.name) : w.name),
            meter(pct, lv, pace, `${w.name} ${pct}% ${m}`),
            h('span', { class: `lim-pct ${lv}` }, lv === 'low' ? icon('warn') : null, `${pct}%`),
            h('span', { class: 'lim-reset' }, reset));
    }

    function groupHead(label, withLegend) {
        return h('div', { class: 'grp-head' },
            h('span', { class: 'grp-name' }, label),
            withLegend ? h('span', { class: 'grp-legend' }, `${mode() === 'left' ? 'Left' : 'Used'} · Resets in`) : null);
    }

    // 5-hour / weekly rows per model group when agy reports them, else one row per pool.
    function antigravityLimits(a) {
        if (a.limits && a.limits.length) {
            return a.limits.map((g, i) => h('div', { class: 'grp' }, groupHead(g.name, i === 0), g.windows.map(limitRow)));
        }
        return a.pools.length ? h('div', { class: 'grp' }, groupHead('Quota pools', true), a.pools.map(limitRow)) : null;
    }

    // Tool cards already name the model in their header, so they pass showModel = false.
    function context(c, showModel) {
        const pctUsed = Math.min(100, Math.max(0, Math.round(c.pct)));
        const lv = c.pct >= 95 ? 'low' : c.pct >= 80 ? 'warn' : 'ok';
        const full = c.pct >= 80;
        const max = c.windowTokens || 0;
        const left = max ? fmtK(Math.max(0, max - c.usedTokens)) : String(c.left || '').split(' / ')[0];
        const parts = [['Input', c.inputTokens], ['Cache read', c.cacheReadTokens], ['Output', c.outputTokens], ['Thinking', c.thinkingTokens]].filter(p => p[1]);
        const hint = full ? (c.source === 'codex' ? 'Nearly full: start a new session or /compact.' : 'Nearly full: /compact to keep going, /clear for a new task.') : '';
        const tip = [hint, parts.map(([k, n]) => `${k} ${fmtK(n)}`).join(' · ')].filter(Boolean).join('\n') || null;
        return h('div', { class: 'ctx', title: tip },
            h('div', { class: 'ctx-head' },
                h('span', { class: 'ctx-title' }, 'Context', showModel ? h('span', { class: 'ctx-model' }, c.model) : null),
                h('span', { class: `ctx-val ${lv}` }, `${pctUsed}%`, h('span', { class: 'muted' }, ` · ${fmtK(c.usedTokens)}${max ? ' / ' + fmtK(max) : ''}`))),
            meter(pctUsed, lv, null, `Context ${pctUsed}% used`),
            h('div', { class: 'ctx-foot' },
                h('span', null, c.windowExact ? 'Session context' : 'Estimated context'),
                full ? h('span', { class: 'hint warn' }, icon('warn'), '/compact') : h('span', null, `${left} left`)));
    }

    function credits(cr) {
        const fmt = n => Number(n).toLocaleString();
        const parts = [];
        if (cr.prompt) parts.push(['Prompt credits', `${fmt(cr.prompt.available)}${cr.prompt.monthly ? ' / ' + fmt(cr.prompt.monthly) : ''}`]);
        if (cr.flow) parts.push(['Flow credits', `${fmt(cr.flow.available)}${cr.flow.monthly ? ' / ' + fmt(cr.flow.monthly) : ''}`]);
        return parts.length ? h('dl', { class: 'kv' }, parts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null;
    }

    function badge(text, cls) {
        return text ? h('span', { class: `badge ${cls || ''}` }, text) : null;
    }

    // Header: product tile, title + one muted meta line, badges, chevron.
    function cardHead(id, tile, title, meta, badges) {
        const open = expanded.has(id);
        return h('button', { class: 'card-head', 'data-action': 'toggle', 'data-id': id, 'aria-expanded': String(open) },
            h('span', { class: `tile ${tile[1]}`, 'aria-hidden': 'true' }, tile[0]),
            h('span', { class: 'head-text' },
                h('span', { class: 'card-title' }, title),
                meta && meta.length ? h('span', { class: 'card-meta' }, meta.filter(Boolean).map((m, i) => [i ? h('span', { class: 'sep' }, '·') : null, m])) : null),
            h('span', { class: 'badges' }, badges, h('span', { class: `chev${open ? ' up' : ''}`, html: ICON.chevron })));
    }

    function card(id, cls, head, summary, body) {
        const open = expanded.has(id);
        return h('section', { class: `card ${cls || ''}` }, head,
            !open && summary ? h('div', { class: 'summary' }, summary) : null,
            open ? h('div', { class: 'card-body' }, body) : null);
    }

    function statusDot(text, cls) {
        return h('span', { class: 'status' }, h('span', { class: `dot ${cls}` }), text);
    }

    function suggestionBanner(sug) {
        const name = sug.betterLabel || sug.betterDisplay;
        return h('section', { class: 'banner' },
            icon('warn'),
            h('span', { class: 'banner-msg' }, `${sug.poolName} is at ${sug.currentPct}% left. `, h('strong', null, name), ` has ${sug.betterPct}%.`),
            h('button', { class: 'btn primary sm', 'data-action': 'switch', 'data-email': sug.betterEmail }, 'Switch'));
    }

    function activeCard(s) {
        const a = s.active;
        const models = [...new Set(a.pools.flatMap(p => p.models || []))];
        const urgent = a.pools.find(p => p.forecast && p.forecast.includes('runs out'));
        const summary = agSummary(a);
        const body = [
            antigravityLimits(a) || h('div', { class: 'muted' }, 'No quota data reported.'),
            urgent ? h('div', { class: 'note warn' }, icon('warn'), urgent.forecast) : null,
            s.agContext ? context(s.agContext, true) : null,
            (models.length || a.credits.prompt || a.credits.flow) ? h('div', { class: 'card-foot' },
                credits(a.credits),
                models.length ? h('div', { class: 'models', title: models.join(', ') }, `Models: ${models.join(', ')}`) : null) : null
        ];
        return card('active', 'is-active',
            cardHead('active', ['AG', 'ag'], 'Antigravity', [statusDot('Active', 'on'), a.display, a.label], [badge(a.planName, 'plan')]),
            summary, body);
    }

    function toolCard(id, tile, title, meta, badges, wins, ctx, foot) {
        const items = wins.map(w => [w.name, w]);
        if (ctx) items.push(['Context', { left: 100 - Math.round(ctx.pct), used: Math.round(ctx.pct), estimated: false }, 'used']);
        const summary = items.length ? miniGrid(items, Math.min(2, items.length)) : null;
        const body = [
            wins.length ? h('div', { class: 'grp' }, groupHead('Usage limits', true), wins.map(limitRow)) : null,
            ctx ? context(ctx, false) : null,
            foot
        ];
        return card(id, '', cardHead(id, tile, title, meta, badges), summary, body);
    }

    function otherCard(a, idx, total) {
        const id = `acc:${a.email}`;
        const ib = (action, ic, label, extra) => h('button', Object.assign({ class: 'btn icon', 'data-action': action, 'data-email': a.email, title: label, 'aria-label': label, html: ICON[ic] }, extra || {}));
        const summary = a.pools.length ? agSummary(a) : h('span', { class: 'muted' }, 'No snapshot yet');
        const body = [
            antigravityLimits(a),
            h('div', { class: 'muted small' }, a.snapshotAgo ? `Snapshot from ${a.snapshotAgo}. Updates when this account is active.` : 'Sign in once to capture a snapshot.'),
            h('div', { class: 'acct-actions' },
                h('button', { class: 'btn primary sm', 'data-action': 'switch', 'data-email': a.email }, 'Switch to account'),
                h('span', { class: 'spacer' }),
                ib('moveAccount', 'up', 'Move up', { 'data-direction': 'up', disabled: idx === 0 }),
                ib('moveAccount', 'down', 'Move down', { 'data-direction': 'down', disabled: idx >= total - 1 }),
                ib('rename', 'tag', 'Set label'),
                ib('remove', 'trash', 'Remove account', { class: 'btn icon danger' }))
        ];
        return card(id, 'is-other',
            cardHead(id, ['AG', 'muted'], a.label || a.display, [a.label ? a.display : null, a.snapshotAgo ? `seen ${a.snapshotAgo}` : null], [badge(`#${idx + 1}`, 'rank'), badge(a.planName, 'plan')]),
            summary, body);
    }

    function notice(title, text, action) {
        return h('section', { class: 'card notice' },
            h('div', { class: 'notice-title' }, title),
            text ? h('div', { class: 'muted small' }, text) : null,
            action ? h('div', { class: 'acct-actions' }, action) : null);
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
            h('div', { class: 'acct-actions' }, h('button', { class: 'btn', 'data-action': 'openSettings' }, 'All settings in VS Code'))
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
        if (s.suggestion) body.push(suggestionBanner(s.suggestion));
        if (s.active) body.push(activeCard(s));
        if (s.claude.show) {
            const foot = s.claude.usageEnabled
                ? (s.claude.usageError ? h('div', { class: 'muted small' }, s.claude.usageError + (s.claude.usageAgo ? `. Showing values from ${s.claude.usageAgo}.` : '')) : null)
                : h('div', { class: 'acct-actions' }, h('button', { class: 'btn sm', 'data-action': 'enableClaudeLimits' }, 'Show 5-hour and weekly limits'));
            const ctx = s.claude.context;
            body.push(toolCard('claude', ['CC', 'cc'], 'Claude Code', [ctx ? ctx.model : 'CLI'], [], s.claude.windows, ctx, foot));
        }
        if (s.codex.show) {
            const cx = s.codex;
            const info = cx.idle
                ? `Not used for ${cx.lastUsedAgo.replace(/ ago$/, '')}. Hidden from the status bar until it runs again.`
                : [cx.credits, cx.windows.length ? `Limits as of ${cx.asOfAgo}` : ''].filter(Boolean).join(' · ');
            const meta = [cx.idle ? statusDot('Idle', 'idle') : null, cx.context ? cx.context.model : 'CLI'];
            body.push(toolCard('codex', ['CX', 'cx'], 'Codex', meta, [badge(cx.plan, 'plan')], cx.windows, cx.context,
                info ? h('div', { class: 'muted small' }, info) : null));
        }
        // Missing Antigravity goes below the tools that have data; nothing at all when it is turned off.
        const agOn = s.antigravityEnabled !== false;
        if (agOn && !s.active && s.connecting) {
            body.push(notice('Looking for Antigravity...', '', null));
        } else if (agOn && !s.active) {
            body.push(notice('Antigravity not detected', 'Start agy or the Antigravity IDE. Quota Nexus connects to its local server automatically.',
                h('button', { class: 'btn sm', 'data-action': 'diagnostics' }, 'Show diagnostics')));
        }
        if (agOn) {
            body.push(h('div', { class: 'section-label' }, 'Other accounts', h('span', { class: 'count' }, String(s.others.length))));
            body.push(...s.others.map((a, i) => otherCard(a, i, s.others.length)));
            body.push(h('button', { class: 'btn ghost wide', 'data-action': 'signIn' }, icon('plus'), 'Sign in with another account'));
        }
        if (!body.length) {
            body.push(notice('Nothing to show', 'Every tool is turned off or has no data yet.',
                h('button', { class: 'btn sm', 'data-action': 'toggleSettings' }, 'Open settings')));
        }
        body.push(h('footer', null,
            `Updated ${s.updatedAgo}`, h('span', { class: 'sep' }, '·'), 'Local data only', h('span', { class: 'sep' }, '·'),
            h('button', { class: 'link', 'data-action': 'diagnostics' }, 'Diagnostics')));

        root.replaceChildren(...body);
    }

    root.addEventListener('click', (e) => {
        const el = e.target instanceof Element ? e.target.closest('[data-action]') : null;
        if (!el || el.hasAttribute('disabled')) return;
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
        vscode.postMessage({
            type: action,
            email: el.getAttribute('data-email') || undefined,
            direction: el.getAttribute('data-direction') || undefined
        });
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
