import type { ControlUiHost, ControlUiViewContext } from 'openclaw/plugin-sdk/control-ui';
import { createFeatureClient } from 'openclaw/plugin-sdk/feature-contract';
import { contract } from '../contract.js';
import { h } from './dom.js';
import { sessionChip } from './parts.js';
import type { ItemRef } from './types.js';
import { homeView } from './views/home.js';
import { projectView } from './views/project.js';
import { taskView } from './views/task.js';
import { jobView } from './views/job.js';
import { searchView } from './views/search.js';

export const PAGE_ID = 'work';
export type Params = Readonly<Record<string, string>>;
type ReadInput = {
	view: 'home' | 'project' | 'task' | 'job' | 'search';
	id?: string;
	text?: string;
	since?: string;
};

/** A session as the chips show it; `undefined` while the session list is still loading. */
export type SessionInfo = { title: string; active: boolean } | null | undefined;

/**
 * What every view gets: data access, navigation and sessions. The pages are read-only, apart from
 * dismissing an ask on Needs you.
 */
export type Ctx = {
	host: ControlUiHost;
	signal: AbortSignal;
	params: Params;
	/** When the person was last here before this visit (from this browser). */
	lastVisit: string | null;
	/** The person this Gateway's Work belongs to, when the read says so. */
	owner: string | null;
	read: <T>(input: ReadInput) => Promise<T>;
	/** Dismiss an ask on Needs you (the only change the page makes). */
	dismiss: (ask: { kind: 'question' | 'decision'; id: string }) => Promise<void>;
	go: (params: Record<string, string | undefined>) => void;
	href: (params: Record<string, string | undefined>) => string;
	open: (ref: Pick<ItemRef, 'id' | 'kind'>) => void;
	hrefFor: (ref: Pick<ItemRef, 'id' | 'kind'>) => string;
	session: (key: string) => SessionInfo;
	openSession: (key: string) => void;
	/** Remembered open/closed state of expanders and Needs you groups across redraws. */
	expanded: Set<string>;
};

const LAST_VISIT = 'falcon-work:last-visit';

/** Read the previous visit and remember this one. */
function visit(): string | null {
	try {
		const previous = localStorage.getItem(LAST_VISIT);
		localStorage.setItem(LAST_VISIT, new Date().toISOString());
		return previous && !Number.isNaN(Date.parse(previous)) ? previous : null;
	} catch {
		return null;
	}
}

/** The Work page: routes on page params to Home, a Project, Task or Job, or search results. */
export function mountWork(container: HTMLElement, first: ControlUiViewContext) {
	let context = first;
	const feature = createFeatureClient(contract, context.host);
	const lastVisit = visit();
	const expanded = new Set<string>();
	let owner: string | null = null;
	const root = h('div', { class: 'fw-page' });
	container.append(root);

	// Session titles for the chips. A session missing from the list once it has loaded is gone.
	const sessions = new Map<string, { title: string; active: boolean }>();
	let sessionsLoaded = false;
	const watch = context.host.sessions.observe(
		{ includeDerivedTitles: true, limit: 500 },
		(snap) => {
			if (!snap.result) return;
			sessions.clear();
			for (const s of snap.result.sessions)
				sessions.set(s.key, {
					title: s.label ?? s.displayName ?? s.derivedTitle ?? s.key,
					active: !!s.hasActiveRun
				});
			sessionsLoaded = true;
			repaintChips();
		}
	);

	let generation = 0;
	let shown: string | null = null;

	const clean = (p: Record<string, string | undefined>) =>
		Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== '')) as Record<
			string,
			string
		>;
	const target = (ref: Pick<ItemRef, 'id' | 'kind'>) => ({ [ref.kind]: ref.id });

	// A function declaration: the session observer may call back before this point is reached.
	function ctx(): Ctx {
		return {
			host: context.host,
			signal: context.signal,
			params: context.props,
			lastVisit,
			owner,
			read: async <T>(input: ReadInput) => {
				const r: unknown = await feature.invoke('read', input as never);
				const o = r && typeof r === 'object' ? (r as { owner?: unknown }).owner : undefined;
				if (typeof o === 'string') owner = o;
				return r as T;
			},
			dismiss: async (ask) => {
				const r: any = await feature.invoke('do', {
					command: ask.kind === 'question' ? 'withdraw_question' : 'withdraw_decision',
					id: ask.id,
					input: { reason: 'Dismissed from Needs you' }
				} as never);
				if (r?.outcome === 'rejected') throw new Error(r.reason ?? 'Could not dismiss');
			},
			go: (params) => context.host.navigation.openPage({ id: PAGE_ID, params: clean(params) }),
			href: (params) => context.host.navigation.pageHref({ id: PAGE_ID, params: clean(params) }),
			open: (ref) => context.host.navigation.openPage({ id: PAGE_ID, params: target(ref) }),
			hrefFor: (ref) => context.host.navigation.pageHref({ id: PAGE_ID, params: target(ref) }),
			session: (key) => sessions.get(key) ?? (sessionsLoaded ? null : undefined),
			openSession: (key) => {
				const agentId = /^agent:([^:]+):/.exec(key)?.[1];
				context.host.sessions.open({ sessionKey: key, ...(agentId ? { agentId } : {}) });
			},
			expanded
		};
	}

	// Chips carry their session key; when titles arrive or change, each one is redrawn in place.
	function repaintChips() {
		const c = ctx();
		for (const el of root.querySelectorAll<HTMLElement>('[data-session]'))
			el.replaceWith(sessionChip(c, el.dataset.session!, el.dataset.at ?? null));
		// Needs you groups by session, so it redraws itself once titles and missing sessions are known.
		for (const el of root.querySelectorAll<HTMLElement>('[data-needs]'))
			(el as HTMLElement & { repaint?: (c: Ctx) => void }).repaint?.(c);
	}

	async function page(c: Ctx): Promise<Node> {
		try {
			const p = c.params;
			return p.project
				? await projectView(c, p.project)
				: p.task
					? await taskView(c, p.task)
					: p.job
						? await jobView(c, p.job)
						: p.q !== undefined
							? await searchView(c, p.q)
							: await homeView(c);
		} catch (error) {
			return h(
				'div',
				{ class: 'fw-error', role: 'alert' },
				h('p', null, String((error as Error).message ?? error))
			);
		}
	}

	// The host scrolls an inner element, not the window; a new page starts at its top.
	const scroller = () => {
		for (let el = container.parentElement; el; el = el.parentElement)
			if (/auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
		return null;
	};

	async function render() {
		const mine = ++generation;
		const c = ctx();
		const key = JSON.stringify(Object.entries(c.params).sort());
		const body = await page(c);
		if (mine !== generation || context.signal.aborted) return;
		// Keep what is being typed in the search field when only the data changed.
		const typing = root.querySelector<HTMLInputElement>('.fw-search-input');
		const keep = typing && typing === document.activeElement ? typing : null;
		root.replaceChildren(body);
		if (keep) {
			const next = root.querySelector<HTMLInputElement>('.fw-search-input');
			if (next) {
				next.value = keep.value;
				next.focus();
				next.setSelectionRange(keep.selectionStart, keep.selectionEnd);
			}
		}
		if (key !== shown && shown !== null) {
			const s = scroller();
			if (s) s.scrollTop = 0;
		}
		shown = key;
	}

	const off = feature.on('changed', () => void render());
	void render();
	return {
		update(next: ControlUiViewContext) {
			context = next;
			void render();
		},
		dispose() {
			off();
			watch.dispose();
			root.remove();
		}
	};
}
