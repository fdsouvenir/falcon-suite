import type { Ctx } from '../app.js';
import { h, icon, ago, dayTime, dotted, who, count } from '../dom.js';
import {
	empty,
	happened,
	itemLink,
	kindChip,
	pageTitle,
	searchField,
	section,
	KIND
} from '../parts.js';
import type { Card, DoneRow, HomePage } from '../types.js';
import { needsBySession } from './needs.js';

/** Home (spec §6): Needs you, Everything in motion, What happened since the last visit. */
export async function homeView(c: Ctx) {
	const d = await c.read<HomePage>({
		view: 'home',
		...(c.lastVisit ? { since: c.lastVisit } : {})
	});
	const since = d.since ?? c.lastVisit;
	const moved = new Set(d.happened.map((e) => e.item?.id).filter(Boolean)).size;
	const { moving, waiting, done, totals, next } = d.board;
	const catching = d.catching_up && !d.catching_up.done ? d.catching_up : null;

	return h(
		'div',
		{ class: 'fw-home' },
		h(
			'header',
			{ class: 'fw-home-head' },
			h(
				'div',
				null,
				h('h1', { class: 'fw-title' }, pageTitle()),
				h(
					'p',
					{ class: 'fw-meta' },
					since
						? dotted(`Since you were here ${dayTime(since)}`, `${count(moved, 'effort')} moved`)
						: `${count(moving.length + waiting.length, 'effort')} in motion`
				)
			),
			searchField(c)
		),
		catching
			? h(
					'p',
					{ class: 'fw-banner', role: 'status' },
					`Catching up on your work: ${catching.read} of ${catching.total} sessions read`
				)
			: null,
		section(
			'Needs you',
			d.needs_you_total,
			{ dot: 'accent' },
			d.needs_you.length
				? needsBySession(c, d.needs_you, { total: d.needs_you_total, next: d.needs_you_next })
				: empty('Nothing needs you.')
		),
		section(
			'Everything in motion',
			null,
			{ dot: 'muted' },
			h(
				'div',
				{ class: 'fw-board' },
				column(
					c,
					'moving',
					'Moving',
					totals.moving,
					moving,
					next.moving,
					(x) => card(c, x as Card),
					'Nothing moving.'
				),
				column(
					c,
					'waiting',
					'Waiting',
					totals.waiting,
					waiting,
					next.waiting,
					(x) => card(c, x as Card),
					'Nothing waiting.'
				),
				column(
					c,
					'done',
					'Done this week',
					totals.done,
					done,
					next.done,
					(x) => doneRow(c, x as DoneRow),
					'Nothing finished this week.'
				)
			)
		),
		section(
			since ? `What happened since your last visit (${dayTime(since)})` : 'What happened recently',
			null,
			{ dot: 'muted' },
			d.happened.some((e) => e.summary)
				? happened(c, d.happened)
				: empty(since ? 'Nothing new since then.' : 'Nothing recorded yet.')
		)
	);
}

/**
 * A board column: its first page, with "Show N more" loading the next page of that column when
 * there are more than Home carries.
 */
function column<T>(
	c: Ctx,
	name: 'moving' | 'waiting' | 'done',
	title: string,
	total: number,
	first: T[],
	next: string | null,
	draw: (x: T) => Node,
	none: string
) {
	const body = h('div', { class: 'fw-column-body' }, first.length ? first.map(draw) : empty(none));
	let shown = first.length;
	let cursor = next;
	const more = h('button', { type: 'button', class: 'fw-column-more' }) as HTMLButtonElement;
	const label = () => {
		more.textContent = `Show more (${total - shown})`;
		more.hidden = !cursor;
	};
	more.addEventListener('click', async () => {
		if (!cursor) return;
		more.disabled = true;
		try {
			const page = await c.read<{ items: T[]; next: string | null }>({
				view: 'board',
				column: name,
				cursor
			});
			body.append(...page.items.map(draw));
			shown += page.items.length;
			cursor = page.next;
		} catch (error) {
			more.title = (error as Error).message;
		}
		more.disabled = false;
		label();
	});
	label();
	return h(
		'div',
		{ class: 'fw-column' },
		h(
			'h3',
			{ class: 'fw-column-title' },
			title,
			h('span', { class: 'fw-column-count' }, String(total))
		),
		body,
		more
	);
}

function card(c: Ctx, x: Card) {
	const t = x.tasks;
	const pct = t && t.total ? Math.round((t.done / t.total) * 100) : 0;
	return h(
		'article',
		{ class: 'fw-card' },
		h('div', { class: 'fw-card-kind' }, kindChip(x.kind)),
		h('h4', { class: 'fw-card-title' }, itemLink(c, x)),
		x.status_line ? h('p', { class: 'fw-card-line' }, x.status_line) : null,
		x.kind === 'project' && t && t.total
			? h(
					'div',
					{ class: 'fw-progress' },
					h(
						'div',
						{
							class: 'fw-bar',
							role: 'progressbar',
							'aria-valuenow': t.done,
							'aria-valuemax': t.total,
							'aria-label': 'Tasks done'
						},
						h('span', { class: 'fw-bar-fill', style: `width:${pct}%` })
					),
					h('span', { class: 'fw-progress-text' }, `${t.done} of ${t.total} tasks`)
				)
			: null,
		x.kind === 'project' && x.milestone
			? h(
					'p',
					{ class: 'fw-card-sub' },
					dotted(`Milestone ${x.milestone.position} of ${x.milestone.of}`, x.milestone.title)
				)
			: null,
		x.kind === 'job' && t
			? h(
					'p',
					{ class: 'fw-card-sub' },
					dotted(`${t.open} open`, `${x.done_this_week ?? 0} done this week`)
				)
			: null,
		x.waiting ? h('p', { class: 'fw-waiting' }, x.waiting) : null,
		h(
			'p',
			{ class: 'fw-card-foot' },
			dotted(count(x.sessions, 'session'), ago(x.last_activity), who(x.agent, c.owner))
		)
	);
}

const doneRow = (c: Ctx, x: DoneRow) =>
	h(
		'article',
		{ class: 'fw-done-row' },
		h('span', { class: 'fw-done-check' }, icon('check')),
		h(
			'div',
			null,
			h('h4', { class: 'fw-card-title' }, itemLink(c, x)),
			h('p', { class: 'fw-card-sub' }, dotted(KIND[x.kind], ago(x.at)))
		)
	);
