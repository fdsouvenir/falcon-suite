import type { Ctx } from '../app.js';
import { h, section, empty, day, who, avatar, icon } from '../dom.js';
import { kpiBar, sessionChip, decisionCard, questionCard, taskRow, evidence } from '../parts.js';

export async function objectivesView(c: Ctx) {
	const list = await c.read({ view: 'objectives' });
	return h(
		'div',
		null,
		h(
			'div',
			{ class: 'fw-subbar' },
			h('span', { class: 'fw-muted' }, `${list.length} active · ranked`)
		),
		list.length
			? h(
					'ol',
					{ class: 'fw-objectives' },
					list.map((o: any) =>
						h(
							'li',
							{ class: 'fw-card fw-objective' },
							h(
								'div',
								{ class: 'fw-card-head' },
								h('span', { class: 'fw-rank' }, `#${o.rank}`),
								h(
									'a',
									{
										class: 'fw-objective-title',
										href: c.href({ objective: o.id }),
										on: { click: (e: Event) => (e.preventDefault(), c.go({ objective: o.id })) }
									},
									o.title,
									' ›'
								),
								h('span', { class: 'fw-pill' }, o.autonomy),
								h(
									'span',
									{ class: `fw-right ${o.last_progress ? 'fw-muted' : 'fw-warn-text'}` },
									o.last_progress ? `Last progress ${day(o.last_progress)}` : 'No progress yet'
								)
							),
							o.kpis.length
								? o.kpis.map((k: any) => kpiBar(k))
								: h('p', { class: 'fw-muted' }, 'No KPIs'),
							o.serving.projects.length || o.serving.tasks.length
								? h(
										'p',
										null,
										h('span', { class: 'fw-muted' }, 'Serving: '),
										[
											...o.serving.projects.map(
												(p: any) => `${p.title} (${p.tasks_done} of ${p.tasks_total} Tasks)`
											),
											...o.serving.tasks.map((t: any) => t.title)
										].join(' · ')
									)
								: h('p', { class: 'fw-muted' }, 'Nothing serves this Objective yet.'),
							o.latest_review
								? h(
										'p',
										null,
										h('strong', null, `Latest review ${day(o.latest_review.at)}: `),
										o.latest_review.moved
									)
								: h('p', { class: 'fw-muted' }, 'No review yet')
						)
					)
				)
			: empty('No Objectives yet.')
	);
}

