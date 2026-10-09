import type { Ctx, GroupNode } from './app.js';
import { formDialog } from './dialog.js';
import { h, icon } from './dom.js';
import { menuButton } from './menu.js';

/** Every group path, for pickers: `{ value: 'Services/Cloudflare', label: 'Services / Cloudflare' }`. */
export function groupOptions(c: Ctx, opts: { top?: string; skip?: string } = {}) {
	const out: { value: string; label: string }[] = [];
	if (opts.top) out.push({ value: '', label: opts.top });
	const walk = (nodes: GroupNode[]) => {
		for (const n of nodes) {
			if (opts.skip && (n.path === opts.skip || n.path.startsWith(`${opts.skip}/`))) continue;
			out.push({ value: n.path, label: n.path.split('/').join(' / ') });
			walk(n.children);
		}
	};
	walk(c.overview.groups);
	return out;
}

/** Group dialogs (spec §9): New group, Rename group, New subgroup, Move group to…. */
export function newGroupDialog(c: Ctx, parent: string) {
	formDialog(c.host, {
		title: parent ? 'New subgroup' : 'New group',
		description: parent ? `Inside ${parent.split('/').join(' / ')}.` : undefined,
		fields: [
			...(parent
				? []
				: [
						{
							id: 'parent',
							label: 'Inside',
							kind: 'select' as const,
							value: c.params.g ?? '',
							options: groupOptions(c, { top: 'Top level' })
						}
					]),
			{ id: 'name', label: 'Name', placeholder: 'e.g. Services' }
		],
		submitLabel: 'Create group',
		submit: async (v) => {
			const where = parent || v.parent || '';
			const r = await c.edit('create_group', { parent: where, name: v.name });
			c.go({ g: r.path });
		}
	});
}

function renameDialog(c: Ctx, g: GroupNode) {
	formDialog(c.host, {
		title: 'Rename group',
		description: 'Its entries move with it. Config references to them stop working until updated.',
		fields: [{ id: 'name', label: 'Name', value: g.name }],
		submitLabel: 'Rename',
		submit: async (v) => {
			const r = await c.edit('rename_group', { path: g.path, name: v.name });
			if (c.params.g === g.path) c.go({ g: r.path });
		}
	});
}

function moveDialog(c: Ctx, g: GroupNode) {
	formDialog(c.host, {
		title: 'Move group to…',
		description: `${g.path.split('/').join(' / ')} and everything in it.`,
		fields: [
			{
				id: 'parent',
				label: 'Move into',
				kind: 'select',
				value: g.path.includes('/') ? g.path.slice(0, g.path.lastIndexOf('/')) : '',
				options: groupOptions(c, { top: 'Top level', skip: g.path })
			}
		],
		submitLabel: 'Move',
		submit: async (v) => {
			const r = await c.edit('move_group', { path: g.path, parent: v.parent });
			if (c.params.g === g.path) c.go({ g: r.path });
		}
	});
}

function deleteDialog(c: Ctx, g: GroupNode) {
	formDialog(c.host, {
		title: 'Delete group',
		description: `${g.path.split('/').join(' / ')} is empty. Delete it?`,
		fields: [],
		submitLabel: 'Delete group',
		danger: true,
		submit: async () => {
			await c.edit('delete_group', { path: g.path });
			if (c.params.g === g.path) c.go({});
		}
	});
}

/**
 * The group tree (spec §9): Needs a value pinned at the top when there are Requests, All entries,
 * the groups with "⋯" menus, and the Recycle Bin at the bottom. `onPick` runs after a choice (the
 * mobile sheet closes itself).
 */
export function tree(c: Ctx, onPick: () => void = () => {}) {
	const o = c.overview;
	const p = c.params;
	const selected = (key: string) =>
		key === 'needs' || key === 'recycle' || key === 'history'
			? p.v === key
			: !p.v && !p.q && (p.g ?? '') === key;
	const pick = (params: Record<string, string | undefined>) => (e: Event) => {
		e.preventDefault();
		c.go(params);
		onPick();
	};
	const expanded = c.expanded;
	const row = (opts: {
		key: string;
		label: string;
		count: number;
		params: Record<string, string | undefined>;
		dot?: boolean;
		toggle?: HTMLElement | null;
		menu?: HTMLElement | null;
		iconName?: 'history' | 'trash';
	}) =>
		h(
			'div',
			{
				class: `fv-tree-row fv-menu-anchor${selected(opts.key) ? ' is-selected' : ''}${opts.dot ? ' is-needs' : ''}`
			},
			opts.toggle ?? null,
			h(
				'a',
				{
					class: 'fv-tree-link',
					href: c.href(opts.params),
					'aria-current': selected(opts.key) ? 'page' : null,
					on: { click: pick(opts.params) }
				},
				opts.dot ? h('span', { class: 'fv-dot fv-dot-accent', 'aria-hidden': 'true' }) : null,
				opts.iconName ? icon(opts.iconName, 14) : null,
				h('span', { class: 'fv-tree-name' }, opts.label),
				opts.count >= 0 ? h('span', { class: 'fv-tree-count' }, String(opts.count)) : null
			),
			opts.menu ?? null
		);
	// Subgroups sit under their parent, behind a guide line, only while it is open.
	const groupRows = (nodes: GroupNode[]): HTMLElement[] =>
		nodes.flatMap((g) => {
			const open = expanded.has(g.path) || (p.g ?? '').startsWith(`${g.path}/`);
			const toggle = g.children.length
				? h(
						'button',
						{
							class: 'fv-tree-toggle',
							type: 'button',
							'aria-label': open ? `Collapse ${g.name}` : `Expand ${g.name}`,
							'aria-expanded': String(open),
							on: {
								click: () => {
									open ? expanded.delete(g.path) : expanded.add(g.path);
									c.redraw();
								}
							}
						},
						icon(open ? 'chevronDown' : 'chevronRight', 14)
					)
				: null;
			const empty = g.count === 0 && !g.children.length;
			const menu = menuButton(`${g.name} group actions`, () => [
				{ label: 'Rename group', run: () => renameDialog(c, g) },
				{ label: 'New subgroup', run: () => newGroupDialog(c, g.path) },
				{ label: 'Move group to…', run: () => moveDialog(c, g) },
				{
					label: 'Delete group',
					run: () => deleteDialog(c, g),
					disabled: !empty,
					hint: 'Only an empty group can be deleted',
					danger: true
				}
			]);
			return [
				row({
					key: g.path,
					label: g.name,
					count: g.count,
					params: { g: g.path },
					toggle,
					menu
				}),
				...(open && g.children.length
					? [h('div', { class: 'fv-tree-children' }, groupRows(g.children))]
					: [])
			];
		});
	return h(
		'nav',
		{ class: 'fv-tree', 'aria-label': 'Groups' },
		h(
			'div',
			{ class: 'fv-tree-top' },
			o.needs
				? row({
						key: 'needs',
						label: 'Needs a value',
						count: o.needs,
						params: { v: 'needs' },
						dot: true
					})
				: null,
			row({ key: '', label: 'All entries', count: o.total, params: {} })
		),
		h('div', { class: 'fv-tree-groups' }, groupRows(o.groups)),
		h(
			'div',
			{ class: 'fv-tree-bottom' },
			row({
				key: 'history',
				label: 'History',
				count: -1,
				params: { v: 'history' },
				iconName: 'history'
			}),
			o.recycle_bin
				? row({
						key: 'recycle',
						label: 'Recycle Bin',
						count: o.recycle_bin.count,
						params: { v: 'recycle' },
						iconName: 'trash'
					})
				: null
		)
	);
}
