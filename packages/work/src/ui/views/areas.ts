import type { Ctx } from '../app.js';
import { h, section, empty, day, who, avatar, icon, kicker } from '../dom.js';
import {
	sessionChip,
	taskRow,
	evidence,
	objectiveLink,
	decisionCard,
	questionCard,
	openPanel
} from '../parts.js';
import { breadcrumb } from './objectives.js';

/** Areas & Projects: Area chips (never a second sidebar) and Projects grouped by Area. */
export async function areasView(c: Ctx) {
	const selected = c.params.area;
	const v = await c.read({ view: 'areas', filters: selected ? { area: selected } : {} });
	const q = (c.params.q ?? '').toLowerCase();
	const total = v.areas.length;
	const chips = h(
		'div',
		{ class: 'fw-chips', role: 'tablist', 'aria-label': 'Areas' },
		chip(c, 'All', total, !selected, { tab: 'areas' }),
		v.areas.map((a: any) =>
			chip(c, a.title, a.projects + a.open_tasks, selected === a.id, { tab: 'areas', area: a.id })
		)
	);
	const groups = v.groups.map((g: any) => {
		const projects = g.projects.filter(
			(p: any) =>
				!q ||
				p.title.toLowerCase().includes(q) ||
				p.milestones.some((m: any) => m.tasks.some((t: any) => t.title.toLowerCase().includes(q)))
		);
		const tasks = g.tasks.filter((t: any) => !q || t.title.toLowerCase().includes(q));
		if (q && !projects.length && !tasks.length) return null;
		return h(
			'section',
			{ class: 'fw-section' },
			h(
				'div',
				{ class: 'fw-area-line' },
				kicker('Area'),
				h('h2', { class: 'fw-area-title' }, g.area.title),
				h('span', { class: 'fw-muted' }, g.area.description),
				h(
					'span',
					{ class: 'fw-muted' },
					'Accountable: ',
					avatar(g.area.accountable_human),
					' ',
					who(g.area.accountable_human)
				)
			),
			projects.map((p: any) => projectCard(c, p)),
			tasks.length
				? h(
						'div',
						{ class: 'fw-card' },
						h('h3', { class: 'fw-card-title' }, 'Tasks'),
						h(
							'div',
							{ class: 'fw-list' },
							tasks.map((t: any) => taskRow(c, t))
						)
					)
				: null,
			!projects.length && !tasks.length ? empty('Nothing in this Area yet.') : null
		);
	});
	return h(
		'div',
		null,
		chips,
		groups.some(Boolean)
			? groups
			: empty(
					q
						? `Nothing matches "${c.params.q}".`
						: 'No Areas yet. Add the standing responsibilities your agents look after.'
				)
	);
}

function chip(
	c: Ctx,
	label: string,
	count: number,
	active: boolean,
	params: Record<string, string>
) {
	return h(
		'a',
		{
			class: `fw-chip fw-area-chip${active ? ' is-active' : ''}`,
			role: 'tab',
			'aria-selected': String(active),
			href: c.href(params),
			on: { click: (e: Event) => (e.preventDefault(), c.go(params)) }
		},
		label,
		h('span', { class: 'fw-muted' }, ` ${count}`)
	);
}

