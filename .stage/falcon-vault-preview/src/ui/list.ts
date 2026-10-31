import type { Ctx, Entry } from './app.js';
import { ago, h, host, icon, shownPath, who } from './dom.js';

/** What the list shows, as its heading says it. */
export function listTitle(c: Ctx, count: number) {
	const p = c.params;
	if (p.q) return `Search · ${count}`;
	if (p.v === 'history') return 'History';
	if (p.v === 'needs') return `Needs a value · ${count}`;
	if (p.v === 'recycle') return `Recycle Bin · ${count}`;
	return `${p.g ? shownPath(p.g) : 'All entries'} · ${count}`;
}

/** The second line: username · site, or who asked and when for a Request. */
function subline(c: Ctx, e: Entry) {
	if (e.request && c.params.v === 'needs')
		return `Asked by ${who(e.request.actor)} · ${ago(e.request.at)}`;
	const parts = [e.username, e.url ? host(e.url) : ''].filter(Boolean);
	// Entries from a subgroup say where they are.
	const sub = c.params.g && e.group !== c.params.g ? e.group.slice(c.params.g.length + 1) : '';
	const where =
		c.params.v === 'recycle'
			? e.from
				? `from ${shownPath(e.from)}`
				: ''
			: shownPath(c.params.q ? e.group : sub);
	return [where, parts.join(' · ')].filter(Boolean).join(' — ');
}

/** The entry list (spec §9): each entry's title, with username · site underneath. */
export function list(c: Ctx, entries: Entry[]) {
	const p = c.params;
	const rows = entries.map((e) => {
		const params = { ...p, e: e.path, u: e.uuid, m: undefined };
		const selected = p.e === e.path && (!p.u || p.u === e.uuid);
		return h(
			'a',
			{
				class: `fv-row${selected ? ' is-selected' : ''}`,
				href: c.href(params),
				'aria-current': selected ? 'true' : null,
				on: { click: (ev: Event) => (ev.preventDefault(), c.go(params)) }
			},
			h(
				'span',
				{ class: 'fv-row-text' },
				h('span', { class: 'fv-row-title' }, e.title || '(no title)'),
				h('span', { class: 'fv-row-sub' }, subline(c, e) || ' ')
			),
			e.request ? h('span', { class: 'fv-dot fv-dot-accent', title: 'Needs a value' }) : null,
			h('span', { class: 'fv-row-chevron' }, icon('chevronRight', 16))
		);
	});
	return h(
		'section',
		{ class: 'fv-list', 'aria-label': 'Entries' },
		h(
			'h2',
			{ class: 'fv-list-head' },
			h('span', { class: 'fv-dot fv-dot-accent', 'aria-hidden': 'true' }),
			listTitle(c, entries.length)
		),
		rows.length
			? h('div', { class: 'fv-rows' }, rows)
			: h(
					'p',
					{ class: 'fv-empty' },
					p.q
						? 'Nothing matches.'
						: p.v === 'needs'
							? 'No agent is waiting for a value.'
							: p.v === 'recycle'
								? 'The Recycle Bin is empty.'
								: 'No entries here yet.'
				)
	);
}
