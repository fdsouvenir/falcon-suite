// SemVer comparison for CLI versions. A git-describe suffix (`-N-gHASH`) marks a build
// N commits after its tag, so it sorts after that tag instead of before it.
type Parsed = { core: number[]; pre: string[] | null; describe: boolean };
function parse(value: string): Parsed | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
	if (!m) return null;
	const describe = !!m[4] && /^\d+-g[0-9a-f]+$/.test(m[4]);
	return { core: [+m[1], +m[2], +m[3]], pre: m[4] && !describe ? m[4].split('.') : null, describe };
}
export function compareVersions(a: string, b: string): number | null {
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return null;
	for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
	const rank = (v: Parsed) => (v.pre ? -1 : v.describe ? 1 : 0);
	if (rank(x) !== rank(y) || !x.pre || !y.pre) return rank(x) - rank(y);
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const [p, q] = [x.pre[i], y.pre[i]];
		if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
		if (p === q) continue;
		const [np, nq] = [/^\d+$/.test(p), /^\d+$/.test(q)];
		if (np && nq) return +p - +q;
		if (np !== nq) return np ? -1 : 1;
		return p < q ? -1 : 1;
	}
	return 0;
}
