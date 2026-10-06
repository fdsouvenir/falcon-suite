import type { ControlUiHost, ControlUiViewContext } from 'openclaw/plugin-sdk/control-ui';
import { createFeatureClient } from 'openclaw/plugin-sdk/feature-contract';
import { contract } from '../contract.js';
import { h, who } from './dom.js';
import { overviewView } from './views/overview.js';
import { objectivesView, objectiveView } from './views/objectives.js';
import { areasView, projectView } from './views/areas.js';
import { activityView } from './views/activity.js';
import { panelView } from './views/panel.js';

export const PAGE_ID = 'work';
export type Params = Readonly<Record<string, string>>;

/** What every view gets: data access, navigation, sessions and a way to refresh. */
export type Ctx = {
	host: ControlUiHost;
	signal: AbortSignal;
	params: Params;
	read: (input: Record<string, unknown>) => Promise<any>;
	act: (
		command: string,
		id: string | undefined,
		input: Record<string, unknown>,
		version?: number
	) => Promise<any>;
	go: (params: Record<string, string | undefined>, opts?: { replace?: boolean }) => void;
	href: (params: Record<string, string | undefined>) => string;
	sessionTitle: (key: string) => string | null;
	openSession: (key: string) => void;
	refresh: () => void;
};

const TABS = [
	{ id: 'overview', label: 'Overview' },
	{ id: 'objectives', label: 'Objectives' },
	{ id: 'areas', label: 'Areas & Projects' },
	{ id: 'activity', label: 'Activity' }
] as const;