export function milestoneBlock(c: Ctx, m: any, guard: boolean) {
	const achieved = m.status === 'achieved';
	const open = m.tasks.filter((t: any) => !['completed', 'abandoned'].includes(t.status)).length;
	return h(
		'li',
		{ class: `fw-milestone${achieved ? ' is-achieved' : ''}` },
		h(
			'div',
			{ class: 'fw-milestone-head' },
			achieved ? icon('check') : icon('circle'),
			h('span', { class: 'fw-strong' }, `Milestone ${m.position}: ${m.title}`),
			h(
				'span',
				{ class: 'fw-muted' },
				achieved
					? `achieved ${day(m.achieved_at)}`
					: `open · ${m.tasks_done} of ${m.tasks_total} Tasks done`
			),
			guard && !achieved ? achieveButton(c, m, open) : null
		),
		guard
			? h('p', { class: 'fw-muted fw-indent' }, 'Success condition: ', m.success_condition)
			: null,
		guard && achieved && m.basis
			? h(
					'p',
					{ class: 'fw-indent' },
					h('span', { class: 'fw-muted' }, 'Basis: '),
					m.basis,
					' ',
					evidence(m.sources)
				)
			: null,
		m.decisions?.length
			? h(
					'ul',
					{ class: 'fw-indent fw-plain' },
					m.decisions.map((d: any) =>
						h(
							'li',
							{ class: 'fw-muted' },
							icon('decision'),
							` ${d.prompt} → ${d.options.find((o: any) => o.id === d.chosen)?.label ?? ''}`
						)
					)
				)
			: null,
		m.tasks.length
			? h(
					'div',
					{ class: 'fw-list fw-indent' },
					m.tasks.map((t: any) => taskRow(c, t))
				)
			: null
	);
}

/** Mark achieved: disabled with the reason while the closure rule holds (spec §5). */
function achieveButton(c: Ctx, m: any, open: number) {
	const b = h(
		'button',
		{
			class: 'fw-btn fw-right',
			type: 'button',
			disabled: open > 0 || m.tasks_total === 0,
			title: open ? `${open} Task${open > 1 ? 's' : ''} still open` : ''
		},
		'Mark achieved'
	);
	b.addEventListener('click', async () => {
		const basis = prompt(`Why is "${m.title}" achieved?`);
		if (!basis) return;
		const ref = prompt('Evidence (a link, commit, or reference)');
		if (!ref) return;
		await c
			.act('achieve_milestone', m.id, { basis, sources: [{ ref }] })
			.catch((e) => alert((e as Error).message));
	});
	return [
		open > 0
			? h('span', { class: 'fw-muted fw-right' }, `${open} Task${open > 1 ? 's' : ''} still open`)
			: null,
		b
	];
}

/** A Project with its Milestones and their Tasks; on an Objective page it names its Area instead. */
export function projectCard(c: Ctx, p: any, opts: { area?: string } = {}) {
	return h(
		'article',
		{ class: `fw-card fw-project${p.status === 'abandoned' ? ' is-abandoned' : ''}` },
		h(
			'div',
			{ class: 'fw-card-head' },
			kicker('Project'),
			h(
				'a',
				{
					class: 'fw-project-title',
					href: c.href({ project: p.id }),
					on: { click: (e: Event) => (e.preventDefault(), c.go({ project: p.id })) }
				},
				p.title,
				' ›'
			),
			h('span', { class: 'fw-pill' }, p.status),
			opts.area !== undefined
				? h('span', { class: 'fw-pill' }, `Area: ${opts.area}`)
				: p.serves.map((o: any) => h('span', { class: 'fw-pill' }, `Serves: ${o.title}`)),
			h('span', { class: 'fw-right' }, sessionChip(c, p.session))
		),
		h('p', { class: 'fw-muted' }, p.outcome),
		p.milestones.length
			? h(
					'ol',
					{ class: 'fw-milestones' },
					p.milestones.map((m: any) => milestoneBlock(c, m, false))
				)
			: null,
		p.tasks.length
			? [
					h('h3', { class: 'fw-card-title' }, p.milestones.length ? 'Other Tasks' : 'Tasks'),
					h(
						'div',
						{ class: 'fw-list' },
						p.tasks.map((t: any) => taskRow(c, t))
					)
				]
			: null,
		!p.milestones.length && !p.tasks.length ? empty('No Tasks yet.') : null,
		p.findings
			? h(
					'div',
					{ class: 'fw-card-foot fw-muted' },
					`${p.findings} Finding${p.findings > 1 ? 's' : ''}`
				)
			: null
	);
}

