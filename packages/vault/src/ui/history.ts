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
	['retrieve', 'Retrieved by an agent'],
	['reveal', 'Revealed'],
	['copy', 'Copied'],
	['store', 'Stored by an agent'],
	['request', 'Asked for a value'],
	['fill_request', 'Filled in'],
	['dismiss_request', 'Request dismissed'],
	['create_entry', 'Created'],
	['edit_entry', 'Edited'],
	['restore_version', 'Previous version restored'],
	['recycle_entry', 'Moved to Recycle Bin'],
	['delete_forever', 'Deleted forever'],
	['create_group', 'Group created'],
	['rename_group', 'Group renamed'],
	['move_group', 'Group moved'],
	['delete_group', 'Group deleted']
] as const;

/**
 * The whole Vault's history (spec §8), in one place: every change, read and reveal, newest first,
 * filtered by text in the path (a folder or an entry), one entry, actor or action. Who did what to
 * which path, when, and whether it worked; never a value.
 */
export function historyView(c: Ctx, events: HistoryEvent[], older: (() => void) | null) {
	const p = c.params;
	const filter = (key: 'hp' | 'ha', label: string, placeholder: string) => {
		const el = h('input', {
			class: 'fv-input',
			type: 'search',
			placeholder,
			'aria-label': label
		});
		el.value = p[key] ?? '';
		el.addEventListener('change', () =>
			c.go({
				...p,
				[key]: el.value.trim() || undefined,
				...(key === 'hp' ? { hu: undefined } : {})
			})
		);
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
		// A path narrows History to that entry: by UUID when the event recorded one, so it follows
		// the entry through renames and moves.
		const entry: string | undefined = ev.detail?.entry ?? ev.detail?.uuid;
		const narrow = entry
			? { hu: entry, hp: undefined }
			: { hp: ev.path ?? undefined, hu: undefined };
		const open = ev.path
			? h(
					'a',
					{
						class: 'fv-link fv-mono',
						href: c.href({ ...p, ...narrow }),
						title: 'Show only this entry',
						on: {
							click: (e: Event) => (e.preventDefault(), c.go({ ...p, ...narrow }))
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
			`History · ${events.length}${older ? '+' : ''}`
		),
		h(
			'div',
			{ class: 'fv-history-filters' },
			filter('hp', 'Path', 'Folder or entry, e.g. Cloudflare'),
			filter('ha', 'Actor', 'Actor, e.g. agent:verl, resolver'),
			action
		),
		p.hu
			? h(
					'p',
					{ class: 'fv-history-scope fv-small' },
					h('span', { class: 'fv-muted' }, 'One entry'),
					events[0]?.path
						? h('span', { class: 'fv-mono' }, ` · ${shownPath(events[0].path)}`)
						: null,
					' ',
					h(
						'a',
						{
							class: 'fv-link',
							href: c.href({ ...p, hu: undefined }),
							on: { click: (e: Event) => (e.preventDefault(), c.go({ ...p, hu: undefined })) }
						},
						'Show everything'
					)
				)
			: null,
		rows.length
			? h('ul', { class: 'fv-history fv-history-page' }, rows)
			: h('p', { class: 'fv-empty' }, 'Nothing recorded yet.'),
		older
			? h(
					'button',
					{
						class: 'fv-btn fv-btn-quiet fv-history-more',
						type: 'button',
						on: {
							click: (e: Event) => {
								(e.currentTarget as HTMLButtonElement).disabled = true;
								older();
							}
						}
					},
					'Show older'
				)
			: null
	);
}
