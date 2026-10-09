import type { Ctx } from './app.js';
import { ago, h, shownPath } from './dom.js';
import { historyLine } from './entry.js';

export type HistoryEvent = {
	id: number;
	at: string;
	actor: string;
	action: string;
	path: string | null;
	outcome: string;
	detail: any;
};

const ACTIONS = [
	['', 'Any action'],
	['resolve', 'Read by OpenClaw'],
	['reveal', 'Revealed'],
	['copy', 'Copied'],
	['store', 'Stored by an agent'],
	['request', 'Asked for a value'],
	['fill_request', 'Filled in'],
	['dismiss_request', 'Request dismissed'],
	['create_entry', 'Created'],
	['edit_entry', 'Edited'],
	['recycle_entry', 'Moved to Recycle Bin'],
	['delete_forever', 'Deleted forever'],
	['create_group', 'Group created'],
	['rename_group', 'Group renamed'],
	['move_group', 'Group moved'],
	['delete_group', 'Group deleted']
] as const;

/**
 * The whole Vault's history (spec §8), filtered by path, actor or action. Who did what to which
 * path, when, and whether it worked; never a value.
 */
export function historyView(c: Ctx, events: HistoryEvent[]) {
	const p = c.params;
	const filter = (key: 'hp' | 'ha', label: string, placeholder: string) => {
		const el = h('input', {
			class: 'fv-input',
			type: 'search',
			placeholder,
			'aria-label': label
		});
		el.value = p[key] ?? '';
		el.addEventListener('change', () => c.go({ ...p, [key]: el.value.trim() || undefined }));
		return el;
	};
	const action = h(
		'select',
		{
			class: 'fv-input',
			'aria-label': 'Action',
			on: {
				change: (e: Event) => c.go({ ...p, hx: (e.target as HTMLSelectElement).value || undefined })
			}
		},
		ACTIONS.map(([value, label]) => h('option', { value, selected: (p.hx ?? '') === value }, label))
	);
	const rows = events.map((ev) => {
		const line = historyLine(ev);
		const open = ev.path
			? h(
					'a',
					{
						class: 'fv-link fv-mono',
						href: c.href({ e: ev.path }),
						on: {
							click: (e: Event) => (e.preventDefault(), c.go({ ...p, hp: ev.path! }))
						}
					},
					shownPath(ev.path)
				)
			: null;
		return h(
			'li',
			{ class: 'fv-history-row' },
			h(
				'span',
				{ class: 'fv-history-what' },
				h('strong', { class: 'fv-strong' }, line.who),
				h('span', { class: 'fv-muted' }, ` · ${line.verb}`),
				open ? h('span', { class: 'fv-muted' }, ' · ') : null,
				open
			),
			h('span', { class: 'fv-mono fv-muted', title: new Date(ev.at).toLocaleString() }, ago(ev.at))
		);
	});
	return h(
		'section',
		{ class: 'fv-list', 'aria-label': 'History' },
		h(
			'h2',
			{ class: 'fv-list-head' },
			h('span', { class: 'fv-dot fv-dot-muted', 'aria-hidden': 'true' }),
			`History · ${events.length}${events.length >= 200 ? '+' : ''}`
		),
		h(
			'div',
			{ class: 'fv-history-filters' },
			filter('hp', 'Path', 'Path, e.g. Services/Cloudflare/dns-edit'),
			filter('ha', 'Actor', 'Actor, e.g. agent:verl, resolver'),
			action
		),
		rows.length
			? h('ul', { class: 'fv-history fv-history-page' }, rows)
			: h('p', { class: 'fv-empty' }, 'Nothing recorded yet.')
	);
}
