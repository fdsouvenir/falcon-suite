import type { Ctx } from '../app.js';
import { h, icon, ago, who, count } from '../dom.js';
import { itemLink } from '../parts.js';
import type { NeedsYouItem } from '../types.js';

/** Sessions shown before "Show N older sessions". */
const SESSIONS = 8;
/** Asks shown in an open session before "+N more". */
const ASKS = 5;
const NO_SESSION = '';

type Group = { key: string; items: NeedsYouItem[]; latest: string };
type Kind = 'all' | 'question' | 'decision';

/** Filters live with the page, not the data: they survive the redraws a change triggers. */
const filters = new WeakMap<Set<string>, { kind: Kind; agent: string }>();

const agentOf = (key: string) => /^agent:([^:]+):/.exec(key)?.[1] ?? null;

/** Asks grouped by the session they came from; newest session first, newest ask first. */
function groups(items: NeedsYouItem[]): Group[] {
	const by = new Map<string, NeedsYouItem[]>();
	for (const n of items) {
		const k = n.session ?? NO_SESSION;
		by.set(k, [...(by.get(k) ?? []), n]);
	}
	return [...by]
		.map(([key, list]) => {
			const sorted = [...list].sort((a, b) => b.since.localeCompare(a.since));
			return { key, items: sorted, latest: sorted[0].since };
		})
		.sort((a, b) => b.latest.localeCompare(a.latest));
}

/**
 * Needs you on Home (spec §6): the asks grouped by session in one dense accordion. Read-only apart
 * from Dismiss; a session that no longer exists offers "Dismiss all", since nothing else clears it.
 */
