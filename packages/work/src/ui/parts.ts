import type { Ctx } from './app.js';
import { PLUGIN_VERSION } from '../identity.js';
import { h, icon, ago, dotted, who, count, type Child } from './dom.js';
import type { Entry, ItemKind, ItemRef, NeedsYouItem, SessionRef, TaskLine } from './types.js';

export const KIND: Record<ItemKind, string> = { job: 'Job', project: 'Project', task: 'Task' };

/** A link to a Work item's page. */
export function itemLink(
	c: Ctx,
	ref: Pick<ItemRef, 'id' | 'kind' | 'title'>,
	cls = 'fw-item-link'
) {
	return h(
		'a',
		{
			class: cls,
			href: c.hrefFor(ref),
			on: { click: (e: Event) => (e.preventDefault(), c.open(ref)) }
		},
		ref.title
	);
}

/** A small sentence-case chip naming what kind of item this is. */
export const kindChip = (kind: ItemKind) => h('span', { class: 'fw-kind' }, KIND[kind]);

/**
 * A session chip: its title and when it was last active; clicking opens that chat. A session that
 * no longer exists is greyed out and does nothing. The chip keeps its key so the page can redraw it
 * when the session list changes.
 */
export function sessionChip(c: Ctx, key: string, at: string | null = null) {
	const s = c.session(key);
	const data = { 'data-session': key, ...(at ? { 'data-at': at } : {}) };
	if (s === null)
		return h(
			'span',
			{ class: 'fw-session is-missing', title: key, ...data },
			h('span', { class: 'fw-session-dot' }),
			h('span', { class: 'fw-session-title' }, 'session no longer available')
		);
	return h(
		'button',
		{
			class: `fw-session${s?.active ? ' is-active' : ''}`,
			type: 'button',
			title: s ? `Open session: ${s.title}` : 'Open session',
			on: { click: (e: Event) => (e.stopPropagation(), c.openSession(key)) },
			...data
		},
		h('span', { class: 'fw-session-dot' }),
		h('span', { class: 'fw-session-title' }, s?.title ?? 'Session'),
		at ? h('span', { class: 'fw-session-at' }, ` · ${ago(at)}`) : null
	);
}

/** A section with a heading, "Title (n)" when counted. */
export const section = (
	title: string,
	n: number | null,
	opts: { dot?: 'accent' | 'muted'; cls?: string } = {},
	...body: Child[]
) =>
	h(
		'section',
		{ class: `fw-section${opts.cls ? ` ${opts.cls}` : ''}` },
		h(
			'h2',
			{ class: 'fw-section-title' },
			opts.dot ? h('span', { class: `fw-dot fw-dot-${opts.dot}` }) : null,
			n === null ? title : `${title} (${n})`
		),
		...body
	);

export const empty = (text: string) => h('p', { class: 'fw-empty' }, text);

/** A card in the side column. */
export const side = (title: string, ...body: Child[]) =>
	h('section', { class: 'fw-side-card' }, h('h3', { class: 'fw-side-title' }, title), ...body);

export const pageTitle = () => `Falcon Work v${PLUGIN_VERSION.replace(/^[^-]+-/, '')}`;

/** The search field; submitting it opens the results. */
export function searchField(c: Ctx, value = '') {
	const input = h('input', {
		class: 'fw-search-input',
		type: 'search',
		placeholder: 'Search Jobs, Projects and Tasks…',
		'aria-label': 'Search Falcon Work',
		value
	});
	return h(
		'form',
		{
			class: 'fw-search',
			role: 'search',
			on: {
				submit: (e: Event) => {
					e.preventDefault();
					const q = input.value.trim();
					q ? c.go({ q }) : c.go({});
				}
			}
		},
		icon('search'),
		input
	);
}

export const backLink = (c: Ctx) =>
	h(
		'a',
		{
			class: 'fw-back',
			href: c.href({}),
			on: { click: (e: Event) => (e.preventDefault(), c.go({})) }
		},
		icon('back'),
		'Falcon Work'
	);

