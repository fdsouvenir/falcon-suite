import type { Ctx } from '../app.js';
import { h, ago, day, who, count } from '../dom.js';
import {
	columns,
	detailHead,
	empty,
	happened,
	missing,
	needsYou,
	section,
	sessionList,
	side,
	taskRow
} from '../parts.js';
import type { ProjectPage } from '../types.js';

type Milestone = ProjectPage['milestones'][number];

/** A Project (spec §6): Needs you, Milestones with their Tasks, What happened; Outcome, Sessions, Findings. */
export async function projectView(c: Ctx, id: string) {
	const p = await c.read<ProjectPage | { error: string } | null>({ view: 'project', id });
	if (!p || 'error' in p) return missing(c, 'project');
	return h(
		'div',
		{ class: 'fw-detail' },
		detailHead(c, {
			kind: 'project',
			title: p.title,
			line: p.abandoned ? 'Abandoned.' : p.status_line,
			meta: [
				who(p.agent, c.owner),
				count(p.sessions.length, 'session'),
				`last activity ${ago(p.last_activity)}`,
				`${p.tasks_done} of ${p.tasks_total} tasks done`
			]
		}),
		columns(
			[
				p.needs_you.length
					? section('Needs you', p.needs_you.length, {}, needsYou(c, p.needs_you, { page: p.id }))
					: null,
				section(
					'Milestones',
					null,
					{},
					p.milestones.length
						? h(
								'div',
								{ class: 'fw-milestones' },
								p.milestones.map((m, i) => milestone(c, m, i))
							)
						: empty('No Milestones yet.')
				),
				p.other_tasks.length
					? section(
							'Other tasks',
							p.other_tasks.length,
							{},
							h(
								'div',
								{ class: 'fw-task-list' },
								p.other_tasks.map((t) => taskRow(c, t))
							)
						)
					: null,
				section(
					'What happened',
					null,
					{},
					p.happened.length
						? happened(c, p.happened, { page: p.id })
						: empty('Nothing recorded yet.')
				)
			],
			[
				side('Outcome', h('p', { class: 'fw-side-text' }, p.outcome)),
				side(`Sessions (${p.sessions.length})`, sessionList(c, p.sessions)),
				side(
					`Findings (${p.findings.length})`,
					p.findings.length
						? p.findings.map((f) =>
								h(
									'div',
									{ class: 'fw-finding' },
									h('p', { class: 'fw-finding-text' }, f.conclusion),
									h('p', { class: 'fw-side-note' }, `${f.confidence} · ${day(f.created_at)}`)
								)
							)
						: h('p', { class: 'fw-side-empty' }, 'None yet')
				)
			]
		)
	);
}

function milestone(c: Ctx, m: Milestone, i: number) {
	const state = m.state as 'achieved' | 'current' | 'upcoming';
	return h(
		'article',
		{ class: `fw-milestone is-${state}` },
		h(
			'div',
			{ class: 'fw-milestone-head' },
			h('h3', { class: 'fw-milestone-title' }, `${i + 1}. ${m.title}`),
			h(
				'span',
				{ class: 'fw-milestone-state' },
				state === 'achieved'
					? `Achieved${m.achieved_at ? ` ${day(m.achieved_at)}` : ''}`
					: state === 'current'
						? 'Current'
						: 'Upcoming'
			)
		),
		state === 'current' && m.success_condition
			? h('p', { class: 'fw-milestone-condition' }, `Success condition: “${m.success_condition}”`)
			: null,
		m.tasks.length
			? h(
					'div',
					{ class: 'fw-task-list' },
					m.tasks.map((t) => taskRow(c, t))
				)
			: h('p', { class: 'fw-side-empty' }, 'No tasks yet')
	);
}
