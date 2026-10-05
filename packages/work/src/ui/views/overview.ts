import type { Ctx } from '../app.js';
import { h, section, empty, day, icon } from '../dom.js';
import {
	decisionCard,
	questionCard,
	taskRow,
	warningRow,
	objectiveLink,
	kpiBar,
	evidence,
	openPanel
} from '../parts.js';

export async function overviewView(c: Ctx, setCount: (n: number) => void) {
	const v = await c.read({ view: 'overview' });
	setCount(v.needs_you.count);
	const n = v.needs_you;
	const needs = [
		...n.warnings.map((w: any) => warningRow(c, w)),
		...n.decisions.map((d: any) => decisionCard(c, d)),
		...n.questions.map((q: any) => questionCard(c, q)),
		...n.handovers.map((a: any) =>
			h(
				'div',
				{ class: 'fw-card' },
				h('strong', null, a.prompt),
				h(
					'button',
					{ class: 'fw-link', on: { click: () => openPanel(c, a.task) } },
					'Open the Task'
				)
			)
		)
	];
	const main = h(
		'div',
		{ class: 'fw-col-main' },
		section('Needs you', n.count, needs.length ? needs : empty('Nothing needs you right now.')),
		section(
			'Now',
			v.now.length,
			v.now.length
				? h(
						'div',
						{ class: 'fw-list' },
						v.now.map((t: any) => taskRow(c, t, { place: true }))
					)
				: empty('No Task is in progress.')
		),
		section(
			'Waiting',
			v.waiting.length,
			v.waiting.length
				? h(
						'div',
						{ class: 'fw-list' },
						v.waiting.map((t: any) => taskRow(c, t, { place: true }))
					)
				: empty('Nothing is waiting.')
		)
	);
	const side = h(
		'div',
		{ class: 'fw-col-side' },
		section(
			'Objectives',
			null,
			v.objectives.length
				? v.objectives.map((o: any) =>
						h(
							'div',
							{ class: 'fw-card fw-objective-mini' },
							h(
								'div',
								{ class: 'fw-card-head' },
								objectiveLink(c, o),
								h('span', { class: 'fw-pill' }, o.autonomy)
							),
							o.kpis.map((k: any) => kpiBar(k)),
							h(
								'div',
								{ class: o.last_progress ? 'fw-muted' : 'fw-warn-text' },
								o.last_progress ? `Last progress ${day(o.last_progress)}` : 'No progress yet'
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
						{ class: 'fw-list' },
						v.completed.map((t: any) =>
							h(
								'div',
								{ class: 'fw-row', role: 'button', on: { click: () => openPanel(c, t.id) } },
								h('span', { class: 'fw-status fw-status-completed' }, icon('check')),
								h(
									'div',
									{ class: 'fw-row-main' },
									h('span', { class: 'fw-row-title' }, t.title),
									h(
										'span',
										{ class: 'fw-row-sub' },
										day(t.updated_at),
										' ',
										evidence(t.result?.sources?.slice(0, 1))
									)
								)
							)
						)
					)
				: empty('Nothing completed yet.')
		),
		section(
			'Untracked activity',
			v.untracked.count,
			v.untracked.items.length
				? h(
						'div',
						{ class: 'fw-list' },
						v.untracked.items.slice(0, 4).map((a: any) =>
							h(
								'div',
								{ class: 'fw-row fw-untracked' },
								h(
									'div',
									{ class: 'fw-row-main' },
									h('span', null, `${day(a.at)} · ${a.summary}`),
									h(
										'a',
										{
											class: 'fw-link',
											href: c.href({ tab: 'activity', feed: 'untracked' }),
											on: {
												click: (e: Event) => (
													e.preventDefault(),
													c.go({ tab: 'activity', feed: 'untracked' })
												)
											}
										},
										'Create Task from this →'
									)
								)
							)
						)
					)
				: empty('Every recorded action is explained by a Task.')
		)
	);
	return h('div', { class: 'fw-columns' }, main, side);
}
