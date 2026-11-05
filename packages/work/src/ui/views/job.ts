import type { Ctx } from '../app.js';
import { h, icon, day, who, count } from '../dom.js';
import {
	columns,
	denseTaskRow,
	detailHead,
	empty,
	expander,
	happened,
	missing,
	needsYou,
	section,
	side
} from '../parts.js';
import type { JobPage } from '../types.js';

/** A Job (spec §6): Needs you, Open tasks, Done this week, What happened; Instructions, Automations. */
export async function jobView(c: Ctx, id: string) {
	const j = await c.read<JobPage | { error: string } | null>({ view: 'job', id });
	if (!j || 'error' in j) return missing(c, 'job');
	return h(
		'div',
		{ class: 'fw-detail' },
		detailHead(c, {
			kind: 'job',
			status: j.status,
			title: j.title,
			line: j.status_line,
			meta: [
				who(j.agent, c.owner),
				`runs on ${count(j.automations.length, 'automation')}`,
				`since ${day(j.created_at)}`
			]
		}),
		columns(
			[
				j.needs_you.length
					? section(
							'Needs you',
							j.needs_you_total,
							{},
							needsYou(c, j.needs_you, { page: j.id, total: j.needs_you_total })
						)
					: null,
				section(
					'Open tasks',
					j.open_tasks.length,
					{},
					j.open_tasks.length
						? h(
								'div',
								{ class: 'fw-dense' },
								j.open_tasks.map((t) => denseTaskRow(c, t))
							)
						: empty('No open tasks.')
				),
				j.done_this_week.length
					? expander(
							c,
							`job-done:${j.id}`,
							`Done this week (${j.done_this_week.length})`,
							h(
								'div',
								{ class: 'fw-dense' },
								j.done_this_week.map((t) => denseTaskRow(c, t))
							)
						)
					: null,
				section(
					'What happened',
					null,
					{},
					j.happened.length
						? happened(c, j.happened, { page: j.id })
						: empty('Nothing recorded yet.')
				)
			],
			[
				side('Instructions', h('p', { class: 'fw-side-text fw-pre' }, j.instructions)),
				side(
					`Automations (${j.automations.length})`,
					j.automations.length
						? h(
								'div',
								{ class: 'fw-automations' },
								j.automations.map((a) =>
									h(
										'div',
										{ class: 'fw-automation' },
										icon('bolt'),
										a.name
											? h('span', { class: 'fw-automation-name' }, a.name)
											: h('span', { class: 'fw-automation-name fw-mono' }, a.automation_id)
									)
								)
							)
						: h('p', { class: 'fw-side-empty' }, 'None linked')
				)
			]
		)
	);
}