/** The Work page: header, tabs, the routed view and the side panel. */
export function mountWork(container: HTMLElement, first: ControlUiViewContext) {
	let context = first;
	const feature = createFeatureClient(contract, context.host);
	const titles = new Map<string, string>();
	let needsYouCount: number | null = null;

	const sessions = context.host.sessions.observe(
		{ includeDerivedTitles: true, limit: 200 },
		(snap) => {
			for (const s of snap.result?.sessions ?? []) {
				const row = s as unknown as {
					key: string;
					label?: string;
					displayName?: string;
					derivedTitle?: string;
				};
				titles.set(row.key, row.label ?? row.displayName ?? row.derivedTitle ?? row.key);
			}
		}
	);

	const root = h('div', { class: 'fw-page' });
	container.append(root);
	let generation = 0;

	const clean = (p: Record<string, string | undefined>) =>
		Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== '')) as Record<
			string,
			string
		>;

	const ctx = (): Ctx => ({
		host: context.host,
		signal: context.signal,
		params: context.props,
		read: (input) => feature.invoke('read', input as any),
		act: async (command, id, input, version) => {
			const request = {
				command,
				...(id ? { id } : {}),
				...(version ? { expected_version: version } : {}),
				input
			};
			const r: any = await feature.invoke('do', request as any);
			if (r?.outcome === 'rejected') throw new Error(r.reason);
			render(true);
			return r;
		},
		go: (params, opts) =>
			context.host.navigation.openPage(
				{ id: PAGE_ID, params: clean(params) },
				{ replace: opts?.replace }
			),
		href: (params) => context.host.navigation.pageHref({ id: PAGE_ID, params: clean(params) }),
		sessionTitle: (key) => titles.get(key) ?? null,
		openSession: (key) => {
			const agentId = /^agent:([^:]+):/.exec(key)?.[1];
			context.host.sessions.open({ sessionKey: key, ...(agentId ? { agentId } : {}) } as any);
		},
		refresh: () => render(true)
	});

	function header(c: Ctx) {
		const tab = c.params.tab ?? 'overview';
		const search = h('input', {
			class: 'fw-search',
			type: 'search',
			placeholder: 'Search work…',
			'aria-label': 'Search work',
			value: c.params.q ?? ''
		});
		search.addEventListener('change', () => c.go({ tab: 'areas', q: search.value || undefined }));
		return h(
			'header',
			{ class: 'fw-header' },
			h(
				'div',
				{ class: 'fw-header-row' },
				h('h1', { class: 'fw-title' }, 'Work'),
				h('div', { class: 'fw-toolbar' }, search)
			),
			h(
				'nav',
				{ class: 'fw-tabs', 'aria-label': 'Work views' },
				TABS.map((t) =>
					h(
						'a',
						{
							class: `fw-tab${tab === t.id && !c.params.project && !c.params.objective ? ' is-active' : ''}`,
							href: c.href({ tab: t.id }),
							on: { click: (e: Event) => (e.preventDefault(), c.go({ tab: t.id })) }
						},
						t.label,
						t.id === 'overview' && needsYouCount
							? h('span', { class: 'fw-count' }, String(needsYouCount))
							: null
					)
				)
			)
		);
	}

	async function page(c: Ctx): Promise<Node> {
		try {
			const p = c.params;
			return p.project
				? await projectView(c, p.project)
				: p.objective
					? await objectiveView(c, p.objective)
					: p.tab === 'objectives'
						? await objectivesView(c)
						: p.tab === 'areas'
							? await areasView(c)
							: p.tab === 'activity'
								? await activityView(c)
								: await overviewView(c, (n) => (needsYouCount = n));
		} catch (error) {
			return h(
				'div',
				{ class: 'fw-error', role: 'alert' },
				h('p', null, String((error as Error).message ?? error)),
				h('button', { class: 'fw-btn', on: { click: () => render(true) } }, 'Retry')
			);
		}
	}

	// The header, page and drawer stay mounted. Opening or switching a panel redraws only the
	// drawer; navigating redraws the page; a data change redraws both in place.
	const main = h('main', { class: 'fw-main' });
	const drawer = h('div', { class: 'fw-drawer' });
	let head: HTMLElement | null = null;
	let shownPage: string | null = null;
	let shownPanel: string | null = null;
	let stale = false; // data changed since the shown page and panel were read
	root.append(h('div', { class: 'fw-body' }, main, drawer));

	const pageKey = (p: Params) =>
		JSON.stringify(
			Object.entries(p)
				.filter(([k]) => k !== 'panel')
				.sort()
		);

	async function render(fresh = false) {
		const mine = ++generation;
		if (fresh) stale = true;
		const c = ctx();
		const key = pageKey(c.params);
		const panelId = c.params.panel ?? null;
		const newPage = stale || key !== shownPage;
		const newPanel = panelId !== null && (newPage || panelId !== shownPanel);
		if (newPanel && panelId !== shownPanel) drawer.classList.add('is-loading');
		const [body, panel] = await Promise.all([
			newPage ? page(c) : null,
			newPanel
				? panelView(c, panelId).catch((e) => h('aside', { class: 'fw-panel' }, String(e)))
				: null
		]);
		if (mine !== generation || context.signal.aborted) return;
		if (body) {
			// Keep the search box (and what is typed in it) when only the data changed.
			if (key !== shownPage || !head?.contains(document.activeElement)) {
				const next = header(c);
				head ? head.replaceWith(next) : root.prepend(next);
				head = next;
			}
			main.replaceChildren(body);
			shownPage = key;
			stale = false;
		}
		if (panel) drawer.replaceChildren(panel);
		else if (!panelId) drawer.replaceChildren();
		drawer.classList.remove('is-loading');
		drawer.classList.toggle('is-open', panelId !== null);
		shownPanel = panelId;
		for (const row of main.querySelectorAll<HTMLElement>('[data-panel]'))
			row.classList.toggle('is-selected', row.dataset.panel === panelId);
	}

	const onKey = (e: KeyboardEvent) => {
		const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, select');
		if (e.key === 'Escape' && context.props.panel && !typing)
			ctx().go({ ...context.props, panel: undefined });
	};
	document.addEventListener('keydown', onKey);
	const off = feature.on('changed', () => render(true));
	render();
	return {
		update(next: ControlUiViewContext) {
			context = next;
			render();
		},
		dispose() {
			off();
			document.removeEventListener('keydown', onKey);
			sessions.dispose();
			root.remove();
		}
	};
}

export { who };
