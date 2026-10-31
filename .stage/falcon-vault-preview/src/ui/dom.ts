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

/** Stroke icons (Lucide shapes), drawn in the current text colour. */
const ICONS = {
	search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
	eyeOff:
		'<path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/>',
	copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
	more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
	chevronDown: '<path d="m6 9 6 6 6-6"/>',
	chevronRight: '<path d="m9 6 6 6-6 6"/>',
	back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
	trash:
		'<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
	refresh:
		'<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
	x: '<path d="M18 6 6 18M6 6l12 12"/>',
	external:
		'<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
	history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'
} as const;
export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16) {
	const span = h('span', { class: `fv-icon fv-icon-${name}`, 'aria-hidden': 'true' });
	span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
	return span;
}

/** A quiet square button holding only an icon. */
export const iconButton = (
	name: IconName,
	label: string,
	onClick: (e: Event) => void,
	extra = ''
) =>
	h(
		'button',
		{
			class: `fv-icon-btn ${extra}`.trim(),
			type: 'button',
			title: label,
			'aria-label': label,
			on: { click: onClick }
		},
		icon(name)
	);

/** "2 min ago" within a day, then "Sep 30". */
export function ago(iso?: string | null): string {
	if (!iso) return '';
	const ms = Date.now() - Date.parse(iso);
	if (ms < 60_000) return 'just now';
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
	return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** `person:fred` / `agent:verl` / `resolver` → `fred` / `Verl` / `OpenClaw`. */
export function who(ref?: string | null): string {
	const r = ref ?? '';
	if (r === 'resolver') return 'OpenClaw';
	if (r.startsWith('agent:')) {
		const id = r.slice(6);
		return id.charAt(0).toUpperCase() + id.slice(1);
	}
	return r.replace(/^person:/, '').replace('gateway-owner', 'You');
}

/** The host part of a URL, for the list's second line. */
export function host(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

/** A path for people: `Services/Cloudflare` → `Services / Cloudflare`. */
export const shownPath = (path: string) => path.split('/').join(' / ');

/** A one-letter avatar for an agent or person. */
export const avatar = (ref?: string | null) =>
	h('span', { class: 'fv-avatar', title: who(ref) }, who(ref).slice(0, 1).toUpperCase() || '?');