/** Status words and tone for a Task or Job status. */
export function status(s: string): { label: string; tone: 'ok' | 'run' | 'warn' | 'muted' } {
	switch (s) {
		case 'completed':
			return { label: 'Done', tone: 'ok' };
		case 'in_progress':
			return { label: 'In progress', tone: 'run' };
		case 'active':
			return { label: 'Active', tone: 'run' };
		case 'waiting':
			return { label: 'Waiting', tone: 'warn' };
		case 'paused':
			return { label: 'Paused', tone: 'warn' };
		case 'ready':
			return { label: 'Ready', tone: 'muted' };
		case 'abandoned':
			return { label: 'Abandoned', tone: 'muted' };
		case 'retired':
			return { label: 'Retired', tone: 'muted' };
		default:
			return { label: s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' '), tone: 'muted' };
	}
}

/** "Waiting on you: the export" → "Waiting on you". */
const waitingShort = (w: string | null) => (w ? w.split(':')[0] : 'Waiting');

/** The status mark at the start of a Task row: a check when done, otherwise a coloured dot. */
export const statusMark = (s: string) =>
	s === 'completed'
		? h('span', { class: 'fw-mark fw-tone-ok' }, icon('tick'))
		: h(
				'span',
				{ class: `fw-mark fw-tone-${status(s).tone}` },
				h('span', { class: 'fw-mark-dot' })
			);

export const statusPill = (t: Pick<TaskLine, 'status' | 'waiting'>) => {
	const s = status(t.status);
	return h(
		'span',
		{ class: `fw-pill fw-pill-${s.tone}`, title: t.waiting ?? undefined },
		t.status === 'waiting' ? waitingShort(t.waiting) : s.label
	);
};

/** "Task · ● In progress" above a detail page's title. */
export const kindLine = (kind: ItemKind, s?: string) =>
	h(
		'div',
		{ class: 'fw-kind-line' },
		KIND[kind],
		s
			? [
					' · ',
					h(
						'span',
						{ class: `fw-state fw-tone-${status(s).tone}` },
						h('span', { class: 'fw-mark-dot' }),
						status(s).label
					)
				]
			: null
	);

/** The head of a Project, Task or Job page. */
export function detailHead(
	c: Ctx,
	o: {
		kind: ItemKind;
		status?: string;
		title: string;
		line: string | null;
		waiting?: string | null;
		meta: Child[];
	}
) {
	return h(
		'header',
		{ class: 'fw-detail-head' },
		backLink(c),
		kindLine(o.kind, o.status),
		h('h1', { class: 'fw-title' }, o.title),
		o.line ? h('p', { class: 'fw-lede' }, o.line) : null,
		o.waiting && o.waiting !== o.line ? h('p', { class: 'fw-waiting' }, o.waiting) : null,
		h('p', { class: 'fw-meta' }, dotted(...o.meta))
	);
}

/** The item was not found (removed, or a stale link). */
export const missing = (c: Ctx, kind: ItemKind) =>
	h(
		'div',
		{ class: 'fw-detail' },
		detailHead(c, { kind, title: 'Not found', line: null, meta: [] }),
		empty(`This ${KIND[kind]} no longer exists.`)
	);

/** Main column and side column. */
export const columns = (main: Child[], aside: Child[]) =>
	h(
		'div',
		{ class: 'fw-columns' },
		h('div', { class: 'fw-main' }, main),
		h('aside', { class: 'fw-aside' }, aside)
	);

/**
 * Needs you on an item's own page: a row per ask with the session on the right. (Home groups the
 * asks by session; see views/needs.ts.)
 */
