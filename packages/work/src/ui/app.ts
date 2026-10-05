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
			render();
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
		refresh: () => render()
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

	async function render() {
		const mine = ++generation;
		const c = ctx();
		let body: Node;
		try {
			const p = c.params;
			body = p.project
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
			body = h(
				'div',
				{ class: 'fw-error', role: 'alert' },
				h('p', null, String((error as Error).message ?? error)),
				h('button', { class: 'fw-btn', on: { click: () => render() } }, 'Retry')
			);
		}
		const panel = c.params.panel
			? await panelView(c, c.params.panel).catch((e) =>
					h('aside', { class: 'fw-panel' }, String(e))
				)
			: null;
		if (mine !== generation || context.signal.aborted) return;
		root.replaceChildren(
			header(c),
			h(
				'div',
				{ class: `fw-body${panel ? ' has-panel' : ''}` },
				h('main', { class: 'fw-main' }, body),
				panel
			)
		);
	}

	const off = feature.on('changed', () => render());
	render();
	return {
		update(next: ControlUiViewContext) {
			context = next;
			render();
		},
		dispose() {
			off();
			sessions.dispose();
			root.remove();
		}
	};
}

export { who };
