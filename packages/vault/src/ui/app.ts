import type { ControlUiHost, ControlUiViewContext } from 'openclaw/plugin-sdk/control-ui';
import { createFeatureClient } from 'openclaw/plugin-sdk/feature-contract';
import { contract } from '../contract.js';
import type { EntrySummary, GroupNode, Usage } from '../store/ops.js';
import { h, icon } from './dom.js';
import { entryView } from './entry.js';
import { entryForm, fillForm } from './form.js';
import { historyView, type HistoryEvent } from './history.js';
import { list, listTitle } from './list.js';
import { closeMenus } from './menu.js';
import { newGroupDialog, tree } from './tree.js';

export const PAGE_ID = 'vault';
export type Params = Readonly<Record<string, string>>;
export type { GroupNode };
export type Entry = EntrySummary;
export type EntryDetail = EntrySummary & {
	notes: string;
	usages: Usage[];
	duplicates: number;
	history: {
		id: number;
		at: string;
		actor: string;
		action: string;
		outcome: string;
		detail: any;
	}[];
};
export type Overview = {
	name: string;
	total: number;
	needs: number;
	groups: GroupNode[];
	root_entries: number;
	recycle_bin: { path: string; count: number } | null;
	provider_alias: string;
};

/** Revealed values (spec §6): each hides again after 15 seconds; all clear on disconnect. */
class Secrets {
	private shown = new Map<string, { value: string; timer: ReturnType<typeof setTimeout> }>();
	private watchers = new Map<string, Set<{ fn: () => void; el: Element }>>();
	get(key: string): string | null {
		return this.shown.get(key)?.value ?? null;
	}
	show(key: string, value: string) {
		this.hide(key, false);
		this.shown.set(key, { value, timer: setTimeout(() => this.hide(key), 15_000) });
		this.notify(key);
	}
	hide(key: string, notify = true) {
		const s = this.shown.get(key);
		if (s) clearTimeout(s.timer);
		this.shown.delete(key);
		if (notify) this.notify(key);
	}
	clear() {
		for (const key of [...this.shown.keys()]) this.hide(key);
	}
	/** Re-render `fn` when the value at `key` shows or hides, while `el` is on the page. */
	watch(key: string, fn: () => void, el: Element) {
		const set = this.watchers.get(key) ?? new Set();
		set.add({ fn, el });
		this.watchers.set(key, set);
	}
	private notify(key: string) {
		for (const w of [...(this.watchers.get(key) ?? [])])
			if (w.el.isConnected) w.fn();
			else this.watchers.get(key)!.delete(w);
	}
}

/** What every part of the page gets: data access, navigation and the current overview. */
export type Ctx = {
	host: ControlUiHost;
	params: Params;
	overview: Overview;
	secrets: Secrets;
	expanded: Set<string>;
	edit: (command: string, body: Record<string, unknown>) => Promise<any>;
	reveal: (
		e: { path: string; uuid: string },
		field: 'Password',
		purpose: 'reveal' | 'copy'
	) => Promise<string>;
	go: (params: Record<string, string | undefined>, opts?: { replace?: boolean }) => void;
	href: (params: Record<string, string | undefined>) => string;
	redraw: () => void;
	track: (handle: { dispose: () => void }) => void;
};

