import type { Ctx } from '../app.js';
import { h, section, empty, day, since, who, icon, statusIcon } from '../dom.js';
import { objectiveLink, kpiBar, openPanel, readableDates } from '../parts.js';

/** Days since an ISO time, for ages that turn to warnings. */
const daysSince = (iso?: string | null) =>
	iso ? Math.floor((Date.now() - Date.parse(iso)) / 864e5) : 0;
const OLD_DAYS = 7;

/**
 * The Overview: a calm page. Needs you lists only what the person can act on, one line each;
 * acting happens in the side panel. Happening now is the agents' work, Heads up the quiet rest.
 */
export async function overviewView(c: Ctx, setCount: (n: number) => void) {
	const v = await c.read({ view: 'overview' });
	const n = v.needs_you;
	setCount(n.count);

	const main = h(
		'div',
		{ class: 'fw-col-main' },
		h('p', { class: 'fw-summary' }, summary(v)),
		section(
			'Needs you',
			n.count,
			n.count
				? h(
						'div',
						{ class: 'fw-list fw-needs' },
						group(
							'Decide',
							n.decisions.map((d: any) => {
								const rec = d.options.find((o: any) => o.id === d.recommendation?.option);
								return needRow(c, {
									id: d.id,
									icon: icon('decision'),
									text: d.prompt,
									context: rec ? `${who(d.created_by)} recommends: ${rec.label}` : null,
									age: age(d.created_at)
								});
							})
						),
						group(
							'Answer',
							n.questions.map((q: any) =>
								needRow(c, {
									id: q.id,
									icon: icon('question'),
									text: q.prompt,
									context: q.hypothesis
										? `${who(q.hypothesis_by)}'s guess: ${q.hypothesis}`
										: q.impact,
									age: age(q.created_at)
								})
							)
						),
						group(
							'Do',
							n.todo.map((t: any) =>
								needRow(c, {
									id: t.id,
									icon: icon('check'),
									text: t.title,
									context: t.agent ? `${who(t.agent)} is waiting on you` : null,
									age:
										t.follow_up_at && daysSince(t.follow_up_at) > 0
											? { text: `${since(t.follow_up_at)} overdue`, old: true }
											: age(t.since)
								})
							)
						)
					)
				: empty('Nothing needs you right now.')
		),
		section(
			'Happening now',
			null,
			v.happening.length
				? h(
						'div',
						{ class: 'fw-list' },
						v.happening.map((t: any) => happeningRow(c, t))
					)
				: empty('No agent is working on anything right now.')
		),
		v.heads_up.length
			? section(
					'Heads up',
					null,
					h(
						'ul',
						{ class: 'fw-heads-up' },
						v.heads_up.map((w: any) => headsUpItem(c, w))
					)
				)
			: null
	);

	const side = h(
		'div',
		{ class: 'fw-col-side' },
		section(
			'Objectives',
			null,
			v.objectives.length
				? h(
						'div',
						{ class: 'fw-objectives-slim' },
						v.objectives.map((o: any) =>
							h(
								'div',
								{ class: 'fw-objective-slim' },
								h(
									'div',
									{ class: 'fw-card-head' },
									objectiveLink(c, o),
									h('span', { class: 'fw-pill' }, o.autonomy)
								),
								o.kpis[0] ? kpiBar(o.kpis[0]) : null,
								h(
									'div',
									{ class: o.last_progress ? 'fw-muted' : 'fw-muted fw-warn-text' },
									o.last_progress ? `Last progress ${day(o.last_progress)}` : 'No progress yet'
								)
							)
						)
					)
				: empty('No Objectives yet. Add the things you want progress toward.')
		),
		section(
			'Recently completed',
			null,
			v.completed.length
				? h(
						'div',
						{ class: 'fw-done-list' },
						v.completed.map((t: any) =>
							h(
								'div',
								{
									class: 'fw-done-row',
									role: 'button',
									tabindex: 0,
									on: { click: () => openPanel(c, t.id) }
								},
								h('span', { class: 'fw-status fw-status-completed' }, icon('check')),
								h('span', { class: 'fw-done-title' }, t.title),
								h('span', { class: 'fw-mono fw-muted' }, day(t.updated_at))
							)
						),
						h(
							'a',
							{
								class: 'fw-link fw-block',
								href: c.href({ tab: 'activity' }),
								on: {
									click: (e: Event) => (e.preventDefault(), c.go({ tab: 'activity' }))
								}
							},
							'See all in Activity'
						)
					)
				: empty('Nothing completed yet.')
		)
	);
	return h('div', { class: 'fw-columns' }, main, side);
}

