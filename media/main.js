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

    function resetsText(x) {
        return x.countdown === 'now' ? `Resets now (${x.wall})` : `Resets in ${x.countdown} (${x.wall})`;
    }

    function resetPassedText() {
        return `Reset time has passed - likely back to ${mode() === 'used' ? '0% used' : '100% left'}`;
    }

    function ctxPct(c) {
        const used = Math.round(c.pct);
        return { used, left: 100 - used };
    }

    function notes(...lines) {
        return lines.filter(Boolean).map(t => h('div', { class: 'row-note' }, t));
    }

    function createGrad(id, c1, c2) {
        const grad = document.createElementNS(SVG_NS, 'linearGradient');
        grad.setAttribute('id', id);
        grad.setAttribute('x1', '0%');
        grad.setAttribute('y1', '0%');
        grad.setAttribute('x2', '100%');
        grad.setAttribute('y2', '100%');
        const s1 = document.createElementNS(SVG_NS, 'stop');
        s1.setAttribute('offset', '0%');
        s1.setAttribute('stop-color', c1);
        const s2 = document.createElementNS(SVG_NS, 'stop');
        s2.setAttribute('offset', '100%');
        s2.setAttribute('stop-color', c2);
        grad.append(s1, s2);
        return grad;
    }

    function svgDefs() {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'svg-defs');
        svg.setAttribute('aria-hidden', 'true');
        const defs = document.createElementNS(SVG_NS, 'defs');
        defs.append(
            createGrad('g-gemini', '#06b6d4', '#8b5cf6'),
            createGrad('g-claude', '#f97316', '#f43f5e'),
            createGrad('g-gpt', '#10b981', '#06b6d4'),
            createGrad('g-cx', '#3b82f6', '#6366f1'),
            createGrad('g-ok', '#10b981', '#22c55e'),
            createGrad('g-warn', '#f59e0b', '#ea580c'),
            createGrad('g-low', '#f43f5e', '#e11d48')
        );
        svg.append(defs);
        return svg;
    }

    function dialStroke(p) {
        if (p.left <= 10) return 'url(#g-low)';
        if (p.left <= 30) return 'url(#g-warn)';
        const n = (p.name || p.short || '').toLowerCase();
        if (n.includes('gemini')) return 'url(#g-gemini)';
        if (n.includes('claude')) return 'url(#g-claude)';
        if (n.includes('gpt')) return 'url(#g-gpt)';
        return 'url(#g-ok)';
    }

    function dialGauge(p) {
        const m = mode();
        const pct = Math.max(0, Math.min(100, Math.round(p[m])));
        const fillLen = ((pct / 100) * 122.9).toFixed(1);
        const tip = `${p.name}: ${pctText(p)}${p.countdown ? ' · ' + resetsText(p) : ''}${p.forecast ? ' · ' + p.forecast : ''}${p.models && p.models.length ? ' · Models: ' + p.models.join(', ') : ''}`;

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 84 80');
        svg.setAttribute('class', 'dial-svg');

        const track = document.createElementNS(SVG_NS, 'circle');
        track.setAttribute('cx', '42');
        track.setAttribute('cy', '40');
        track.setAttribute('r', '32');
        track.setAttribute('class', 'dial-track');
        track.setAttribute('stroke-dasharray', '122.9 201.1');
        track.setAttribute('transform', 'rotate(160 42 40)');

        const fill = document.createElementNS(SVG_NS, 'circle');
        fill.setAttribute('cx', '42');
        fill.setAttribute('cy', '40');
        fill.setAttribute('r', '32');
        fill.setAttribute('class', 'dial-fill');
        fill.setAttribute('stroke', dialStroke(p));
        fill.setAttribute('stroke-dasharray', `${fillLen} 201.1`);
        fill.setAttribute('transform', 'rotate(160 42 40)');

        const textVal = document.createElementNS(SVG_NS, 'text');
        textVal.setAttribute('x', '42');
        textVal.setAttribute('y', '38');
        textVal.setAttribute('text-anchor', 'middle');
        textVal.setAttribute('class', 'dial-val');
        textVal.textContent = `${pct}%`;

        const textMode = document.createElementNS(SVG_NS, 'text');
        textMode.setAttribute('x', '42');
        textMode.setAttribute('y', '49');
        textMode.setAttribute('text-anchor', 'middle');
        textMode.setAttribute('class', 'dial-mode');
        textMode.textContent = m;

        svg.append(track, fill, textVal, textMode);

        const subText = p.estimated ? '~est' : (p.countdown || 'Ready');
        const pillCls = level(p.left);
        let pillText = pillCls === 'low' ? 'Low' : pillCls === 'warn' ? 'Tight' : 'Safe';
        if (p.drainRate) {
            pillText = `↓ ${p.drainRate}%/h`;
        }

        return h('div', { class: 'dial-cell', title: tip },
            svg,
            h('div', { class: 'dial-name', title: p.name }, p.short || p.name),
            h('div', { class: 'dial-sub' }, subText),
            h('span', { class: `pill-tag ${pillCls}` }, pillText));
    }

    function poolRow(p, withModels) {
        let reset;
        if (p.estimated) reset = resetPassedText();
        else if (p.pct >= 100) reset = 'Nothing used yet';
        else if (p.countdown) reset = resetsText(p);
        return h('div', { class: 'row' },
            h('div', { class: 'row-head' },
                h('span', { class: 'row-name' }, p.name),
                pctHead(p)),
            bar(p[mode()], level(p.left)),
            notes(reset, p.forecast),
            withModels && p.models && p.models.length ? h('div', { class: 'row-note models' }, `Models: ${p.models.join(', ')}`) : null,
            spark(p.spark));
    }

    function fillClass(w) {
        if (w.left <= 10) return 'low';
        if (w.left <= 30) return 'warn';
        const n = (w.name || w.short || '').toLowerCase();
        if (n.includes('gemini') || n.includes('gem')) return 'gemini';
        if (n.includes('claude') || n.includes('cl/')) return 'claude';
        if (n.includes('gpt')) return 'gpt';
        return 'ok';
    }

    function limitRow(w) {
        const m = mode();
        const rateNote = w.drainRate ? ` · ↓ ${w.drainRate}%/hr` : '';
        const tip = `${w.name}: ${pctText(w)}${w.countdown ? ' · ' + resetsText(w) : ''}${rateNote}${w.forecast ? ' · ' + w.forecast : ''}`;
        const pct = Math.max(0, Math.min(100, Math.round(w[m])));
        const cls = fillClass(w);

        const fill = h('div', { class: `pill-fill ${cls}` });
        fill.style.width = `${pct}%`;

        const track = h('div', { class: 'pill-track', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct }, fill);
        if (w.pacePct !== null && w.pacePct >= 0 && w.pacePct <= 100) {
            const needle = h('div', { class: 'pill-needle', title: `Pace marker: elapsed window time (${w.pacePct}%)` });
            needle.style.left = `${Math.min(98, Math.max(2, w.pacePct))}%`;
            track.append(needle);
        }

        const resetText = w.estimated ? '~est' : (w.countdown || 'Ready');
        return h('div', { class: 'stream-row', title: tip },
            h('span', { class: 'stream-label' }, w.short || w.name),
            track,
            h('span', { class: `stream-pct ${level(w.left)}` }, `${pct}%`),
            h('span', { class: 'stream-reset' }, resetText));
    }

    function fmtK(n) {
        if (!n || n <= 0) return '0';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
        return String(n);
    }

    function contextSpectrum(c) {
        const cls = c.pct >= 95 ? 'low' : c.pct >= 80 ? 'warn' : 'ok';
        const tip = c.pct >= 80 ? (c.source === 'codex' ? 'Nearly full: start a new session or /compact.' : 'Nearly full: /compact to keep going, /clear for a new task.') : '';
        const pctUsed = Math.min(100, Math.max(0, Math.round(c.pct)));

        const track = h('div', { class: 'spectrum-track', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pctUsed });
        const hasGranular = c.maxTokens && (c.inputTokens || c.outputTokens || c.cacheReadTokens || c.thinkingTokens);

        const legendDots = [];
        if (hasGranular) {
            const max = c.maxTokens;
            if (c.inputTokens) {
                const s = h('div', { class: 'spectrum-seg seg-in', title: `Input: ${fmtK(c.inputTokens)}` });
                s.style.width = `${((c.inputTokens / max) * 100).toFixed(2)}%`;
                track.append(s);
                legendDots.push(h('span', { class: 'legend-item' }, h('span', { class: 'leg-dot in' }), `In ${fmtK(c.inputTokens)}`));
            }
            if (c.cacheReadTokens) {
                const s = h('div', { class: 'spectrum-seg seg-cache', title: `Cache: ${fmtK(c.cacheReadTokens)}` });
                s.style.width = `${((c.cacheReadTokens / max) * 100).toFixed(2)}%`;
                track.append(s);
                legendDots.push(h('span', { class: 'legend-item' }, h('span', { class: 'leg-dot cache' }), `Cache ${fmtK(c.cacheReadTokens)}`));
            }
            if (c.thinkingTokens) {
                const s = h('div', { class: 'spectrum-seg seg-think', title: `Thinking: ${fmtK(c.thinkingTokens)}` });
                s.style.width = `${((c.thinkingTokens / max) * 100).toFixed(2)}%`;
                track.append(s);
                legendDots.push(h('span', { class: 'legend-item' }, h('span', { class: 'leg-dot think' }), `Think ${fmtK(c.thinkingTokens)}`));
            }
            if (c.outputTokens) {
                const s = h('div', { class: 'spectrum-seg seg-out', title: `Output: ${fmtK(c.outputTokens)}` });
                s.style.width = `${((c.outputTokens / max) * 100).toFixed(2)}%`;
                track.append(s);
                legendDots.push(h('span', { class: 'legend-item' }, h('span', { class: 'leg-dot out' }), `Out ${fmtK(c.outputTokens)}`));
            }
        } else {
            const s = h('div', { class: `spectrum-seg bar-fill ${cls}` });
            s.style.width = `${pctUsed}%`;
            track.append(s);
            legendDots.push(h('span', { class: 'muted' }, c.windowExact ? 'Session context' : 'Estimated context'));
        }

        const headRight = `${pctUsed}% used · ${fmtK(c.usedTokens)}${c.maxTokens ? ' / ' + fmtK(c.maxTokens) : ''}`;
        return h('div', { class: 'context-box', title: tip || undefined },
            h('div', { class: 'context-head' },
                h('span', { class: 'row-name' }, `Context · ${c.model}`),
                h('span', { class: 'muted' }, headRight)),
            track,
            h('div', { class: 'token-legend' },
                h('div', { class: 'legend-items' }, legendDots),
                c.pct >= 80 ? h('span', { class: 'compact-btn', title: tip }, '/compact recommended') : h('span', { class: 'muted' }, `${c.left} left`)));
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

    function suggestionBanner(sug) {
        if (!sug) return null;
        const name = sug.betterLabel || sug.betterDisplay;
        return h('section', { class: 'card suggestion-card' },
            h('div', { class: 'suggestion-body' },
                h('div', { class: 'suggestion-title' },
                    h('span', { class: 'badge warn' }, 'Suggestion'),
                    h('span', { class: 'suggestion-msg' },
                        `${sug.poolName} is ${sug.currentPct}% left. `,
                        h('strong', null, name),
                        ` has ${sug.betterPct}% available.`)),
                h('button', { class: 'btn primary small', 'data-action': 'switch', 'data-email': sug.betterEmail }, 'Switch now')));
    }

    function activeCard(s) {
        const a = s.active;
        const open = expanded.has('active');
        const allModels = [...new Set(a.pools.flatMap(p => p.models || []))];
        const modelsText = allModels.length ? `Models: ${allModels.join(', ')}` : '';
        const urgent = a.pools.find(p => p.forecast && p.forecast.includes('runs out'));
        return h('section', { class: 'card active' },
            cardHeader('active', h('span', null, h('span', { class: 'dot on' }), a.display),
                [badge(a.label, 'label'), badge('Active', 'on'), badge(a.planName, 'plan')]),
            !open ? h('div', { class: 'summary' }, a.pools.map(p => h('span', null, `${p.short} ${pctText(p)}`))) : null,
            open ? h('div', { class: 'details' },
                a.pools.length ? [
                    h('div', { class: 'stream-head' },
                        h('span', null, 'Pool'),
                        h('span', null, 'Used / Pace / Reset')),
                    ...a.pools.map(limitRow)
                ] : h('div', { class: 'muted' }, 'No quota data reported.'),
                urgent ? h('div', { class: 'row-note' }, urgent.forecast) : null,
                modelsText ? h('div', { class: 'models-summary', title: modelsText }, modelsText) : null,
                s.agContext ? contextSpectrum(s.agContext) : null,
                credits(a.credits)) : null);
    }

    function toolCard(id, title, dotCls, badges, wins, context, footer) {
        const open = expanded.has(id);
        const sum = wins.map(w => h('span', null, `${w.name} ${pctText(w)}`));
        if (context) sum.push(h('span', null, `ctx ${Math.round(ctxPct(context)[mode()])}% ${mode()}`));
        return h('section', { class: 'card' },
            cardHeader(id, h('span', null, h('span', { class: `dot ${dotCls}` }), title), badges),
            !open ? h('div', { class: 'summary' }, sum) : null,
            open ? h('div', { class: 'details' },
                wins.length ? [
                    h('div', { class: 'stream-head' },
                        h('span', null, 'Window'),
                        h('span', null, 'Used / Pace / Reset')),
                    ...wins.map(limitRow)
                ] : null,
                context ? contextSpectrum(context) : null,
                footer) : null);
    }

    function otherCard(a, idx, total) {
        const id = `acc:${a.email}`;
        const open = expanded.has(id);
        const rank = typeof idx === 'number' ? badge(`#${idx + 1}`, 'rank') : null;
        const canUp = typeof idx === 'number' && idx > 0;
        const canDown = typeof idx === 'number' && typeof total === 'number' && idx < total - 1;
        return h('section', { class: 'card' },
            cardHeader(id, h('span', null, h('span', { class: 'dot' }), a.display), [rank, badge(a.label, 'label'), badge(a.planName, 'plan')]),
            !open ? h('div', { class: 'summary' },
                a.pools.length ? a.pools.map(p => h('span', null, `${p.short} ${pctText(p)}`)) : h('span', { class: 'muted' }, 'No snapshot yet')) : null,
            open ? h('div', { class: 'details' },
                a.pools.length ? [
                    h('div', { class: 'stream-head' },
                        h('span', null, 'Pool'),
                        h('span', null, 'Used / Pace / Reset')),
                    ...a.pools.map(limitRow)
                ] : null,
                h('div', { class: 'muted small' }, a.snapshotAgo ? `Last seen ${a.snapshotAgo}. Values update when this account is active.` : 'Sign in once to capture a snapshot.'),
                h('div', { class: 'actions' },
                    h('button', { class: 'btn primary', 'data-action': 'switch', 'data-email': a.email }, 'Switch to this account'),
                    h('button', { class: 'btn icon', 'data-action': 'moveAccount', 'data-direction': 'up', 'data-email': a.email, disabled: !canUp, title: 'Move up priority' }, '↑'),
                    h('button', { class: 'btn icon', 'data-action': 'moveAccount', 'data-direction': 'down', 'data-email': a.email, disabled: !canDown, title: 'Move down priority' }, '↓'),
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
        const body = [svgDefs()];
        if (s.snoozed) {
            body.push(h('div', { class: 'muted small snoozed' }, 'Alerts snoozed for up to 1 hour. ',
                h('button', { class: 'link', 'data-action': 'snooze' }, 'Resume')));
        }
        if (s.suggestion) body.push(suggestionBanner(s.suggestion));
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
            body.push(...s.others.map((a, i) => otherCard(a, i, s.others.length)));
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
