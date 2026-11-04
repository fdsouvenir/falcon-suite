// Minimal DOM helpers. The UI owns its DOM (no framework) and uses only host theme variables.

export type Child = Node | string | number | null | undefined | false | Child[];
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

/** Children separated by a middle dot, skipping empty ones. */
export const dotted = (...parts: Child[]): Child[] =>
	parts
		.filter((p) => p !== null && p !== undefined && p !== false && p !== '')
		.flatMap((p, i) => (i ? [' · ', p] : [p]));

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "Oct 26", with the year when it is not this year. */
export const day = (iso?: string | null) => {
	if (!iso) return '';
	const d = new Date(iso);
	return d.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {})
	});
};

/** "Nov 2, 6:10 PM". */
export const dayTime = (iso?: string | null) =>
	iso
		? `${day(iso)}, ${new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
		: '';

/** "now", "12m ago", "2h ago", "yesterday", "Oct 26". */
export const ago = (iso?: string | null) => {
	if (!iso) return '';
	const then = new Date(iso);
	const now = new Date();
	const minutes = Math.floor((now.getTime() - then.getTime()) / 6e4);
	if (minutes < 1) return 'now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24 && (sameDay(then, now) || hours < 6)) return `${hours}h ago`;
	if (sameDay(then, new Date(now.getTime() - 864e5))) return 'yesterday';
	return day(iso);
};

/** `agent:william` → William, `work:clerk` → Falcon Work, the owner → you. */
export const who = (ref: string | null | undefined, owner: string | null = null) => {
	if (!ref) return '';
	if (ref === 'work:clerk' || ref === 'clerk') return 'Falcon Work';
	if (ref.startsWith('person:')) return owner && ref === owner ? 'you' : ref.slice(7);
	const id = ref.replace(/^agent:/, '');
	return id.charAt(0).toUpperCase() + id.slice(1);
};

/** "1 session", "3 sessions". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ICONS = {
	check:
		'<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 8.2l1.9 1.9 3.7-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
	tick: '<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
	bolt: '<path d="M9 1.75L3.5 9h4l-.5 5.25L12.5 7h-4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
	back: '<path d="M13 8H3.5M7.5 4L3.5 8l4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
	search:
		'<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
	close:
		'<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
	chevron:
		'<path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
} as const;

/** A small inline icon drawn in the current text colour. */
export const icon = (name: keyof typeof ICONS) => {
	const el = h('span', { class: `fw-icon fw-icon-${name}`, 'aria-hidden': 'true' });
	el.innerHTML = `<svg viewBox="0 0 16 16" width="1em" height="1em">${ICONS[name]}</svg>`;
	return el;
};
