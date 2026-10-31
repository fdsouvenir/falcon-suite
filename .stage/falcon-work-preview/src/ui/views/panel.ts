import type { Ctx } from '../app.js';
import { h, day, since, who, avatar, icon } from '../dom.js';
import { sessionChip, evidence, openPanel, timeline } from '../parts.js';

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
		return h(
			'aside',
			{ class: 'fw-panel', 'aria-label': 'Decision' },
			head('Decision'),
			...decision(c, d, close)
		);
	if (d.kind === 'question')
		return h(
			'aside',
			{ class: 'fw-panel', 'aria-label': 'Question' },
			head('Question'),
			...question(c, d, close)
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
		d.recorded_by_work
			? h(
					'p',
					{ class: 'fw-muted' },
					`Opened by Work${d.origin?.session ? ` from ${c.sessionTitle(d.origin.session) ?? 'a session'}` : ''}${d.origin?.at ? ` · ${day(d.origin.at)}` : ''}`
				)
			: null,
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
		field(
			'Description',
			h('details', { class: 'fw-fold fw-clamp' }, h('summary', null, def.description))
		),
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
			'Timeline',
			d.timeline.length
				? h('div', { class: 'fw-card fw-card-flush' }, timeline(c, d.timeline))
				: h('p', { class: 'fw-muted' }, 'Nothing done on it yet.')
		),
		field(
			'Result',
			d.accepted_result
				? [h('p', null, d.accepted_result.content), evidence(d.accepted_result.sources)]
				: h('p', { class: 'fw-muted' }, 'No Result yet — Work writes it when the done-when is met.')
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

/** What a Decision or Question is for: links to its Tasks, Projects and Objectives. */
function forLinks(c: Ctx, items: { kind: string; id: string; title: string }[] = []) {
	if (!items.length) return null;
	return field(
		'For',
		items.map((x) =>
			h(
				'button',
				{
					class: 'fw-chip',
					type: 'button',
					on: {
						click: () =>
							x.kind === 'project'
								? c.go({ project: x.id })
								: x.kind === 'objective'
									? c.go({ objective: x.id })
									: openPanel(c, x.id)
					}
				},
				`${x.kind.charAt(0).toUpperCase() + x.kind.slice(1)}: ${x.title}`
			)
		)
	);
}

const raised = (by: string, at: string, open: boolean) =>
	h(
		'p',
		{ class: 'fw-muted' },
		`Raised by ${who(by)} · ${day(at)}${open ? ` · open ${since(at)}` : ''}`
	);

/** A Decision in full: options with their risks, the recommendation preselected, then Decide. */
function decision(c: Ctx, d: any, close: () => void) {
	const card = d.card;
	const open = card.status === 'pending' || card.status === 'deferred';
	const recommended = card.recommendation?.option ?? null;
	let chosen: string | null = open && card.can_decide ? recommended : (d.chosen_option ?? null);
	const status = h('p', { class: 'fw-error-text', role: 'status' });
	const why = h('input', {
		class: 'fw-input',
		type: 'text',
		placeholder: 'Why? (optional)',
		'aria-label': 'Why'
	});
	const decide = h(
		'button',
		{ class: 'fw-btn fw-btn-primary fw-btn-wide', type: 'button' },
		'Decide'
	);
	const editable = open && card.can_decide;
	const options = card.options.map((o: any) => {
		const el = h(
			editable ? 'button' : 'div',
			{
				class: 'fw-choice',
				...(editable ? { type: 'button', 'aria-pressed': String(o.id === chosen) } : {}),
				...(!editable && o.id === d.chosen_option ? { 'data-chosen': '' } : {})
			},
			h('span', { class: 'fw-radio', 'aria-hidden': 'true' }),
			h(
				'span',
				{ class: 'fw-choice-body' },
				h(
					'span',
					{ class: 'fw-choice-label' },
					o.label,
					o.id === recommended
						? h('span', { class: 'fw-pill fw-pill-accent' }, `${who(card.created_by)} recommends`)
						: null
				),
				o.summary ? h('span', { class: 'fw-muted' }, o.summary) : null,
				o.tradeoffs ? h('span', { class: 'fw-muted' }, `Tradeoff: ${o.tradeoffs}`) : null,
				o.risks ? h('span', { class: 'fw-muted' }, `Risk: ${o.risks}`) : null
			)
		);
		if (editable)
			el.addEventListener('click', () => {
				chosen = o.id;
				for (const x of options) x.setAttribute('aria-pressed', String(x === el));
			});
		return el;
	});
	decide.addEventListener('click', async () => {
		if (!chosen) return;
		decide.disabled = true;
		try {
			await c.act(
				'decide',
				card.id,
				{ option: chosen, ...(why.value.trim() ? { rationale: why.value.trim() } : {}) },
				card.version
			);
			close();
		} catch (e) {
			status.textContent = (e as Error).message;
			decide.disabled = false;
		}
	});
	const chosenLabel = card.options.find((o: any) => o.id === d.chosen_option)?.label;
	return [
		h('h2', { class: 'fw-panel-title' }, card.prompt),
		raised(card.created_by, card.created_at, open),
		field('Options', h('div', { class: 'fw-choices' }, options)),
		card.recommendation?.rationale
			? h(
					'p',
					{ class: 'fw-muted' },
					`${who(card.created_by)}'s reasoning: ${card.recommendation.rationale}`
				)
			: null,
		editable ? [why, decide, status] : null,
		open && !card.can_decide ? h('p', { class: 'fw-muted' }, 'Waiting on its deciders.') : null,
		!open && chosenLabel
			? h(
					'p',
					null,
					h('strong', null, `Decided: ${chosenLabel}`),
					h(
						'span',
						{ class: 'fw-muted' },
						` · ${who(d.decided_by)}${d.rationale ? ` · ${d.rationale}` : ''}`
					)
				)
			: null,
		open
			? h(
					'p',
					{ class: 'fw-muted fw-center' },
					`If nobody decides: ${card.consequence_of_no_decision}`
				)
			: null,
		forLinks(c, d.for),
		card.session ? field('Discussion', sessionChip(c, card.session)) : null
	];
}

/** A Question in full: why it matters, the agent's guess to accept, or your own answer. */
function question(c: Ctx, d: any, close: () => void) {
	const q = d.card;
	const open = d.status === 'open';
	const status = h('p', { class: 'fw-error-text', role: 'status' });
	const text = h('textarea', {
		class: 'fw-input fw-textarea',
		rows: 3,
		placeholder: q.hypothesis ? 'Or write a different answer…' : 'Your answer…',
		'aria-label': 'Answer'
	});
	const run = async (command: string, input: Record<string, unknown>) => {
		try {
			await c.act(command, q.id, input, q.version);
			close();
		} catch (e) {
			status.textContent = (e as Error).message;
		}
	};
	return [
		h('h2', { class: 'fw-panel-title' }, q.prompt),
		raised(q.created_by, q.created_at, open),
		field('Why it matters', h('p', null, q.impact)),
		q.hypothesis
			? field(
					`${who(q.hypothesis_by)}'s guess`,
					h('div', { class: 'fw-card' }, q.hypothesis),
					open && q.can_answer
						? h(
								'button',
								{
									class: 'fw-btn fw-btn-primary fw-btn-wide',
									type: 'button',
									on: { click: () => run('accept_hypothesis', {}) }
								},
								`Use ${who(q.hypothesis_by)}'s guess`
							)
						: null
				)
			: null,
		open && q.can_answer
			? field(
					q.hypothesis ? 'Or answer yourself' : 'Your answer',
					text,
					h(
						'button',
						{
							class: q.hypothesis ? 'fw-btn fw-btn-wide' : 'fw-btn fw-btn-primary fw-btn-wide',
							type: 'button',
							on: {
								click: () => text.value.trim() && run('answer', { answer: text.value.trim() })
							}
						},
						'Answer'
					),
					status
				)
			: null,
		d.answers?.length
			? field(
					'Answers',
					h(
						'ul',
						{ class: 'fw-history' },
						d.answers.map((a: any) => h('li', null, `${day(a.at)} · ${who(a.author)}: ${a.text}`))
					)
				)
			: null,
		forLinks(c, d.for),
		q.session ? field('Discussion', sessionChip(c, q.session)) : null
	];
}
