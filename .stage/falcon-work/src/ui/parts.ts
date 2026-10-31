import type { Ctx } from './app.js';
import { h, icon, statusIcon, day, since, time, who, avatar, kicker } from './dom.js';

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

/**
 * One status per Task row: a single pill, with why (whom it waits on, what blocks it) as a quiet
 * second line under the title.
 */
export function taskStatus(t: any): { label: string; tone: string; detail: string | null } {
	const blockers: string[] = (t.blocked_by ?? []).filter((b: string) => !b.startsWith('waiting:'));
	if (t.status === 'waiting')
		return {
			label: 'waiting',
			tone: 'waiting',
			detail: [
				t.waiting_on ? `on ${who(t.waiting_on.ref)}` : null,
				t.follow_up_at ? `follow up ${day(t.follow_up_at)}` : null
			]
				.filter(Boolean)
				.join(' · ')
		};
	if ((t.status === 'open' || t.status === 'ready') && blockers.length)
		return { label: 'blocked', tone: 'waiting', detail: blockers.join(' · ') };
	return {
		label: t.status.replace('_', ' '),
		tone: t.status,
		detail: blockers.length ? blockers.join(' · ') : null
	};
}

export function taskRow(c: Ctx, t: any, opts: { place?: boolean } = {}) {
	const done = t.status === 'completed';
	const s = taskStatus(t);
	const sub = [opts.place && t.place ? t.place.title : null, done ? null : s.detail]
		.filter(Boolean)
		.join(' · ');
	return h(
		'div',
		{
			class: `fw-row fw-task${done ? ' is-done' : ''}`,
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
			sub ? h('span', { class: 'fw-row-sub', title: sub }, sub) : null
		),
		h(
			'div',
			{ class: 'fw-row-meta' },
			done ? null : h('span', { class: `fw-pill fw-pill-${s.tone}` }, s.label),
			t.agent && !done ? avatar(t.agent) : null,
			t.session && !done ? sessionChip(c, t.session) : null
		)
	);
}

