import type { Ctx } from './app.js';
import { h, icon, statusIcon, day, since, who, avatar } from './dom.js';

type SessionRef = { key: string; from: 'own' | 'project' | 'task' } | null;

/** A discussion-session chip; clicking opens the session (spec §9). */
export function sessionChip(c: Ctx, s: SessionRef, opts: { prefix?: string } = {}) {
	if (!s) return null;
	const title = c.sessionTitle(s.key);
	return h(
		'button',
		{
			class: `fw-chip fw-session${title ? '' : ' is-missing'}`,
			type: 'button',
			title: title ? `Open session: ${title}` : `Session not found: ${s.key}`,
			on: { click: (e: Event) => (e.stopPropagation(), c.openSession(s.key)) }
		},
		h('span', { class: 'fw-dot' }),
		opts.prefix ?? '',
		title ?? 'missing session',
		s.from !== 'own'
			? h('span', { class: 'fw-muted' }, ` (from ${s.from === 'project' ? 'Project' : 'its Task'})`)
			: null
	);
}

export const evidence = (sources: { ref: string; label?: string }[] | null | undefined) =>
	(sources ?? []).map((s) =>
		h('span', { class: 'fw-chip fw-mono', title: s.ref }, s.label ?? s.ref)
	);

/** Open the side panel for an object, keeping the current page. */
export const openPanel = (c: Ctx, id: string) => c.go({ ...c.params, panel: id });

export function taskRow(c: Ctx, t: any, opts: { place?: boolean; muted?: boolean } = {}) {
	return h(
		'div',
		{
			class: `fw-row fw-task${t.status === 'completed' ? ' is-done' : ''}`,
			'data-panel': t.id,
			role: 'button',
			tabindex: 0,
			on: {
				click: () => openPanel(c, t.id),
				keydown: (e: Event) => (e as KeyboardEvent).key === 'Enter' && openPanel(c, t.id)
			}
		},
		h('span', { class: `fw-status fw-status-${t.status}` }, statusIcon(t.status)),
		h(
			'div',
			{ class: 'fw-row-main' },
			h('span', { class: 'fw-row-title' }, t.title),
			opts.place && t.place ? h('span', { class: 'fw-row-sub' }, t.place.title) : null
		),
		h(
			'div',
			{ class: 'fw-row-meta' },
			t.status === 'waiting' && t.waiting_on
				? h(
						'span',
						{ class: 'fw-warn-text' },
						`waiting on ${who(t.waiting_on.ref)}${t.follow_up_at ? ` · follow up ${day(t.follow_up_at)}` : ''}`
					)
				: null,
			t.blocked_by?.length && t.status !== 'waiting'
				? h('span', { class: 'fw-warn-text', title: t.blocked_by.join('\n') }, t.blocked_by[0])
				: null,
			t.status === 'in_progress'
				? h('span', { class: 'fw-pill fw-pill-run' }, 'in progress')
				: null,
			t.status === 'open' || t.status === 'ready'
				? h('span', { class: 'fw-pill' }, t.status)
				: null,
			t.agent && t.status !== 'completed' ? avatar(t.agent) : null,
			t.session && t.status !== 'completed' ? sessionChip(c, t.session) : null
		)
	);
}

export function warningRow(c: Ctx, w: any) {
	const target = w.object?.id && w.object.kind !== 'activity' ? w.object : null;
	return h(
		'div',
		{
			class: 'fw-card fw-warning',
			role: target ? 'button' : undefined,
			on: target
				? {
						click: () =>
							target.kind === 'objective'
								? c.go({ objective: target.id })
								: target.kind === 'milestone'
									? null
									: openPanel(c, target.id)
					}
				: undefined
		},
		icon('warn'),
		h(
			'div',
			null,
			h(
				'div',
				null,
				h('strong', { class: 'fw-warn-text' }, labelFor(w.kind)),
				' · ',
				h('span', { class: 'fw-strong' }, w.title)
			),
			h('div', { class: 'fw-muted' }, readableDates(w.detail))
		)
	);
}

/** Warning details name exact timestamps for agents; people read them as dates. */
export const readableDates = (text: string) =>
	(text ?? '').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (iso) => day(iso));

const labelFor = (kind: string) =>
	({
		stalled_task: 'Stalled Task',
		follow_up_overdue: 'Follow-up overdue',
		unanswered: 'Unanswered',
		objective_without_progress: 'Objective without progress',
		untracked_activity: 'Untracked activity',
		milestone_ready: 'Milestone ready',
		session_mismatch: 'Session mismatch'
	})[kind] ?? kind;