export async function objectiveView(c: Ctx, id: string) {
	const o = await c.read({ view: 'objective', id });
	if (o.error) return empty('This Objective no longer exists.');
	const review = o.reviews[0];
	const serving = [
		...o.serving.projects.map((p: any) => {
			const tasks = p.milestones.flatMap((m: any) => m.tasks);
			return h(
				'div',
				{ class: 'fw-card' },
				h(
					'div',
					{ class: 'fw-card-head' },
					h(
						'a',
						{
							class: 'fw-strong fw-link',
							href: c.href({ project: p.id }),
							on: { click: (e: Event) => (e.preventDefault(), c.go({ project: p.id })) }
						},
						p.title,
						' ›'
					),
					h('span', { class: 'fw-pill' }, p.area_title ?? '')
				),
				p.milestones.length
					? h(
							'p',
							{ class: 'fw-muted' },
							'Milestones: ',
							p.milestones
								.map((m: any) => `${m.status === 'achieved' ? '✓' : '○'} ${m.title}`)
								.join('  ')
						)
					: null,
				tasks.length
					? h(
							'div',
							{ class: 'fw-list' },
							tasks.map((t: any) => taskRow(c, t))
						)
					: h('p', { class: 'fw-muted' }, 'No Tasks yet')
			);
		}),
		...o.serving.tasks.map((t: any) => taskRow(c, t, { place: true }))
	];
	const main = h(
		'div',
		{ class: 'fw-col-main' },
		h(
			'section',
			{ class: 'fw-section' },
			h('h2', { class: 'fw-section-title' }, 'Statement'),
			h('div', { class: 'fw-card' }, o.statement)
		),
		o.warnings.map((w: any) =>
			h(
				'div',
				{ class: 'fw-card fw-warning' },
				icon('warn'),
				h(
					'span',
					null,
					h('strong', { class: 'fw-warn-text' }, 'Objective without progress'),
					' — ',
					w.detail
				)
			)
		),
		section(
			'KPIs',
			null,
			o.kpis.length
				? h(
						'div',
						{ class: 'fw-card' },
						o.kpis.map((k: any) => kpiBar(k))
					)
				: empty('No KPIs.')
		),
		review
			? section(
					`Latest review — ${day(review.at)}, ${who(review.author)}`,
					null,
					h(
						'div',
						{ class: 'fw-card fw-review' },
						h(
							'dl',
							null,
							h('dt', null, 'Moved'),
							h('dd', null, review.moved),
							h('dt', null, 'Stalled'),
							h('dd', null, review.stalled),
							review.proposed ? [h('dt', null, 'Proposed'), h('dd', null, review.proposed)] : null
						),
						h(
							'div',
							{ class: 'fw-card-foot' },
							evidence(review.sources),
							o.reviews.length > 1
								? h('span', { class: 'fw-muted' }, `${o.reviews.length} reviews`)
								: null
						)
					)
				)
			: null,
		section(
			'Serving this Objective',
			null,
			serving.length ? serving : empty('Nothing serves this Objective yet.')
		)
	);
	const side = h(
		'div',
		{ class: 'fw-col-side' },
		section(
			'Needs you',
			o.needs_you.length,
			o.needs_you.length
				? o.needs_you.map((x: any) =>
						x.kind === 'decision' ? decisionCard(c, x) : questionCard(c, x)
					)
				: empty('Nothing.')
		),
		section(
			'Autonomy',
			null,
			h(
				'div',
				{ class: 'fw-card' },
				h(
					'p',
					null,
					h('strong', null, o.autonomy),
					o.autonomy === 'propose'
						? ' — agents suggest next steps as Decisions for you.'
						: ` — agents act within: ${o.limits}`
				)
			)
		),
		section(
			'History',
			null,
			h(
				'ul',
				{ class: 'fw-history' },
				o.history.map((e: any) =>
					h('li', null, `${day(e.at)} · ${e.command.replace(/_/g, ' ')} · ${who(e.actor)}`)
				)
			)
		)
	);
	return h(
		'div',
		null,
		breadcrumb(c, [{ label: 'Objectives', params: { tab: 'objectives' } }, { label: o.title }]),
		h(
			'div',
			{ class: 'fw-page-head' },
			h(
				'div',
				null,
				h(
					'h1',
					{ class: 'fw-page-title' },
					o.rank ? h('span', { class: 'fw-rank' }, `#${o.rank}`) : null,
					' ',
					o.title,
					' ',
					h('span', { class: 'fw-pill' }, o.status)
				),
				h(
					'div',
					{ class: 'fw-meta' },
					'Owner: ',
					avatar(o.owner),
					` ${who(o.owner)} · Autonomy: ${o.autonomy} `,
					sessionChip(c, o.session)
				)
			)
		),
		h('div', { class: 'fw-columns' }, main, side)
	);
}

export function breadcrumb(c: Ctx, parts: { label: string; params?: Record<string, string> }[]) {
	return h(
		'nav',
		{ class: 'fw-breadcrumb', 'aria-label': 'Breadcrumb' },
		h(
			'button',
			{ class: 'fw-link', type: 'button', on: { click: () => history.back() } },
			'‹ Back'
		),
		' / ',
		h(
			'a',
			{
				class: 'fw-link',
				href: c.href({}),
				on: { click: (e: Event) => (e.preventDefault(), c.go({})) }
			},
			'Work'
		),
		parts.map((p) => [
			' › ',
			p.params
				? h(
						'a',
						{
							class: 'fw-link',
							href: c.href(p.params),
							on: { click: (e: Event) => (e.preventDefault(), c.go(p.params!)) }
						},
						p.label
					)
				: h('span', { class: 'fw-strong' }, p.label)
		])
	);
}