export function needsBySession(
	c: Ctx,
	first: NeedsYouItem[],
	more: { total: number; next: string | null } = { total: first.length, next: null }
) {
	const all = [...first];
	let loading = !!more.next;
	const open = c.expanded;
	const f = filters.get(open) ?? { kind: 'all' as Kind, agent: '' };
	filters.set(open, f);
	const gone = new Set<string>();
	const busy = new Set<string>();
	let ctx = c;

	const root = h('div', { class: 'fw-needs-groups', 'data-needs': '' }) as HTMLElement & {
		repaint?: (c: Ctx) => void;
	};
	root.repaint = (next) => {
		ctx = next;
		draw();
	};

	const visible = () =>
		all.filter(
			(n) =>
				!gone.has(n.id) &&
				(f.kind === 'all' || n.kind === f.kind) &&
				(!f.agent || agentOf(n.session ?? '') === f.agent)
		);

	const toggle = (name: string, on = !open.has(name)) => (
		on ? open.add(name) : open.delete(name),
		draw()
	);

	async function dismiss(list: NeedsYouItem[]) {
		for (const n of list) busy.add(n.id);
		draw();
		for (const n of list)
			try {
				await ctx.dismiss(n);
				gone.add(n.id);
			} catch (error) {
				root.dataset.error = (error as Error).message;
			} finally {
				busy.delete(n.id);
			}
		draw();
	}

	function filterBar(): HTMLElement {
		const left = all.filter((n) => !gone.has(n.id));
		const q = left.filter((n) => n.kind === 'question').length;
		const seg = (kind: Kind, label: string, n: number) =>
			h(
				'button',
				{
					type: 'button',
					class: `fw-seg${f.kind === kind ? ' is-on' : ''}`,
					'aria-pressed': f.kind === kind ? 'true' : 'false',
					on: { click: () => ((f.kind = kind), draw()) }
				},
				label,
				h('span', { class: 'fw-seg-count' }, String(n))
			);
		const agents = [
			...new Set(left.map((n) => agentOf(n.session ?? '')).filter(Boolean))
		] as string[];
		return h(
			'div',
			{ class: 'fw-needs-filters' },
			h(
				'div',
				{ class: 'fw-segs', role: 'group', 'aria-label': 'Show' },
				seg('all', 'All', left.length),
				seg('question', 'Questions', q),
				seg('decision', 'Decisions', left.length - q)
			),
			agents.length > 1
				? h(
						'select',
						{
							class: 'fw-needs-agent',
							'aria-label': 'Agent',
							on: {
								change: (e: Event) => ((f.agent = (e.target as HTMLSelectElement).value), draw())
							}
						},
						h('option', { value: '', selected: !f.agent }, 'All agents'),
						agents.map((a) => h('option', { value: a, selected: f.agent === a }, who(a)))
					)
				: null
		);
	}

	function ask(n: NeedsYouItem) {
		const title = n.about ? itemLink(ctx, n.about, 'fw-item-link fw-ask-title') : null;
		return h(
			'li',
			{ class: `fw-ask${busy.has(n.id) ? ' is-busy' : ''}` },
			h(
				'span',
				{
					class: `fw-ask-kind fw-ask-${n.kind}`,
					title: n.kind === 'question' ? 'Question' : 'Decision'
				},
				n.kind === 'question' ? 'Q' : 'D'
			),
			h(
				'span',
				{ class: 'fw-ask-text', title: n.prompt },
				title,
				title
					? h('span', { class: 'fw-ask-prompt' }, ` — ${n.prompt}`)
					: h('span', { class: 'fw-ask-title' }, n.prompt)
			),
			h('span', { class: 'fw-ask-at' }, ago(n.since)),
			h(
				'button',
				{
					type: 'button',
					class: 'fw-dismiss',
					title: 'Dismiss',
					'aria-label': `Dismiss: ${n.prompt}`,
					disabled: busy.has(n.id),
					on: { click: () => void dismiss([n]) }
				},
				icon('close')
			)
		);
	}

	function group(g: Group, first: boolean) {
		const s = g.key ? ctx.session(g.key) : null;
		const missing = g.key ? s === null : false;
		const nobody = !g.key;
		const name = `needs:${g.key}`;
		const isOpen = open.has(name) || (first && !open.has(`${name}:closed`));
		const setOpen = (on: boolean) => {
			on ? open.add(name) : open.delete(name);
			on ? open.delete(`${name}:closed`) : open.add(`${name}:closed`);
			draw();
		};
		const agent = agentOf(g.key);
		const full = open.has(`${name}:all`);
		const shown = full ? g.items : g.items.slice(0, ASKS);
		const title = nobody
			? 'No session'
			: missing
				? 'Session no longer available'
				: (s?.title ?? 'Session');
		const head = h(
			'div',
			{
				class: 'fw-group-head',
				role: 'button',
				tabindex: '0',
				'aria-expanded': isOpen ? 'true' : 'false',
				on: {
					click: () => setOpen(!isOpen),
					keydown: (e: Event) => {
						const k = (e as KeyboardEvent).key;
						if (k === 'Enter' || k === ' ') (e.preventDefault(), setOpen(!isOpen));
					}
				}
			},
			h('span', { class: `fw-group-chevron${isOpen ? ' is-open' : ''}` }, icon('chevron')),
			h(
				'span',
				{ class: 'fw-group-avatar', title: agent ? who(agent) : '' },
				agent ? who(agent).charAt(0) : '?'
			),
			missing || nobody
				? h('span', { class: 'fw-group-title' }, title)
				: h(
						'button',
						{
							type: 'button',
							class: `fw-group-title fw-group-open${s?.active ? ' is-active' : ''}`,
							title: `Open session: ${title}`,
							on: {
								click: (e: Event) => (e.stopPropagation(), ctx.openSession(g.key))
							}
						},
						title
					),
			agent ? h('span', { class: 'fw-group-agent' }, who(agent)) : null,
			isOpen
				? null
				: h('span', { class: 'fw-group-preview' }, g.items[0].about?.title ?? g.items[0].prompt),
			h(
				'span',
				{ class: 'fw-group-count', title: count(g.items.length, 'ask') },
				String(g.items.length)
			),
			h('span', { class: 'fw-group-at' }, ago(g.latest)),
			missing || nobody
				? h(
						'button',
						{
							type: 'button',
							class: 'fw-dismiss-all',
							on: {
								click: (e: Event) => (e.stopPropagation(), void dismiss(g.items))
							}
						},
						`Dismiss all ${g.items.length}`
					)
				: null
		);
		return h(
			'div',
			{ class: `fw-group${missing || nobody ? ' is-missing' : ''}${isOpen ? ' is-open' : ''}` },
			head,
			isOpen
				? h(
						'ul',
						{ class: 'fw-asks' },
						shown.map(ask),
						g.items.length > shown.length
							? h(
									'li',
									{ class: 'fw-ask-more' },
									h(
										'button',
										{ type: 'button', on: { click: () => toggle(`${name}:all`, true) } },
										`+${g.items.length - shown.length} more`
									)
								)
							: null
					)
				: null
		);
	}

	function draw() {
		const list = groups(visible());
		const showAll = open.has('needs:all-sessions');
		const shown = showAll ? list : list.slice(0, SESSIONS);
		const parts: (Node | null)[] = [
			filterBar(),
			list.length
				? h(
						'div',
						{ class: 'fw-groups' },
						shown.map((g, i) => group(g, i === 0))
					)
				: h('p', { class: 'fw-empty' }, 'Nothing here.'),
			list.length > shown.length
				? h(
						'button',
						{
							type: 'button',
							class: 'fw-groups-more',
							on: { click: () => toggle('needs:all-sessions', true) }
						},
						`Show ${count(list.length - shown.length, 'older session')}`
					)
				: null,
			root.dataset.error ? h('p', { class: 'fw-error', role: 'alert' }, root.dataset.error) : null
		];
		root.replaceChildren(...parts.filter((p): p is Node => p !== null));
		delete root.dataset.error;
	}

	// Home carries the newest asks; the rest load a page at a time, so the groups, counts and
	// filters cover every ask however many there are.
	async function loadRest(cursor: string | null) {
		const seen = new Set(all.map((n) => n.id));
		try {
			while (cursor && !c.signal.aborted) {
				const page = await ctx.read<{ items: NeedsYouItem[]; next: string | null }>({
					view: 'needs_you',
					cursor
				});
				for (const n of page.items ?? []) if (!seen.has(n.id)) (seen.add(n.id), all.push(n));
				cursor = page.next ?? null;
				if (cursor) draw();
			}
		} catch (error) {
			root.dataset.error = `Could not load every ask: ${(error as Error).message}`;
		}
		loading = false;
		if (!c.signal.aborted) draw();
	}

	draw();
	if (more.next) void loadRest(more.next);
	return root;
}