/** The Vault page (spec §9): header, search, group tree, list and entry pane. */
export function mountVault(container: HTMLElement, first: ControlUiViewContext) {
	let context = first;
	const feature = createFeatureClient(contract, context.host);
	const secrets = new Secrets();
	const expanded = new Set<string>();
	let overview: Overview | null = null;
	let entries: Entry[] = [];
	let events: HistoryEvent[] | null = null;
	let detail: EntryDetail | null = null;
	let sheetOpen = false;
	let handles: { dispose: () => void }[] = [];
	let generation = 0;

	const clean = (p: Record<string, string | undefined>) =>
		Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== '')) as Record<
			string,
			string
		>;

	const ctx = (): Ctx => ({
		host: context.host,
		params: context.props,
		overview: overview!,
		secrets,
		expanded,
		edit: async (command, body) => {
			const r: any = await feature.invoke('edit', {
				command,
				idempotency_key: crypto.randomUUID(),
				...body
			} as any);
			if (r?.outcome === 'rejected') throw new Error(r.reason);
			// The form did its job: the next draw replaces it with the saved entry, not keep it.
			shownPane = null;
			void load();
			return r;
		},
		reveal: async (e, field, purpose) => {
			const r: any = await feature.invoke('reveal', {
				path: e.path,
				uuid: e.uuid,
				field,
				purpose
			} as any);
			if (r?.outcome !== 'committed') throw new Error(r?.reason ?? 'Could not read the value');
			return r.value as string;
		},
		go: (params, opts) => {
			closeMenus();
			context.host.navigation.openPage(
				{ id: PAGE_ID, params: clean(params) },
				{ replace: opts?.replace }
			);
		},
		href: (params) => context.host.navigation.pageHref({ id: PAGE_ID, params: clean(params) }),
		redraw: () => draw(),
		track: (handle) => handles.push(handle)
	});

	const root = h('div', { class: 'fv-page' });
	container.append(root);

	// The header and search stay mounted, so typing in the search box survives redraws.
	const search = h('input', {
		class: 'fv-search-input',
		type: 'search',
		placeholder: 'Search entries',
		'aria-label': 'Search entries',
		autocomplete: 'off'
	});
	let typing: ReturnType<typeof setTimeout> | undefined;
	search.addEventListener('input', () => {
		clearTimeout(typing);
		typing = setTimeout(() => {
			const p = context.props;
			ctx().go(
				{ ...(p.q || search.value ? {} : p), q: search.value.trim() || undefined },
				{ replace: !!p.q }
			);
		}, 200);
	});
	const header = h(
		'header',
		{ class: 'fv-header' },
		h('h1', { class: 'fv-title' }, 'Vault'),
		h(
			'div',
			{ class: 'fv-header-actions' },
			h(
				'button',
				{
					class: 'fv-btn fv-btn-quiet fv-desktop',
					type: 'button',
					on: { click: () => overview && newGroupDialog(ctx(), '') }
				},
				'New group'
			),
			h(
				'button',
				{
					class: 'fv-btn fv-btn-primary fv-new',
					type: 'button',
					'aria-label': 'New entry',
					on: {
						click: () =>
							ctx().go({ ...context.props, e: undefined, u: undefined, m: 'new', q: undefined })
					}
				},
				icon('plus'),
				h('span', { class: 'fv-desktop-inline' }, 'New entry')
			)
		)
	);
	const searchBox = h('label', { class: 'fv-search' }, icon('search'), search);
	const body = h('div', { class: 'fv-body' });
	root.append(header, searchBox, body);

	/** What the pane shows, so a data change does not throw away a form being filled in. */
	const paneKey = (p: Params) => `${p.e ?? ''}|${p.u ?? ''}|${p.m ?? ''}|${p.v ?? ''}`;
	let shownPane: string | null = null;
	let pane: HTMLElement | null = null;

	async function load() {
		const mine = ++generation;
		const p = context.props;
		try {
			const ov: any = await feature.invoke('browse', { view: 'overview' } as any);
			if (mine !== generation || context.signal.aborted) return;
			if (ov?.unavailable) return unavailable(ov.unavailable);
			if (p.v === 'history') {
				const r: any = await feature.invoke('browse', {
					view: 'history',
					limit: 200,
					...(p.hp ? { path: p.hp } : {}),
					...(p.ha ? { actor: p.ha } : {}),
					...(p.hx ? { action: p.hx } : {})
				} as any);
				if (mine !== generation || context.signal.aborted) return;
				overview = ov;
				events = r?.events ?? [];
				return draw();
			}
			events = null;
			const [l, d]: any[] = await Promise.all([
				feature.invoke('browse', {
					view: 'list',
					...(p.q
						? { search: p.q }
						: p.v === 'needs'
							? { scope: 'needs' }
							: p.v === 'recycle'
								? { scope: 'recycle' }
								: p.g
									? { scope: 'group', group: p.g }
									: { scope: 'all' })
				} as any),
				p.e
					? feature.invoke('browse', {
							view: 'entry',
							path: p.e,
							...(p.u ? { uuid: p.u } : {})
						} as any)
					: null
			]);
			if (mine !== generation || context.signal.aborted) return;
			overview = ov;
			entries = l?.entries ?? [];
			detail = d && !d.outcome ? d : null;
			draw(d?.outcome === 'rejected' ? d.reason : null);
		} catch (error) {
			if (mine !== generation || context.signal.aborted) return;
			problem((error as Error).message);
		}
	}

	function unavailable(reason: string) {
		root.classList.add('is-unavailable');
		body.className = 'fv-body is-message';
		body.replaceChildren(
			h(
				'div',
				{ class: 'fv-unavailable', role: 'alert' },
				h('h2', { class: 'fv-unavailable-title' }, 'Vault unavailable'),
				h('p', null, reason),
				h('button', { class: 'fv-btn', type: 'button', on: { click: () => load() } }, 'Retry')
			)
		);
	}

	function problem(message: string) {
		body.className = 'fv-body is-message';
		body.replaceChildren(
			h(
				'div',
				{ class: 'fv-error', role: 'alert' },
				h('p', null, message),
				h('button', { class: 'fv-btn', type: 'button', on: { click: () => load() } }, 'Retry')
			)
		);
	}

	/** The phone layout's group button, Needs a value pill and the tree as a bottom sheet. */
	function mobileFilters(c: Ctx) {
		const p = c.params;
		const label =
			p.v === 'history'
				? 'History'
				: p.v === 'needs'
					? 'Needs a value'
					: p.v === 'recycle'
						? 'Recycle Bin'
						: p.g
							? p.g.split('/').join(' / ')
							: 'All entries';
		const sheet = sheetOpen
			? h(
					'div',
					{
						class: 'fv-sheet-wrap',
						on: {
							click: (e: Event) => e.target === e.currentTarget && ((sheetOpen = false), draw())
						}
					},
					h(
						'div',
						{ class: 'fv-sheet', role: 'dialog', 'aria-label': 'Groups' },
						h('div', { class: 'fv-sheet-handle', 'aria-hidden': 'true' }),
						h(
							'div',
							{ class: 'fv-sheet-head' },
							h('strong', null, 'Groups'),
							h(
								'button',
								{
									class: 'fv-btn fv-btn-text',
									type: 'button',
									on: { click: () => newGroupDialog(c, '') }
								},
								'New group'
							)
						),
						tree(c, () => (sheetOpen = false))
					)
				)
			: null;
		return h(
			'div',
			{ class: 'fv-mobile-filters fv-mobile' },
			h(
				'button',
				{
					class: 'fv-group-btn',
					type: 'button',
					'aria-haspopup': 'dialog',
					on: { click: () => ((sheetOpen = true), draw()) }
				},
				h('span', null, label),
				icon('chevronDown', 14)
			),
			c.overview.needs && p.v !== 'needs'
				? h(
						'a',
						{
							class: 'fv-pill',
							href: c.href({ v: 'needs' }),
							on: { click: (e: Event) => (e.preventDefault(), c.go({ v: 'needs' })) }
						},
						h('span', { class: 'fv-dot fv-dot-accent' }),
						`${c.overview.needs} needs a value`
					)
				: null,
			sheet
		);
	}

	function paneFor(c: Ctx, entryProblem: string | null): HTMLElement | null {
		const p = c.params;
		if (p.m === 'new') return entryForm(c, null);
		if (!p.e) return null;
		if (!detail)
			return h(
				'article',
				{ class: 'fv-pane' },
				h(
					'div',
					{ class: 'fv-pane-body' },
					h('p', { class: 'fv-muted' }, entryProblem ?? 'Loading…')
				)
			);
		if (detail.request && !detail.set.Password && p.m !== 'edit') return fillForm(c, detail);
		if (p.m === 'edit') return entryForm(c, detail);
		return entryView(c, detail);
	}

	function draw(entryProblem: string | null = null) {
		if (!overview) return;
		root.classList.remove('is-unavailable');
		const c = ctx();
		const p = c.params;
		search.placeholder = `Search ${overview.total} ${overview.total === 1 ? 'entry' : 'entries'}`;
		if (document.activeElement !== search) search.value = p.q ?? '';
		const key = paneKey(p);
		const editing = !!pane?.querySelector('form, .fv-form') || pane?.tagName === 'FORM';
		// Keep a form being filled in; anything else redraws with the new data.
		if (!(editing && key === shownPane && pane?.isConnected)) {
			for (const x of handles) x.dispose();
			handles = [];
			pane = paneFor(c, entryProblem);
			shownPane = key;
		}
		const hasPane = !!pane;
		body.className = `fv-body${hasPane ? ' has-pane' : ''}`;
		root.classList.toggle('has-pane', hasPane);
		body.replaceChildren(
			h('aside', { class: 'fv-side fv-desktop' }, tree(c)),
			h(
				'div',
				{ class: 'fv-main' },
				mobileFilters(c),
				events ? historyView(c, events) : list(c, entries)
			),
			...(pane ? [pane] : [])
		);
		document.title = `${listTitle(c, entries.length).split(' · ')[0]} · Vault`;
	}

	const onKey = (e: KeyboardEvent) => {
		const typingIn = (e.target as HTMLElement | null)?.closest?.('input, textarea, select');
		if (e.key === 'Escape' && !typingIn && (context.props.e || context.props.m))
			ctx().go({ ...context.props, e: undefined, u: undefined, m: undefined });
	};
	document.addEventListener('keydown', onKey);
	// A revealed value is cleared when the UI disconnects (spec §6).
	const offHost = context.host.subscribe(() => {
		if (!context.host.connection.connected) secrets.clear();
	});
	const off = feature.on('changed', () => void load());
	void load();
	return {
		update(next: ControlUiViewContext) {
			const before = context.props;
			context = next;
			if (paneKey(before) !== paneKey(next.props)) secrets.clear();
			void load();
		},
		dispose() {
			off();
			offHost();
			secrets.clear();
			clearTimeout(typing);
			for (const x of handles) x.dispose();
			document.removeEventListener('keydown', onKey);
			root.remove();
		}
	};
}