export function needsYou(c: Ctx, items: NeedsYouItem[], opts: { page: string }) {
	return h(
		'div',
		{ class: 'fw-needs' },
		items.map((n) =>
			h(
				'article',
				{ class: 'fw-need fw-need-row' },
				h(
					'div',
					{ class: 'fw-need-body' },
					n.about && n.about.id !== opts.page
						? h('div', { class: 'fw-need-about' }, itemLink(c, n.about))
						: null,
					h('p', { class: 'fw-need-prompt' }, n.prompt)
				),
				n.session ? sessionChip(c, n.session, n.since) : null
			)
		)
	);
}

/** The sessions an item's work happened in, newest first. */
export const sessionList = (c: Ctx, list: SessionRef[]) =>
	list.length
		? h(
				'div',
				{ class: 'fw-session-list' },
				list.map((s) => sessionChip(c, s.key, s.last_seen_at))
			)
		: h('p', { class: 'fw-side-empty' }, 'No sessions yet');

/** One evidence chip per outcome or source. */
export const evidence = (items: { label?: string; ref?: string }[]) =>
	items.length
		? h(
				'div',
				{ class: 'fw-evidence' },
				items.map((o) =>
					h(
						'span',
						{ class: 'fw-evidence-chip', title: o.ref ?? o.label ?? '' },
						o.label ?? o.ref ?? ''
					)
				)
			)
		: null;

/**
 * What happened: one sentence per entry with a muted "— William, 2h ago", on a thin guide line,
 * newest first. The item it is about links to its page, unless that is the page being shown.
 */
export function happened(
	c: Ctx,
	entries: Entry[],
	opts: { page?: string; evidence?: boolean } = {}
) {
	return h(
		'ul',
		{ class: 'fw-happened' },
		entries
			.filter((e) => e.summary || (opts.evidence && e.outcomes.length))
			.map((e) =>
				h(
					'li',
					{ class: 'fw-happened-entry' },
					h(
						'p',
						{ class: 'fw-happened-line' },
						e.summary ?? h('span', { class: 'fw-muted' }, count(e.outcomes.length, 'outcome')),
						h(
							'span',
							{ class: 'fw-attribution' },
							` — ${who(e.agent || e.by, c.owner)}, ${ago(e.at)}`,
							e.item && e.item.id !== opts.page
								? [' · ', itemLink(c, e.item, 'fw-item-link fw-quiet-link')]
								: null
						)
					),
					opts.evidence ? evidence(e.outcomes) : null
				)
			)
	);
}

/** A Task as a row inside a Milestone or list: mark, title, pill. */
export const taskRow = (c: Ctx, t: TaskLine) =>
	h(
		'div',
		{ class: `fw-task-row${t.status === 'completed' ? ' is-done' : ''}` },
		statusMark(t.status),
		itemLink(c, { id: t.id, kind: 'task', title: t.title }, 'fw-item-link fw-task-title'),
		statusPill(t)
	);

/**
 * A dense Task row (a Job's tasks): mark, title, its status line, when, and its latest session.
 */
export const denseTaskRow = (c: Ctx, t: TaskLine) =>
	h(
		'div',
		{ class: 'fw-dense-row' },
		statusMark(t.status),
		itemLink(c, { id: t.id, kind: 'task', title: t.title }, 'fw-item-link fw-dense-title'),
		h(
			'span',
			{ class: 'fw-dense-line', title: t.waiting ?? t.status_line ?? '' },
			t.waiting ?? t.status_line ?? status(t.status).label
		),
		h('span', { class: 'fw-dense-at' }, ago(t.updated_at)),
		t.sessions[0] ? sessionChip(c, t.sessions[0].key) : h('span')
	);

/** A collapsible row ("Done this week (12)") that remembers whether it was open. */
export function expander(c: Ctx, name: string, label: string, ...body: Child[]) {
	const d = h(
		'details',
		{ class: 'fw-expander', open: c.expanded.has(name) },
		h('summary', null, h('span', null, label), icon('chevron')),
		h('div', { class: 'fw-expander-body' }, ...body)
	);
	d.addEventListener('toggle', () => (d.open ? c.expanded.add(name) : c.expanded.delete(name)));
	return d;
}
