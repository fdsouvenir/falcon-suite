/**
 * Every read the Gateway carries must be bounded JSON (OpenClaw's plugin limits: 4,096 values,
 * 256 KB, depth 32, 512 keys per object, 64K characters per string). A larger answer is refused
 * outright, so the views size themselves to a budget, and `bounded` is the last guard: it shortens
 * the largest lists until the answer fits, and says which lists it shortened.
 */

/** OpenClaw's limits, less a margin for the envelope the Gateway adds. */
export const LIMITS = {
	nodes: 3900,
	bytes: 240_000,
	depth: 30,
	keys: 500,
	string: 60_000
};

export type Size = { nodes: number; bytes: number };

/** Values (as the Gateway counts them) and serialized bytes of a JSON value. */
export function size(value: unknown): Size {
	let nodes = 0;
	const walk = (v: unknown) => {
		nodes++;
		if (Array.isArray(v)) for (const x of v) walk(x);
		else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
	};
	walk(value);
	let bytes = 0;
	try {
		bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
	} catch {
		bytes = Infinity;
	}
	return { nodes, bytes };
}

function within(value: unknown): boolean {
	let ok = true;
	const walk = (v: unknown, depth: number) => {
		if (!ok) return;
		if (depth > LIMITS.depth) return void (ok = false);
		if (typeof v === 'string') {
			if (v.length > LIMITS.string) ok = false;
		} else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
		else if (v && typeof v === 'object') {
			const entries = Object.entries(v);
			if (entries.length > LIMITS.keys) return void (ok = false);
			for (const [, x] of entries) walk(x, depth + 1);
		}
	};
	walk(value, 0);
	if (!ok) return false;
	const s = size(value);
	return s.nodes <= LIMITS.nodes && s.bytes <= LIMITS.bytes;
}

/** Does this value fit what the Gateway carries? */
export const fits = within;

/**
 * The leading items, in order, that fit a budget of values and bytes (and at most `max` of them).
 * The first item is always taken, so paging through a list always moves on.
 */
export function take<T>(items: readonly T[], budget: Size, max = Infinity): T[] {
	const out: T[] = [];
	let nodes = 1;
	let bytes = 2;
	for (const item of items) {
		if (out.length >= max) break;
		const s = size(item);
		if (out.length && (nodes + s.nodes > budget.nodes || bytes + s.bytes + 1 > budget.bytes)) break;
		nodes += s.nodes;
		bytes += s.bytes + 1;
		out.push(item);
	}
	return out;
}

const clip = (s: string) => (s.length > LIMITS.string ? `${s.slice(0, LIMITS.string - 1)}…` : s);

/**
 * The last guard on every read: if the answer would not fit, halve its largest list (then the next
 * largest) until it does, and name the shortened lists in `truncated`. Overlong strings are clipped.
 * A view that sizes itself never reaches this; it is for records nobody planned for.
 */
export function bounded<T>(value: T): T {
	if (within(value)) return value;
	const copy = JSON.parse(
		JSON.stringify(value, (_k, v) => (typeof v === 'string' ? clip(v) : v)) ?? 'null'
	) as unknown;
	const truncated = new Set<string>();
	for (let round = 0; round < 200 && !within(copy); round++) {
		let worst: { list: unknown[]; path: string; nodes: number } | null = null;
		const walk = (v: unknown, path: string) => {
			if (Array.isArray(v)) {
				if (v.length > 1) {
					const n = size(v).nodes;
					if (!worst || n > worst.nodes) worst = { list: v, path, nodes: n };
				}
				v.forEach((x, i) => walk(x, `${path}[${i}]`));
			} else if (v && typeof v === 'object')
				for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
		};
		walk(copy, '');
		if (!worst) break;
		const w = worst as { list: unknown[]; path: string };
		w.list.length = Math.max(1, Math.floor(w.list.length / 2));
		truncated.add(w.path.replace(/\[\d+\]/g, '[]') || '(list)');
	}
	if (!within(copy)) return { error: 'too_large', truncated: [...truncated] } as T;
	if (copy && typeof copy === 'object' && !Array.isArray(copy))
		return { ...(copy as object), truncated: [...truncated] } as T;
	return { items: copy, truncated: [...truncated] } as T;
}