function summary(v: any) {
	const s = v.summary;
	const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	const asks = [
		s.decide ? count(s.decide, 'decision', 'decisions') : null,
		s.answer ? count(s.answer, 'question', 'questions') : null
	].filter(Boolean);
	const parts: string[] = [];
	if (asks.length) parts.push(`${asks.join(' and ')} for you`);
	if (s.todo) parts.push(`${count(s.todo, 'thing', 'things')} to do`);
	const first = parts.length ? `${parts.join(', ')}.` : 'Nothing needs you.';
	const agents = [
		...new Set(
			v.happening
				.filter((t: any) => t.status === 'in_progress')
				.map((t: any) => who(t.agent) as string)
		)
	];
	const working = s.in_progress
		? ` ${agents.length === 1 ? `${agents[0]} is` : 'Agents are'} working on ${count(s.in_progress, 'Task', 'Tasks')}.`
		: '';
	return first.charAt(0).toUpperCase() + first.slice(1) + working;
}

const age = (iso: string) => ({ text: since(iso), old: daysSince(iso) >= OLD_DAYS });

function group(label: string, rows: HTMLElement[]) {
	if (!rows.length) return null;
	return [h('div', { class: 'fw-group-label' }, label), ...rows];
}

function needRow(
	c: Ctx,
	r: {
		id: string;
		icon: HTMLElement;
		text: string;
		context: string | null;
		age: { text: string; old: boolean };
	}
) {
	return h(
		'div',
		{
			class: 'fw-row fw-line',
			'data-panel': r.id,
			role: 'button',
			tabindex: 0,
			on: {
				click: () => openPanel(c, r.id),
				keydown: (e: Event) => (e as KeyboardEvent).key === 'Enter' && openPanel(c, r.id)
			}
		},
		r.icon,
		h(
			'span',
			{ class: 'fw-line-text' },
			h('span', { class: 'fw-line-title' }, r.text),
			r.context ? h('span', { class: 'fw-muted' }, ` · ${r.context}`) : null
		),
		h('span', { class: `fw-mono fw-age${r.age.old ? ' fw-warn-text' : ' fw-muted'}` }, r.age.text),
		h('span', { class: 'fw-chevron', 'aria-hidden': 'true' }, '›')
	);
}

function happeningRow(c: Ctx, t: any) {
	const status =
		t.status === 'in_progress'
			? h('span', { class: 'fw-run-text' }, `in progress · ${who(t.agent)}`)
			: t.status === 'waiting'
				? t.waiting_on_you
					? h('span', { class: 'fw-warn-text' }, `waiting on your ${t.waiting_on_you}`)
					: h(
							'span',
							{ class: 'fw-muted' },
							`waiting on ${who(t.waiting_on?.ref)}${t.follow_up_at ? ` · follow up ${day(t.follow_up_at)}` : ''}`
						)
				: h(
						'span',
						{ class: 'fw-muted' },
						`ready${t.blocked_by?.length ? ` · ${t.blocked_by[0]}` : ''}`
					);
	return h(
		'div',
		{
			class: 'fw-row fw-line',
			'data-panel': t.id,
			role: 'button',
			tabindex: 0,
			on: { click: () => openPanel(c, t.id) }
		},
		h('span', { class: `fw-status fw-status-${t.status}` }, statusIcon(t.status)),
		h(
			'span',
			{ class: 'fw-line-text' },
			h('span', { class: 'fw-line-title' }, t.title),
			t.place ? h('span', { class: 'fw-muted' }, ` · ${t.place.title}`) : null
		),
		h('span', { class: 'fw-line-status' }, status)
	);
}

function headsUpItem(c: Ctx, w: any) {
	const o = w.object;
	const text =
		w.kind === 'untracked_activity' ? w.detail : `${w.title}: ${readableDates(w.detail)}`;
	const go =
		w.kind === 'untracked_activity'
			? () => c.go({ tab: 'activity', feed: 'untracked' })
			: o?.kind === 'objective'
				? () => c.go({ objective: o.id })
				: o?.kind === 'task'
					? () => openPanel(c, o.id)
					: null;
	return h(
		'li',
		null,
		h('span', { class: 'fw-dot-warn', 'aria-hidden': 'true' }),
		h(
			'span',
			null,
			text,
			go
				? [
						' · ',
						h(
							'button',
							{ class: 'fw-link', type: 'button', on: { click: go } },
							w.kind === 'untracked_activity' ? 'Review' : 'Open'
						)
					]
				: null
		)
	);
}
