// Minimal DOM helpers. The UI owns its DOM (no framework) and uses only host theme variables.

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; on?: Record<string, (e: Event) => void> };

export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Attrs | null = null,
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs ?? {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k === 'on')
			for (const [ev, fn] of Object.entries(v as Record<string, EventListener>))
				el.addEventListener(ev, fn);
		else if (k === 'class') el.className = String(v);
		else if (k in el && typeof v !== 'string') (el as any)[k] = v;
		else el.setAttribute(k, v === true ? '' : String(v));
	}
	append(el, children);
	return el;
}

function append(el: Node, children: Child[]) {
	for (const c of children) {
		if (c === null || c === undefined || c === false) continue;
		if (Array.isArray(c)) append(el, c);
		else
			el.appendChild(
				typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c
			);
	}
}

export const day = (iso?: string | null) =>
	iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
export const time = (iso?: string | null) =>
	iso
		? new Date(iso).toLocaleTimeString(undefined, {
				hour: '2-digit',
				minute: '2-digit',
				hour12: false
			})
		: '';
export const since = (iso?: string | null) => {
	if (!iso) return '';
	const days = Math.floor((Date.now() - Date.parse(iso)) / 864e5);
	return days <= 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
};
/** `person:abc` / `agent:verl` → `abc` / `verl`. */
export const who = (ref?: string | null) => (ref ?? '').replace(/^(person|agent):/, '');

/** A one-letter avatar for an agent or person. */
export const avatar = (ref?: string | null) =>
	h('span', { class: 'fw-avatar', title: who(ref) }, who(ref).slice(0, 1).toUpperCase() || '?');

export const icon = (
	name: 'warn' | 'question' | 'decision' | 'check' | 'circle' | 'half' | 'clock' | 'arrow' | 'x'
) =>
	h(
		'span',
		{ class: `fw-icon fw-icon-${name}`, 'aria-hidden': 'true' },
		{
			warn: '⚠',
			question: '?',
			decision: '⑂',
			check: '✓',
			circle: '○',
			half: '◐',
			clock: '◷',
			arrow: '→',
			x: '✕'
		}[name]
	);

export const statusIcon = (status: string) =>
	status === 'completed'
		? icon('check')
		: status === 'in_progress'
			? icon('half')
			: status === 'waiting'
				? icon('clock')
				: icon('circle');

export const section = (title: string, count: number | null, ...body: Child[]) =>
	h(
		'section',
		{ class: 'fw-section' },
		h(
			'h2',
			{ class: 'fw-section-title' },
			title,
			count !== null ? h('span', { class: 'fw-count' }, String(count)) : null
		),
		...body
	);

export const empty = (text: string) => h('p', { class: 'fw-empty' }, text);

/** What kind of thing this is (Objective, Project, Task…), in small caps above or before its name. */
export const kicker = (kind: string) => h('span', { class: 'fw-kicker' }, kind);

/** An Objective's rank, written out so it does not read like an issue number. */
export const rank = (n?: number | null) =>
	n ? h('span', { class: 'fw-rank' }, `Rank ${n}`) : null;
