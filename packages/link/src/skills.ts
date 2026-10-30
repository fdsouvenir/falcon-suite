// A provider's official agent skills, installed once into OpenClaw's shared managed skills
// directory so every agent on the Office has them. Link installs each skill directory with
// native `openclaw skills install <dir> --as <prefix><slug> --global` from a pinned commit
// and removes only skills it installed.
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { provider as providerOf } from './providers/index.js';
import type { SkillSource } from './providers/types.js';

export type SkillsStatus = {
	state: 'installed' | 'update_available' | 'not_installed' | 'unavailable';
	source: string;
	commit: string | null;
	latest: string | null;
	count: number;
	message: string;
};
type Receipt = {
	repo: string;
	commit: string | null;
	skills: string[];
	installed_at: string;
	removed?: boolean;
};
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HOUR = 60 * 60 * 1000;
// OpenClaw's state directory holds Link's own directory and the shared managed skills.
const stateDir = (dir: string) => path.dirname(dir);
const managed = (dir: string) => path.join(stateDir(dir), 'skills');
const staging = (dir: string) => path.join(dir, 'skills');
const receiptFile = (dir: string, id: string) => path.join(staging(dir), `${id}.json`);
function source(id: string): SkillSource {
	const s = providerOf(id).skills;
	if (!s) throw new Error('This integration has no skills.');
	return s;
}
function readReceipt(dir: string, id: string): Receipt | null {
	try {
		return JSON.parse(readFileSync(receiptFile(dir, id), 'utf8'));
	} catch {
		return null;
	}
}
async function writeReceipt(dir: string, id: string, receipt: Receipt) {
	await mkdir(staging(dir), { recursive: true, mode: 0o700 });
	const pending = `${receiptFile(dir, id)}.${process.pid}.tmp`;
	await writeFile(pending, JSON.stringify(receipt), { mode: 0o600 });
	await rename(pending, receiptFile(dir, id));
}
// The OpenClaw command that runs this Gateway: on PATH, or this process's own entry point.
function openclaw(): string[] | null {
	for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!path.isAbsolute(folder)) continue;
		const candidate = path.join(folder, 'openclaw');
		try {
			accessSync(candidate, constants.X_OK);
			return [candidate];
		} catch {}
	}
	const entry = process.argv[1];
	return entry && /[\\/]openclaw(?:\.mjs)?$/.test(entry) ? [process.execPath, entry] : null;
}
async function github(url: string) {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(30000),
		headers: { Accept: 'application/vnd.github+json' }
	});
	if (!response.ok) throw new Error('The skills source could not be reached. Try again later.');
	return response;
}
const latest = new Map<string, { at: number; commit: string | null }>();
export async function latestCommit(id: string, fresh = false) {
	const cached = latest.get(id);
	if (cached && Date.now() - cached.at < HOUR && !fresh) return cached.commit;
	const s = source(id);
	let commit: string | null = null;
	try {
		const out = (await (
			await github(`https://api.github.com/repos/${s.repo}/commits/${s.branch}`)
		).json()) as { sha?: unknown };
		if (typeof out.sha === 'string' && /^[a-f0-9]{40}$/.test(out.sha)) commit = out.sha;
	} catch {}
	latest.set(id, { at: Date.now(), commit });
	return commit;
}
// A skill counts as Link's only when OpenClaw recorded Link's staging copy as its source.
function ours(dir: string, name: string) {
	try {
		const origin = JSON.parse(
			readFileSync(path.join(managed(dir), name, '.openclaw', 'source-origin.json'), 'utf8')
		);
		return (
			origin.slug === name &&
			origin.source === 'path' &&
			typeof origin.spec === 'string' &&
			origin.spec.startsWith(staging(dir) + path.sep)
		);
	} catch {
		return false;
	}
}
export async function skillsStatus(dir: string, id: string): Promise<SkillsStatus> {
	const s = source(id);
	const receipt = readReceipt(dir, id);
	const present = (receipt?.skills ?? []).filter((n) =>
		existsSync(path.join(managed(dir), n, 'SKILL.md'))
	);
	const installed =
		!!receipt?.commit && present.length > 0 && present.length === receipt.skills.length;
	const commit = await latestCommit(id);
	const base = {
		source: s.repo,
		commit: receipt?.commit ?? null,
		latest: commit,
		count: present.length
	};
	if (!installed && !openclaw())
		return {
			...base,
			state: 'unavailable',
			message: "Skills can't be installed here because the openclaw command isn't available."
		};
	return {
		...base,
		state: !installed
			? 'not_installed'
			: commit && commit !== receipt!.commit
				? 'update_available'
				: 'installed',
		message: ''
	};
}
function exec(command: string[], env: NodeJS.ProcessEnv, timeout = 60000) {
	return new Promise<void>((resolve, reject) =>
		execFile(
			command[0],
			command.slice(1),
			{ env, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' },
			(err) => (err ? reject(new Error('Skill installation failed.')) : resolve())
		)
	);
}
// Every extracted entry must be an ordinary file or folder inside the stage.
async function plainTree(root: string) {
	for (const entry of await readdir(root)) {
		const full = path.join(root, entry);
		const stat = await lstat(full);
		if (stat.isDirectory()) await plainTree(full);
		else if (!stat.isFile())
			throw new Error('The skills download contains links or special files.');
	}
}
// Names the skill after its install slug, the only change to the provider's text, and says so.
function renamed(text: string, name: string) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m) throw new Error('A skill is missing its description header.');
	const original = /^name:\s*(.*)$/m.exec(m[1])?.[1].trim() ?? '';
	const body = /^name:.*$/m.test(m[1])
		? m[1].replace(/^name:.*$/m, `name: ${name}`)
		: `name: ${name}\n${m[1]}`;
	const note = `# Falcon Link renamed this skill from "${original.replace(/["\r\n]/g, '')}" to "${name}"; the rest is unchanged.`;
	return `---\n${body}\n${note}\n---${text.slice(m[0].length)}`;
}
const busy = new Set<string>();
export async function installSkills(dir: string, id: string) {
	const s = source(id);
	const command = openclaw();
	if (!command)
		throw new Error("Skills can't be installed here because the openclaw command isn't available.");
	if (busy.has(id)) throw new Error('Skill installation is already running.');
	busy.add(id);
	await mkdir(staging(dir), { recursive: true, mode: 0o700 });
	const stage = await mkdtemp(path.join(staging(dir), '.stage-'));
	try {
		const commit = await latestCommit(id, true);
		if (!commit) throw new Error('The skills source could not be reached. Try again later.');
		const response = await github(`https://api.github.com/repos/${s.repo}/tarball/${commit}`);
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length > 32 * 1024 * 1024) throw new Error('The skills download is too large.');
		const archive = path.join(stage, 'source.tar.gz');
		await writeFile(archive, bytes, { mode: 0o600 });
		const listed = await new Promise<string[]>((resolve, reject) =>
			execFile('tar', ['-tzf', archive], { maxBuffer: 8 * 1024 * 1024 }, (err, out) =>
				err
					? reject(new Error('The skills download could not be read.'))
					: resolve(out.trim().split('\n'))
			)
		);
		// GitHub names the single top folder <owner>-<repo>-<short commit>.
		const top = listed[0]?.split('/')[0] ?? '';
		if (
			!top.endsWith(`-${commit.slice(0, 7)}`) ||
			listed.some(
				(e) => e.startsWith('/') || e.split('/')[0] !== top || e.split('/').includes('..')
			)
		)
			throw new Error('The skills download did not match the expected source.');
		const extracted = path.join(stage, 'source');
		await mkdir(extracted);
		await exec(['tar', '-xzf', archive, '-C', extracted, '--no-same-owner'], process.env);
		await plainTree(extracted);
		const repository = path.join(extracted, top);
		const root = path.join(repository, s.path ?? '');
		const license = path.join(repository, 'LICENSE');
		if (!existsSync(root))
			throw new Error('The skills download did not contain the expected skills.');
		const names: string[] = [];
		const out = path.join(stage, 'skills');
		await mkdir(out);
		for (const slug of (await readdir(root)).sort()) {
			if (!SLUG.test(slug) || !existsSync(path.join(root, slug, 'SKILL.md'))) continue;
			const name = `${s.prefix}${slug}`;
			const target = path.join(out, name);
			await cp(path.join(root, slug), target, { recursive: true });
			const skill = path.join(target, 'SKILL.md');
			await writeFile(skill, renamed(await readFile(skill, 'utf8'), name));
			if (existsSync(license) && !existsSync(path.join(target, 'LICENSE')))
				await cp(license, path.join(target, 'LICENSE'));
			names.push(name);
		}
		if (!names.length || names.length > 100)
			throw new Error('The skills download did not contain the expected skills.');
		const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir(dir) };
		for (const name of names) {
			const target = path.join(managed(dir), name);
			// Never replace a same-named skill that someone else installed.
			if (existsSync(target) && !ours(dir, name))
				throw new Error(`A skill named ${name} is already installed by someone else; it was kept.`);
			await exec(
				[
					...command,
					'skills',
					'install',
					path.join(out, name),
					'--as',
					name,
					'--global',
					'--force'
				],
				env
			);
			const wanted = await readFile(path.join(out, name, 'SKILL.md'), 'utf8');
			if (
				!existsSync(path.join(target, 'SKILL.md')) ||
				(await readFile(path.join(target, 'SKILL.md'), 'utf8')) !== wanted
			)
				throw new Error('OpenClaw did not install the skills. Check its skill install policy.');
		}
		// Skills that are no longer upstream go away; nothing else is touched.
		for (const old of readReceipt(dir, id)?.skills ?? [])
			if (!names.includes(old) && ours(dir, old))
				await rm(path.join(managed(dir), old), { recursive: true, force: true });
		await writeReceipt(dir, id, {
			repo: s.repo,
			commit,
			skills: names,
			installed_at: new Date().toISOString()
		});
		return { commit, skills: names };
	} finally {
		busy.delete(id);
		await rm(stage, { recursive: true, force: true });
	}
}
export async function removeSkills(dir: string, id: string) {
	const s = source(id);
	const receipt = readReceipt(dir, id);
	const kept: string[] = [];
	for (const name of receipt?.skills ?? []) {
		if (!name.startsWith(s.prefix)) continue;
		if (ours(dir, name)) await rm(path.join(managed(dir), name), { recursive: true, force: true });
		else if (existsSync(path.join(managed(dir), name))) kept.push(name);
	}
	await writeReceipt(dir, id, {
		repo: s.repo,
		commit: null,
		skills: [],
		installed_at: new Date().toISOString(),
		removed: true
	});
	return { removed: true, kept };
}
// Installing or updating the CLI brings its skills along, unless someone removed them.
export async function followTool(dir: string, id: string) {
	if (!providerOf(id).skills || readReceipt(dir, id)?.removed) return;
	const status = await skillsStatus(dir, id);
	if (status.state === 'not_installed' || status.state === 'update_available')
		await installSkills(dir, id);
}
