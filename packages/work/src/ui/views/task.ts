import type { Ctx } from '../app.js';
import { h, ago, who, count } from '../dom.js';
import {
	columns,
	detailHead,
	empty,
	evidence,
	happened,
	itemLink,
	missing,
	section,
	sessionChip,
	sessionList,
	side,
	KIND
} from '../parts.js';
import type { TaskPage } from '../types.js';

/** A Task (spec §6): Done when, Plan, What happened with evidence, Result; Sessions, Belongs to, Questions. */
export async function taskView(c: Ctx, id: string) {
	const t = await c.read<TaskPage | { error: string } | null>({ view: 'task', id });
	if (!t || 'error' in t) return missing(c, 'task');
	const parent = t.belongs_to;
	return h(
		'div',
		{ class: 'fw-detail' },
		detailHead(c, {
			kind: 'task',
			status: t.status,
			title: t.title,
			line: t.status_line,
			waiting: t.waiting,
			meta: [
				who(t.agent, c.owner),
				count(t.sessions.length, 'session'),
				`last activity ${ago(t.last_activity)}`,
				parent ? h('span', null, 'in ', itemLink(c, parent)) : 'standalone task'
			]
		}),
		columns(
			[
				section('Done when', null, {}, h('div', { class: 'fw-box' }, t.done_when)),
				t.plan
					? section('Plan', null, {}, h('div', { class: 'fw-box fw-pre' }, t.plan.content))
					: null,
				section(
					'What happened',
					null,
					{},
					t.happened.some((e) => e.summary || e.outcomes.length)
						? happened(c, t.happened, { page: t.id, evidence: true })
						: empty('Nothing recorded yet.')
				),
				section(
					'Result',
					null,
					{},
					t.result
						? [h('p', { class: 'fw-pre fw-result' }, t.result.content), evidence(t.result.sources)]
						: h('p', { class: 'fw-not-yet' }, 'Not finished yet.')
				)
			],
			[
				side(`Sessions (${t.sessions.length})`, sessionList(c, t.sessions)),
				side(
					'Belongs to',
					parent
						? h(
								'p',
								{ class: 'fw-side-text' },
								`${KIND[parent.kind]} `,
								itemLink(c, parent),
								t.milestone
									? h(
											'span',
											{ class: 'fw-side-note fw-block' },
											`Milestone ${t.milestone.position} · ${t.milestone.title}`
										)
									: null
							)
						: h(
								'p',
								{ class: 'fw-side-text fw-muted' },
								'Standalone — not part of a Project or Job'
							)
				),
				side(
					'Questions',
					t.needs_you.length
						? t.needs_you.map((n) =>
								h(
									'div',
									{ class: 'fw-side-question' },
									h('p', { class: 'fw-side-text' }, n.prompt),
									n.session ? sessionChip(c, n.session, n.since) : null
								)
							)
						: h('p', { class: 'fw-side-text fw-muted' }, 'Nothing open')
				)
			]
		)
	);
}
