import type { Ctx } from '../app.js';
import { h, day, who, avatar, icon } from '../dom.js';
import { sessionChip, evidence, openPanel, decisionCard, questionCard } from '../parts.js';

/** The side panel for a Task, Question, Decision or Finding, over the current page. */
export async function panelView(c: Ctx, id: string) {
	const d = await c.read({ view: 'panel', id });
	const close = () => c.go({ ...c.params, panel: undefined });
	const head = (kind: string) =>
		h(
			'div',
			{ class: 'fw-panel-head' },
			h('span', { class: 'fw-pill' }, kind),
			h('span', { class: 'fw-right' }),
			h(
				'button',
				{ class: 'fw-icon-btn', type: 'button', 'aria-label': 'Close', on: { click: close } },
				icon('x')
			)
		);
	if (d.error)
		return h(
			'aside',
			{ class: 'fw-panel' },
			head('Not found'),
			h('p', { class: 'fw-muted' }, 'It no longer exists.')
		);
	if (d.kind === 'decision')
		return h('aside', { class: 'fw-panel' }, head('Decision'), decisionCard(c, d.card));
	if (d.kind === 'question')
		return h(
			'aside',
			{ class: 'fw-panel' },
			head('Question'),
			questionCard(c, d.card),
			d.answers?.length
				? field(
						'Answers',
						h(
							'ul',
							{ class: 'fw-history' },
							d.answers.map((a: any) => h('li', null, `${day(a.at)} · ${who(a.author)}: ${a.text}`))
						)
					)
				: null
		);
	if (d.kind === 'finding')
		return h(
			'aside',
			{ class: 'fw-panel' },
			head('Finding'),
			h('p', null, d.conclusion),
			field('Evidence', evidence(d.sources))
		);
	if (d.kind !== 'task')
		return h('aside', { class: 'fw-panel' }, head(d.kind), h('p', null, d.title ?? d.prompt ?? ''));

	const t = d.card;
	const def = d.definition;
	return h(
		'aside',
		{ class: 'fw-panel', 'aria-label': 'Task' },
		head('Task'),
		h('h2', { class: 'fw-panel-title' }, def.title),
		h('span', { class: `fw-pill fw-pill-${t.status}` }, t.status.replace('_', ' ')),
		h(
			'div',
			{ class: 'fw-card fw-meta-box' },
			h(
				'div',
				null,
				'Agent: ',
				t.agent
					? [avatar(t.agent), ` ${who(t.agent)}`]
					: h('span', { class: 'fw-muted' }, 'unassigned')
			),
			d.milestone
				? h('div', null, `Milestone ${d.milestone.position}: ${d.milestone.title}`)
				: h(
						'div',
						null,
						t.place.kind === 'area' ? `Area: ${t.place.title}` : `Project: ${t.place.title}`
					)
		),
		t.session
			? field(
					'Session',
					h(
						'div',
						{ class: 'fw-card' },
						sessionChip(c, t.session),
						' ',
						h(
							'button',
							{
								class: 'fw-link',
								type: 'button',
								on: { click: () => c.openSession(t.session.key) }
							},
							'Open session'
						)
					)
				)
			: null,
		t.status === 'waiting'
			? field(
					'Waiting',
					h(
						'p',
						null,
						t.waiting_for,
						h('br'),
						h(
							'span',
							{ class: 'fw-muted' },
							`on ${who(t.waiting_on?.ref)} · resume when ${t.resume_when}`
						)
					)
				)
			: null,
		field('Done when', h('div', { class: 'fw-card' }, def.done_when)),
		field('Description', h('p', null, def.description)),
		d.depends_on.length
			? field(
					'Depends on',
					d.depends_on.map((x: any) => link(c, x))
				)
			: null,
		d.needed_by.length
			? field(
					'Needed by',
					d.needed_by.map((x: any) => link(c, x))
				)
			: null,
		t.blocked_by.length
			? field(
					'Blocked by',
					h(
						'ul',
						{ class: 'fw-plain' },
						t.blocked_by.map((b: string) => h('li', { class: 'fw-warn-text' }, b))
					)
				)
			: null,
		field(
			'Activity (captured automatically)',
			d.activity.length
				? h(
						'ul',
						{ class: 'fw-history' },
						d.activity
							.slice(0, 10)
							.map((a: any) => h('li', null, `${day(a.at)} · ${a.kind} · ${a.summary}`))
					)
				: h('p', { class: 'fw-muted' }, 'Nothing captured yet.')
		),
		field(
			'Result',
			d.accepted_result
				? [h('p', null, d.accepted_result.content), evidence(d.accepted_result.sources)]
				: h('p', { class: 'fw-muted' }, 'No Result recorded yet.')
		),
		d.definitions.length > 1
			? field(
					'Definition history',
					h(
						'ul',
						{ class: 'fw-history' },
						d.definitions
							.slice(0, -1)
							.reverse()
							.map((r: any) =>
								h('li', null, `rev ${r.rev} · ${day(r.at)}${r.reason ? ` · ${r.reason}` : ''}`)
							)
					)
				)
			: null
	);
}

const field = (label: string, ...body: unknown[]) =>
	h('div', { class: 'fw-field' }, h('h3', { class: 'fw-field-label' }, label), ...(body as any[]));
const link = (c: Ctx, x: { id: string; title: string }) =>
	h(
		'button',
		{ class: 'fw-link fw-block', type: 'button', on: { click: () => openPanel(c, x.id) } },
		icon('arrow'),
		' ',
		x.title
	);
