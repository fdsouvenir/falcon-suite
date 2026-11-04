import type { Ctx } from '../app.js';
import { h, icon, ago, dayTime, dotted, who, count } from '../dom.js';
import {
	empty,
	happened,
	itemLink,
	kindChip,
	needsYou,
	pageTitle,
	searchField,
	section,
	KIND
} from '../parts.js';
import type { Card, DoneRow, HomePage } from '../types.js';

/** Home (spec §6): Needs you, Everything in motion, What happened since the last visit. */
export async function homeView(c: Ctx) {
	const d = await c.read<HomePage>({
		view: 'home',
		...(c.lastVisit ? { since: c.lastVisit } : {})
	});
	const since = d.since ?? c.lastVisit;
	const moved = new Set(d.happened.map((e) => e.item?.id).filter(Boolean)).size;
	const { moving, waiting, done } = d.board;
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
			d.needs_you.length,
			{ dot: 'accent' },
			d.needs_you.length ? needsYou(c, d.needs_you) : empty('Nothing needs you.')
		),
		section(
			'Everything in motion',
			null,
			{ dot: 'muted' },
			h(
				'div',
				{ class: 'fw-board' },
				column(
					'Moving',
					moving.length,
					moving.length ? moving.map((x) => card(c, x)) : empty('Nothing moving.')
				),
				column(
					'Waiting',
					waiting.length,
					waiting.length ? waiting.map((x) => card(c, x)) : empty('Nothing waiting.')
				),
				column(
					'Done this week',
					done.length,
					done.length ? done.map((x) => doneRow(c, x)) : empty('Nothing finished this week.')
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

const column = (title: string, n: number, body: Node | Node[]) =>
	h(
		'div',
		{ class: 'fw-column' },
		h(
			'h3',
			{ class: 'fw-column-title' },
			title,
			h('span', { class: 'fw-column-count' }, String(n))
		),
		h('div', { class: 'fw-column-body' }, body)
	);

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