/** The Project page (spec §12, Navigation). */
export async function projectView(c: Ctx, id: string) {
	const p = await c.read({ view: 'project', id });
	if (p.error) return empty('This Project no longer exists.');
	const abandon = h(
		'button',
		{ class: 'fw-link', type: 'button' },
		p.status === 'abandoned' ? 'Resume' : 'Abandon'
	);
	abandon.addEventListener('click', async () => {
		const reason = prompt(
			p.status === 'abandoned' ? 'Why resume it?' : 'Why abandon this Project?'
		);
		if (!reason) return;
		const r = await c
			.act(p.status === 'abandoned' ? 'resume_project' : 'abandon_project', p.id, { reason })
			.catch((e) => alert((e as Error).message));
		if (r?.outcome === 'input_required')
			alert('Each unfinished Task needs a decision first; they are in Needs you.');
	});
	const about = p.about as any[];
	return h(
		'div',
		null,
		breadcrumb(c, [
			{ label: p.area?.title ?? 'Area', params: { tab: 'areas', area: p.area?.id } },
			{ label: p.title }
		]),
		h(
			'div',
			{ class: 'fw-page-head' },
			h(
				'div',
				null,
				kicker('Project'),
				h(
					'h1',
					{ class: 'fw-page-title' },
					p.title,
					' ',
					h('span', { class: 'fw-pill' }, p.status)
				),
				h(
					'div',
					{ class: 'fw-meta' },
					p.serves.map((o: any) => ['Serves ', objectiveLink(c, o), ' · ']),
					'Accountable: ',
					avatar(p.accountable_human),
					` ${who(p.accountable_human)} `,
					sessionChip(c, p.session)
				)
			),
			h('div', { class: 'fw-actions' }, abandon)
		),
		h(
			'div',
			{ class: 'fw-card' },
			h('h3', { class: 'fw-card-title' }, 'Outcome'),
			h('p', null, p.outcome)
		),
		section(
			'Milestones',
			null,
			p.milestones.length
				? h(
						'ol',
						{ class: 'fw-milestones' },
						p.milestones.map((m: any) => milestoneBlock(c, m, true))
					)
				: empty('No Milestones.')
		),
		p.tasks.length
			? section(
					'Other Tasks',
					p.tasks.length,
					h(
						'div',
						{ class: 'fw-list' },
						p.tasks.map((t: any) => taskRow(c, t))
					)
				)
			: null,
		section(
			'Decisions, Questions and Findings',
			about.length,
			about.length
				? h(
						'div',
						{ class: 'fw-list' },
						about.map((x: any) =>
							x.kind === 'decision' && x.status !== 'decided'
								? decisionCard(c, x)
								: x.kind === 'question' && x.status === 'open'
									? questionCard(c, x)
									: h(
											'div',
											{ class: 'fw-row', role: 'button', on: { click: () => openPanel(c, x.id) } },
											h(
												'span',
												{ class: 'fw-pill' },
												x.kind === 'decision'
													? 'Decision'
													: x.kind === 'question'
														? 'Question'
														: 'Finding'
											),
											h(
												'div',
												{ class: 'fw-row-main' },
												x.kind === 'finding'
													? x.conclusion
													: x.kind === 'decision'
														? `${x.prompt} → ${x.options.find((o: any) => o.id === x.chosen)?.label ?? x.status}`
														: `${x.prompt} (${x.status})`
											),
											h('span', { class: 'fw-muted' }, day(x.resolved_at ?? x.created_at))
										)
						)
					)
				: empty('None yet.')
		),
		section(
			'History',
			null,
			h(
				'ul',
				{ class: 'fw-history' },
				p.history.map((e: any) =>
					h(
						'li',
						null,
						`${day(e.at)} · ${e.command.replace(/_/g, ' ')}${e.title ? `: ${e.title}` : ''} · ${who(e.actor)}`
					)
				)
			)
		)
	);
}
