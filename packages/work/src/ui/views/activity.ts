import type { Ctx } from '../app.js';
import { h, empty, time, who, avatar } from '../dom.js';
import { openPanel } from '../parts.js';

const FILTERS = [
	{ id: 'all', label: 'All' },
	{ id: 'changes', label: 'Changes' },
	{ id: 'activity', label: 'Agent activity' },
	{ id: 'untracked', label: 'Untracked' }
] as const;

/** One feed of recorded changes and captured activity, newest first, grouped by day. */
export async function activityView(c: Ctx) {
	const filter = (c.params.feed as (typeof FILTERS)[number]['id']) ?? 'all';
	const v = await c.read({ view: 'feed', filters: { feed: filter } });
	const days = new Map<string, any[]>();
	for (const item of v.items) {
		const key = new Date(item.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		days.set(key, [...(days.get(key) ?? []), item]);
	}
	return h(
		'div',
		null,
		h(
			'div',
			{ class: 'fw-chips', role: 'tablist', 'aria-label': 'Activity filter' },
			FILTERS.map((f) =>
				h(
					'a',
					{
						class: `fw-chip fw-area-chip${filter === f.id ? ' is-active' : ''}`,
						role: 'tab',
						'aria-selected': String(filter === f.id),
						href: c.href({ tab: 'activity', feed: f.id }),
						on: { click: (e: Event) => (e.preventDefault(), c.go({ tab: 'activity', feed: f.id })) }
					},
					f.label,
					f.id === 'untracked' && v.untracked_count
						? h('span', { class: 'fw-count' }, String(v.untracked_count))
						: null
				)
			)
		),
		v.items.length
			? [...days].map(([d, items]) =>
					h(
						'section',
						{ class: 'fw-section' },
						h('h2', { class: 'fw-day' }, d),
						h(
							'div',
							{ class: 'fw-list fw-card' },
							items.map((i) => feedRow(c, i))
						)
					)
				)
			: empty(
					filter === 'untracked'
						? 'Every recorded action is explained by a Task.'
						: 'Nothing recorded yet.'
				)
	);
}

function feedRow(c: Ctx, i: any) {
	const object = i.object?.id
		? h(
				'button',
				{
					class: 'fw-chip',
					type: 'button',
					on: {
						click: () =>
							i.object.kind === 'project'
								? c.go({ project: i.object.id })
								: i.object.kind === 'objective'
									? c.go({ objective: i.object.id })
									: openPanel(c, i.object.id)
					}
				},
				`${cap(i.object.kind)}: ${clip(i.object.title)}`
			)
		: null;
	const text =
		i.type === 'change'
			? `${cap(i.command.replace(/_/g, ' '))}${i.object?.title ? `: ${i.object.title}` : ''}`
			: i.summary;
	return h(
		'div',
		{ class: `fw-row fw-feed${i.untracked ? ' fw-untracked' : ''}` },
		h('span', { class: 'fw-mono fw-muted' }, time(i.at)),
		avatar(i.actor),
		h('span', { class: 'fw-muted fw-who' }, who(i.actor)),
		i.untracked ? h('span', { class: 'fw-pill fw-pill-warn' }, 'untracked') : null,
		h('span', { class: 'fw-row-main' }, text),
		i.type === 'activity' && !i.untracked ? h('span', { class: 'fw-muted' }, 'captured') : null,
		i.ref ? h('span', { class: 'fw-chip fw-mono' }, clip(i.ref, 24)) : null,
		i.type === 'change' ? object : null,
		i.untracked
			? h(
					'button',
					{ class: 'fw-link', type: 'button', on: { click: () => createFromActivity(c, i) } },
					'Create Task from this →'
				)
			: null
	);
}

async function createFromActivity(c: Ctx, i: any) {
	const areas = (await c.read({ view: 'areas' })).areas as any[];
	if (!areas.length) return alert('Create an Area first: every Task lives in an Area or Project.');
	const title = prompt('Task title', i.summary);
	if (!title) return;
	const area =
		areas.length === 1
			? areas[0]
			: areas.find(
					(a) =>
						a.title.toLowerCase() ===
						(prompt(`Which Area? (${areas.map((a) => a.title).join(', ')})`) ?? '').toLowerCase()
				);
	if (!area) return alert('No such Area.');
	await c
		.act('create_task_from_activity', undefined, {
			title,
			description: `Explains: ${i.summary}`,
			done_when: 'Recorded what this activity was for.',
			area: area.id,
			activity: [i.id]
		})
		.catch((e) => alert((e as Error).message));
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clip = (s: string, n = 40) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s ?? ''));