export function warningRow(c: Ctx, w: any) {
	const target = w.object?.id && w.object.kind !== 'timeline' ? w.object : null;
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
		unfiled_work: 'Unfiled work',
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
			kicker('Decision'),
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
			kicker('Question'),
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

export function objectiveLink(c: Ctx, o: { id: string; title: string }) {
	return h(
		'a',
		{
			class: 'fw-link',
			href: c.href({ objective: o.id }),
			on: { click: (e: Event) => (e.preventDefault(), c.go({ objective: o.id })) }
		},
		o.title
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

const OUTCOME: Record<string, { label: string; glyph: string }> = {
	commit: { label: 'Commit', glyph: '◇' },
	push: { label: 'Push', glyph: '↑' },
	pr: { label: 'Pull request', glyph: '⇄' },
	release: { label: 'Release', glyph: '⬡' },
	deploy: { label: 'Deploy', glyph: '▸' },
	message: { label: 'Message', glyph: '✉' },
	file: { label: 'File', glyph: '▤' },
	config: { label: 'Config', glyph: '⚙' },
	change: { label: 'Change', glyph: '•' }
};

/** Paths read from the workspace or the home folder; long labels are clipped. */
function short(label: string) {
	const s = label.replace(/^.*\/\.openclaw\/workspace\//, '').replace(/^\/home\/[^/]+\//, '~/');
	return s.length > 60 ? s.slice(0, 59) + '…' : s;
}

/** One outcome as a chip: a kind glyph, then the commit (hash and message), file or target. */
function outcomeChip(o: { kind: string; label: string; ref?: string }) {
	const k = OUTCOME[o.kind] ?? { label: o.kind, glyph: '•' };
	return h(
		'span',
		{ class: `fw-chip fw-outcome`, title: `${k.label}: ${o.ref ?? o.label}` },
		h('span', { class: 'fw-outcome-glyph', 'aria-hidden': 'true' }, k.glyph),
		o.kind === 'commit' && o.ref
			? h('span', { class: 'fw-mono fw-strong' }, o.ref.slice(0, 7))
			: null,
		o.kind === 'config' ? h('span', { class: 'fw-muted' }, 'Config') : null,
		h(
			'span',
			{ class: o.kind === 'file' ? 'fw-mono' : '' },
			o.kind === 'commit' && o.ref ? `‘${short(o.label)}’` : short(o.label)
		)
	);
}

const dayLabel = (iso: string) => {
	const d = new Date(iso);
	const today = new Date();
	const y = new Date(today.getTime() - 864e5);
	return d.toDateString() === today.toDateString()
		? 'Today'
		: d.toDateString() === y.toDateString()
			? 'Yesterday'
			: day(iso);
};

/**
 * A timeline (spec §10, Timeline): one row per turn that changed something — its outcomes as
 * chips and its summary folded under "What happened" — newest first; turns without outcomes fold
 * into one line. With `showTask` (the Activity tab) each row names its Task and Project, rows are
 * grouped by day, and unfiled rows offer `file`.
 */
export function timeline(
	c: Ctx,
	entries: any[],
	opts: { showTask?: boolean; file?: (entry: any) => void } = {}
) {
	const when = (iso: string) =>
		h(
			'span',
			{ class: 'fw-mono fw-muted fw-tl-time', title: iso },
			opts.showTask ? time(iso) : `${day(iso)} ${time(iso)}`
		);
	const session = (key: string | null) => (key ? sessionChip(c, { key, from: 'own' }) : null);
	const rows: HTMLElement[] = [];
	let talk: any[] = [];
	const flush = () => {
		if (!talk.length) return;
		rows.push(
			h(
				'li',
				{ class: 'fw-tl fw-tl-talk' },
				when(talk[0].at),
				h(
					'div',
					{ class: 'fw-tl-main fw-tl-line' },
					h(
						'span',
						{ class: 'fw-muted' },
						`${talk.length} turn${talk.length > 1 ? 's' : ''} of discussion`
					),
					session(talk[0].session)
				)
			)
		);
		talk = [];
	};
	for (const e of entries) {
		if (!e.outcomes.length) {
			talk.push(e);
			continue;
		}
		flush();
		rows.push(
			h(
				'li',
				{ class: `fw-tl${e.task ? '' : ' fw-tl-unfiled'}` },
				when(e.at),
				h(
					'div',
					{ class: 'fw-tl-main' },
					opts.showTask || e.completed || e.recorded_by === 'agent' || !e.task
						? h(
								'div',
								{ class: 'fw-tl-line' },
								opts.showTask && e.task
									? [
											h(
												'button',
												{
													class: 'fw-chip fw-tl-task',
													type: 'button',
													on: { click: () => openPanel(c, e.task.id) }
												},
												e.task.title
											),
											e.task.place ? h('span', { class: 'fw-muted' }, `· ${e.task.place}`) : null
										]
									: null,
								!e.task ? h('span', { class: 'fw-pill fw-pill-warn' }, 'Unfiled') : null,
								e.completed ? h('span', { class: 'fw-pill fw-pill-done' }, '✓ Completed') : null,
								h('span', { class: 'fw-right' }),
								e.recorded_by === 'agent'
									? h('span', { class: 'fw-muted fw-tl-by' }, 'recorded by the agent')
									: null,
								!e.task && opts.file
									? h(
											'button',
											{ class: 'fw-link', type: 'button', on: { click: () => opts.file!(e) } },
											'File under a Task →'
										)
									: null
							)
						: null,
					h('div', { class: 'fw-tl-line' }, e.outcomes.map(outcomeChip)),
					e.summary || e.session
						? h(
								'details',
								{ class: 'fw-fold fw-tl-detail' },
								h('summary', null, ' What happened'),
								h(
									'div',
									{ class: 'fw-tl-line' },
									e.summary ? h('p', { class: 'fw-tl-summary' }, e.summary) : null,
									h('span', { class: 'fw-right' }),
									session(e.session)
								)
							)
						: null
				)
			)
		);
	}
	flush();
	return h('ol', { class: 'fw-timeline' }, rows);
}

/** The Activity tab's day groups: Today, Yesterday, then dates. */
export function byDay(entries: any[]): [string, any[]][] {
	const days = new Map<string, any[]>();
	for (const e of entries) {
		const k = dayLabel(e.at);
		days.set(k, [...(days.get(k) ?? []), e]);
	}
	return [...days];
}