/** A Decision you can decide: clicking an option selects it; Decide commits (spec §7). */
export function decisionCard(c: Ctx, d: any) {
	let chosen: string | null = null;
	const why = h('input', {
		class: 'fw-input',
		type: 'text',
		placeholder: 'Why? (optional)',
		'aria-label': 'Why'
	});
	const decide = h('button', { class: 'fw-btn fw-btn-primary', type: 'button' }, 'Decide');
	const row = h('div', { class: 'fw-decide-row', hidden: true }, why, decide);
	const status = h('p', { class: 'fw-error-text', role: 'status' });
	const options = d.options.map((o: any) => {
		const b = h(
			'button',
			{ class: 'fw-option', type: 'button', 'aria-pressed': 'false', title: o.summary ?? '' },
			o.label,
			o.id === d.recommendation?.option ? h('span', { class: 'fw-muted' }, ' (recommended)') : null
		);
		b.addEventListener('click', () => {
			chosen = o.id;
			for (const x of options) x.setAttribute('aria-pressed', String(x === b));
			row.hidden = false;
		});
		return b;
	});
	decide.addEventListener('click', async () => {
		if (!chosen) return;
		decide.disabled = true;
		try {
			await c.act(
				'decide',
				d.id,
				{ option: chosen, ...(why.value.trim() ? { rationale: why.value.trim() } : {}) },
				d.version
			);
		} catch (e) {
			status.textContent = (e as Error).message;
			decide.disabled = false;
		}
	});
	return h(
		'div',
		{ class: 'fw-card fw-decision' },
		h(
			'div',
			{ class: 'fw-card-head' },
			icon('decision'),
			h('strong', { class: 'fw-strong' }, d.prompt)
		),
		d.recommendation?.rationale ? h('p', { class: 'fw-muted' }, d.recommendation.rationale) : null,
		d.can_decide
			? h('div', { class: 'fw-options' }, options)
			: h('p', { class: 'fw-muted' }, 'Waiting on its deciders.'),
		d.can_decide ? row : null,
		status,
		h(
			'div',
			{ class: 'fw-card-foot' },
			`Raised ${day(d.created_at)} · open ${since(d.created_at)}`,
			sessionChip(c, d.session),
			h('span', { class: 'fw-muted' }, `If nobody decides: ${d.consequence_of_no_decision}`)
		)
	);
}

/** A Question you can answer in place, or answer by accepting the agent's hypothesis. */
export function questionCard(c: Ctx, q: any) {
	const field = h('input', {
		class: 'fw-input',
		type: 'text',
		placeholder: q.hypothesis ? 'Or type a different answer…' : 'Type an answer…',
		'aria-label': 'Answer'
	});
	const status = h('p', { class: 'fw-error-text', role: 'status' });
	const run = async (command: string, input: Record<string, unknown>) => {
		try {
			await c.act(command, q.id, input, q.version);
		} catch (e) {
			status.textContent = (e as Error).message;
		}
	};
	const answer = h(
		'button',
		{
			class: 'fw-btn',
			type: 'button',
			on: { click: () => field.value.trim() && run('answer', { answer: field.value.trim() }) }
		},
		'Answer'
	);
	field.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && answer.click());
	return h(
		'div',
		{ class: 'fw-card fw-question' },
		h(
			'div',
			{ class: 'fw-card-head' },
			icon('question'),
			h('strong', { class: 'fw-strong' }, q.prompt),
			h(
				'span',
				{ class: 'fw-muted fw-right' },
				`Open since ${day(q.created_at)}${q.holds ? ` · holds ${q.holds} Task${q.holds > 1 ? 's' : ''}` : ''}`
			)
		),
		q.hypothesis
			? h(
					'p',
					{ class: 'fw-muted' },
					`${who(q.hypothesis_by)}'s hypothesis: `,
					h('span', { class: 'fw-mono' }, q.hypothesis),
					' ',
					sessionChip(c, q.session)
				)
			: null,
		q.can_answer
			? h(
					'div',
					{ class: 'fw-answer-row' },
					q.hypothesis
						? h(
								'button',
								{
									class: 'fw-btn',
									type: 'button',
									on: { click: () => run('accept_hypothesis', {}) }
								},
								`Use ${who(q.hypothesis_by)}'s hypothesis`
							)
						: null,
					field,
					answer,
					q.session
						? h(
								'button',
								{
									class: 'fw-link',
									type: 'button',
									on: { click: () => c.openSession(q.session.key) }
								},
								'Discuss in session'
							)
						: null
				)
			: null,
		status
	);
}

export function objectiveLink(c: Ctx, o: { id: string; rank?: number | null; title: string }) {
	return h(
		'a',
		{
			class: 'fw-link',
			href: c.href({ objective: o.id }),
			on: { click: (e: Event) => (e.preventDefault(), c.go({ objective: o.id })) }
		},
		`${o.rank ? `#${o.rank} ` : ''}${o.title}`
	);
}

export function kpiBar(k: any) {
	const latest = k.latest ?? k.readings?.at(-1) ?? null;
	const pct = latest && k.target ? Math.max(0, Math.min(100, (latest.value / k.target) * 100)) : 0;
	return h(
		'div',
		{ class: 'fw-kpi' },
		h(
			'div',
			{ class: 'fw-kpi-head' },
			h('span', null, k.name),
			h(
				'span',
				{ class: 'fw-mono' },
				latest ? `${latest.value} / ${k.target} ${k.unit}` : `unmeasured / ${k.target} ${k.unit}`
			)
		),
		h(
			'div',
			{
				class: 'fw-bar',
				role: 'meter',
				'aria-valuenow': latest?.value ?? 0,
				'aria-valuemax': k.target
			},
			h('span', { class: 'fw-bar-fill', style: `width:${pct}%` })
		)
	);
}
