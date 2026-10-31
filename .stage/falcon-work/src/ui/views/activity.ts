import type { Ctx } from '../app.js';
import { formDialog, messageDialog } from '../dialog.js';
import { h, empty } from '../dom.js';
import { byDay, timeline } from '../parts.js';

const FILTERS = [
	{ id: 'all', label: 'All' },
	{ id: 'unfiled', label: 'Unfiled' }
] as const;

/** Every Task's timeline, newest first, grouped by day (spec §10, Timeline). */
export async function activityView(c: Ctx) {
	const filter = (c.params.feed as (typeof FILTERS)[number]['id']) ?? 'all';
	const v = await c.read({ view: 'feed', filters: { feed: filter } });
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
					f.id === 'unfiled' && v.unfiled_count
						? h('span', { class: 'fw-count' }, String(v.unfiled_count))
						: null
				)
			)
		),
		v.items.length
			? byDay(v.items).map(([d, items]) =>
					h(
						'section',
						{ class: 'fw-section' },
						h('h2', { class: 'fw-day' }, d),
						h(
							'div',
							{ class: 'fw-card' },
							timeline(c, items, { showTask: true, file: (e) => fileEntry(c, e) })
						)
					)
				)
			: empty(filter === 'unfiled' ? 'All work is filed under a Task.' : 'Nothing done yet.')
	);
}

/** File an unfiled turn under an open Task, or under a new one. */
async function fileEntry(c: Ctx, e: any) {
	const [tasks, areas] = await Promise.all([
		c.read({ view: 'list', kind: 'task', filters: { limit: 100 } }),
		c.read({ view: 'areas' })
	]);
	const open = ((tasks.items ?? tasks) as any[]).filter(
		(t) => !['completed', 'abandoned'].includes(t.status)
	);
	const areaList = (areas.areas ?? []) as any[];
	if (!open.length && !areaList.length)
		return messageDialog(
			c,
			'Create an Area first',
			'Every Task lives in an Area or a Project. Add an Area on the Areas & Projects tab, then come back.'
		);
	const what = e.summary ?? e.outcomes.map((o: any) => o.label).join(', ');
	formDialog(c, {
		title: 'File this work',
		description: what,
		fields: [
			{
				id: 'task',
				label: 'Under',
				kind: 'select',
				options: [
					...open.map((t) => ({ value: t.id, label: `Task: ${t.title}` })),
					...areaList.map((a) => ({ value: `area:${a.id}`, label: `New Task in ${a.title}` }))
				]
			},
			{ id: 'title', label: 'New Task title (for a new Task)', value: what.slice(0, 200) }
		],
		submitLabel: 'File it',
		submit: async (v) => {
			const r = v.task.startsWith('area:')
				? await c.act('create_task_from_entries', undefined, {
						title: v.title.trim() || what.slice(0, 200),
						description: what,
						done_when: 'The work recorded here is finished.',
						area: v.task.slice(5),
						entries: [e.id]
					})
				: await c.act('file_entries', v.task, { entries: [e.id] });
			return r?.outcome === 'rejected' ? r.reason : undefined;
		}
	});
}
