import { createHash, randomUUID } from 'node:crypto';
import {
	mkdtemp,
	writeFile,
	mkdir,
	rename,
	chmod,
	readFile,
	rm,
	copyFile,
	lstat
} from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { run, runRaw } from './cli.js';
import { provider as providerOf } from './providers/index.js';
import type { ToolSource } from './providers/types.js';
import { toolStatus } from './status.js';

type Release = {
	tag_name: string;
	assets: { name: string; browser_download_url: string; digest?: string }[];
};
const HOSTS = ['api.github.com', 'github.com', 'api.hubapi.com'];
async function get(url: string): Promise<Response> {
	const u = new URL(url);
	if (u.protocol !== 'https:' || !HOSTS.includes(u.hostname))
		throw new Error('Unsupported release source.');
	const response = await fetch(url, {
		signal: AbortSignal.timeout(30000),
		headers: { Accept: u.hostname === 'api.github.com' ? 'application/vnd.github+json' : '*/*' }
	});
	if (!response.ok) throw new Error('Release lookup failed. Try again later.');
	return response;
}
async function download(url: string, limit: number) {
	const response = await get(url);
	const reader = response.body!.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > limit) {
			await reader.cancel();
			throw new Error('Release archive is too large.');
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const arch = () => (process.arch === 'x64' ? 'x64' : 'arm64');
function source<K extends ToolSource['kind']>(provider: string, kind: K) {
	const s = providerOf(provider).tool.source;
	if (s.kind !== kind) throw new Error('Unsupported release source.');
	return s as Extract<ToolSource, { kind: K }>;
}
// Release lookups are cached in memory to stay well inside GitHub's unauthenticated limit.
const HOUR = 60 * 60 * 1000;
const releases = new Map<string, { at: number; release: Release | null }>();
const githubRepo = (provider: string) => {
	const s = providerOf(provider).tool.source;
	return s.kind === 'github' || s.kind === 'github_binary' ? s.repo : null;
};
export async function latestRelease(provider: string, retryFailure = false) {
	const repo = githubRepo(provider);
	if (!repo) return null;
	const cached = releases.get(provider);
	if (cached && Date.now() - cached.at < HOUR && (cached.release || !retryFailure))
		return cached.release;
	let release: Release | null = null;
	try {
		const r = (await (
			await get(`https://api.github.com/repos/${repo}/releases/latest`)
		).json()) as Release;
		if (/^v\d+\.\d+\.\d+$/.test(r.tag_name) && Array.isArray(r.assets)) release = r;
	} catch {}
	releases.set(provider, { at: Date.now(), release });
	return release;
}
// A vendor-hosted binary publishes only its SHA-256, not a version number. A different
// digest from the installed binary means an update is available.
const digests = new Map<string, { at: number; digest: string | null }>();
// Installation always reads the current published digest.
export async function latestDigest(provider: string, fresh = false) {
	if (providerOf(provider).tool.source.kind !== 'vendor') return null;
	const cached = digests.get(provider);
	if (cached && Date.now() - cached.at < HOUR && !fresh) return cached.digest;
	let digest: string | null = null;
	try {
		const text = await (await get(source(provider, 'vendor').checksum(arch()))).text();
		const first = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
		if (/^[a-f0-9]{64}$/.test(first)) digest = first;
	} catch {}
	digests.set(provider, { at: Date.now(), digest });
	return digest;
}
export function releaseCheckedAt(provider: string) {
	const at = (releases.get(provider) ?? digests.get(provider))?.at;
	return at ? new Date(at).toISOString() : null;
}
type Receipt = { path: string; version: string; binary_sha256: string; self_updating?: boolean };
async function readReceipt(file: string): Promise<Receipt | undefined> {
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch {
		return undefined;
	}
}
// Publishes a verified binary as an ordinary user-local command on the Office PATH.
// Versioned download copies remain only for rollback, never required by the agent.
async function activate(provider: string, base: string, file: string, version: string) {
	const tool = providerOf(provider).tool;
	const selfUpdating = tool.source.kind === 'vendor';
	const bin = path.join(homedir(), '.local', 'bin');
	if (!(process.env.PATH ?? '').split(path.delimiter).includes(bin))
		throw new Error('Add ~/.local/bin to the Office command PATH before installation.');
	await mkdir(bin, { recursive: true, mode: 0o755 });
	const command = path.join(bin, tool.binary);
	const receiptPath = path.join(base, 'path-install.json');
	const nextDigest = sha256(await readFile(file));
	try {
		const stat = await lstat(command);
		if (!stat.isFile())
			throw new Error(
				'Existing CLI is not a regular file; preserve it and ask your administrator.'
			);
		const currentDigest = sha256(await readFile(command));
		if (currentDigest !== nextDigest) {
			const previous = await readReceipt(receiptPath);
			// A self-updating CLI that Link installed may have changed its own bytes since.
			const ours =
				previous?.binary_sha256 === currentDigest ||
				(selfUpdating && previous?.self_updating === true && previous.path === command);
			if (!ours)
				throw new Error(
					'Existing CLI was installed or changed outside Link; it has been preserved.'
				);
			await copyFile(command, path.join(base, `previous-${randomUUID()}`));
		}
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
	}
	const pending = path.join(bin, `.${tool.binary}-${randomUUID()}`);
	try {
		await copyFile(file, pending);
		await chmod(pending, 0o755);
		await rename(pending, command);
	} finally {
		await rm(pending, { force: true });
	}
	await writeReceipt(base, {
		path: command,
		version,
		binary_sha256: nextDigest,
		...(selfUpdating ? { self_updating: true } : {})
	});
	let previous: string | null = null;
	try {
		previous = JSON.parse(await readFile(path.join(base, 'current.json'), 'utf8')).version;
	} catch {}
	const tmp = path.join(base, `.current-${randomUUID()}.json`);
	await writeFile(tmp, JSON.stringify({ version, previous_version: previous }), { mode: 0o600 });
	await rename(tmp, path.join(base, 'current.json'));
}
async function writeReceipt(base: string, receipt: Receipt) {
	const pending = path.join(base, `.path-install-${randomUUID()}`);
	await writeFile(pending, JSON.stringify(receipt), { mode: 0o600 });
	await rename(pending, path.join(base, 'path-install.json'));
}
const busy = new Set<string>();
export async function install(dir: string, provider: string) {
	if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
		throw new Error('Link installs CLIs on Linux x64 and arm64 only.');
	const p = providerOf(provider);
	if (p.tool.source.kind === 'github_binary' && !p.tool.source.assets[arch()])
		throw new Error(`${p.ui.name} doesn't publish a ${p.tool.binary} build for this computer.`);
	const lock = `${dir}:${provider}`;
	if (busy.has(lock)) throw new Error('Installation is already running.');
	busy.add(lock);
	try {
		const base = path.join(dir, 'tools', provider);
		await mkdir(base, { recursive: true, mode: 0o700 });
		return providerOf(provider).tool.source.kind === 'vendor'
			? await installVendor(provider, base)
			: await installRelease(provider, base);
	} finally {
		busy.delete(lock);
	}
}
// A self-updating CLI that Link installed updates itself with its own command. Otherwise
// Link downloads the published binary and verifies its SHA-256.
async function installVendor(provider: string, base: string) {
	const tool = providerOf(provider).tool;
	const s = source(provider, 'vendor');
	const receipt = await readReceipt(path.join(base, 'path-install.json'));
	if (
		receipt?.self_updating &&
		(await toolStatus(receipt.path, tool.version_prefix, tool.version_args)).version
	) {
		const upgraded = await runRaw(receipt.path, s.upgrade, process.env, 180000);
		const after = await toolStatus(receipt.path, tool.version_prefix, tool.version_args);
		if (!upgraded.ok || after.state !== 'installed')
			throw new Error('The update did not finish. The existing tool was kept; try again later.');
		const next = {
			...receipt,
			version: after.version,
			binary_sha256: sha256(await readFile(receipt.path))
		};
		await writeReceipt(base, next);
		return {
			provider,
			version: after.version,
			digest: `sha256:${next.binary_sha256}`,
			source: 'self-update'
		};
	}
	const digest = await latestDigest(provider, true);
	if (!digest) throw new Error('Release lookup failed. Try again later.');
	const url = s.binary(arch());
	const bytes = await download(url, 256 * 1024 * 1024);
	if (sha256(bytes) !== digest)
		throw new Error('Release checksum mismatch. Existing tool retained.');
	let stage: string | undefined = await mkdtemp(path.join(base, '.stage-'));
	try {
		const file = path.join(stage, tool.binary);
		await writeFile(file, bytes, { mode: 0o700 });
		await chmod(file, 0o700);
		const status = await toolStatus(file, tool.version_prefix, tool.version_args);
		if (status.state !== 'installed')
			throw new Error('Downloaded tool version could not be verified.');
		const version = status.version.replace(/^v/, '');
		const receipt = {
			provider,
			version,
			digest: `sha256:${digest}`,
			source: url,
			installed_at: new Date().toISOString(),
			attempt: randomUUID()
		};
		await writeFile(path.join(stage, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
		// One immutable folder per published build.
		const destination = path.join(base, `${version}-${digest.slice(0, 12)}`);
		await rm(destination, { recursive: true, force: true });
		await rename(stage, destination);
		stage = undefined;
		await activate(provider, base, path.join(destination, tool.binary), version);
		return receipt;
	} finally {
		if (stage) await rm(stage, { recursive: true, force: true });
	}
}
// The release's own SHA-256 sums file (itself checked against GitHub's digest) must list the
// archive with the same digest.
async function checkSums(
	release: Release,
	repo: string,
	file: string,
	name: string,
	archive: Buffer
) {
	const sums = release.assets.find((a) => a.name === file);
	if (
		!sums ||
		!/^sha256:[a-f0-9]{64}$/.test(sums.digest ?? '') ||
		sums.browser_download_url !==
			`https://github.com/${repo}/releases/download/${release.tag_name}/${file}`
	)
		throw new Error('Release checksum or source is unavailable.');
	const text = await download(sums.browser_download_url, 1024 * 1024);
	if (`sha256:${sha256(text)}` !== sums.digest)
		throw new Error('Release checksum mismatch. Existing tool retained.');
	const listed = text
		.toString('utf8')
		.split('\n')
		.map((line) => /^([a-f0-9]{64}) [ *](\S+)$/.exec(line.trim()))
		.find((m) => m?.[2] === name);
	if (listed?.[1] !== sha256(archive))
		throw new Error('Release checksum mismatch. Existing tool retained.');
}
async function installRelease(provider: string, base: string) {
	let stage: string | undefined;
	try {
		const tool = providerOf(provider).tool;
		const s = tool.source;
		if (s.kind !== 'github' && s.kind !== 'github_binary')
			throw new Error('Unsupported release source.');
		const t = { repo: s.repo, binary: tool.binary };
		const versionArgs = tool.version_args ?? ['--version'];
		const release = await latestRelease(provider, true);
		if (!release) throw new Error('Release lookup failed. Try again later.');
		const version = release.tag_name.slice(1);
		const name =
			s.kind === 'github_binary'
				? s.assets[arch()]!
				: `${s.archive}_${version}_linux_${process.arch === 'x64' ? 'amd64' : 'arm64'}.tar.gz`;
		const asset = release.assets.find((a) => a.name === name);
		if (
			!asset ||
			!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') ||
			asset.browser_download_url !==
				`https://github.com/${t.repo}/releases/download/${release.tag_name}/${name}`
		)
			throw new Error('Release checksum or source is unavailable.');
		// A single binary is the whole executable; archives hold a smaller one.
		const bytes = await download(
			asset.browser_download_url,
			(s.kind === 'github_binary' ? 256 : 64) * 1024 * 1024
		);
		if (`sha256:${sha256(bytes)}` !== asset.digest)
			throw new Error('Release checksum mismatch. Existing tool retained.');
		if (s.kind === 'github' && s.checksums)
			await checkSums(release, t.repo, s.checksums, name, bytes);
		const destination = path.join(base, version);
		// Already installed versions are immutable; no in-place overwrite of a working binary.
		try {
			const receipt = JSON.parse(await readFile(path.join(destination, 'receipt.json'), 'utf8'));
			if (receipt.digest === asset.digest) {
				const output = await run(path.join(destination, t.binary), versionArgs);
				if (!output.includes(version)) throw new Error('Installed executable failed validation.');
				await activate(provider, base, path.join(destination, t.binary), version);
				return receipt;
			}
			throw new Error('Installed version has a different receipt.');
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
		}
		stage = await mkdtemp(path.join(base, '.stage-'));
		const archive = path.join(stage, 'release.tar.gz');
		let binary: Buffer = bytes;
		if (s.kind === 'github') {
			await writeFile(archive, bytes, { mode: 0o600 });
			const entries = (await run('tar', ['-tzf', archive])).trim().split('\n');
			// Extract only the exact executable to stdout, never archive paths, links or bundled
			// files. Some releases keep it in a folder named after the archive.
			const folder = name.replace(/\.tar\.gz$/, '');
			const entry = entries.find((e) =>
				[t.binary, `./${t.binary}`, `${folder}/${t.binary}`].includes(e)
			);
			if (!entry) throw new Error('Executable missing from archive.');
			// execFile's normal string runner is unsuitable for binary data.
			const { execFile } = await import('node:child_process');
			binary = await new Promise<Buffer>((resolve, reject) =>
				execFile(
					'tar',
					['-xOzf', archive, entry],
					{ encoding: 'buffer', timeout: 20000, maxBuffer: 64 * 1024 * 1024 },
					(err, stdout) => (err ? reject(new Error('Archive extraction failed.')) : resolve(stdout))
				)
			);
		}
		const binaryPath = path.join(stage, t.binary);
		await writeFile(binaryPath, binary, { mode: 0o700 });
		await chmod(binaryPath, 0o700);
		const output = await run(binaryPath, versionArgs);
		if (!output.includes(version))
			throw new Error('Downloaded tool version could not be verified.');
		const receipt = {
			provider,
			version,
			digest: asset.digest,
			source: asset.browser_download_url,
			installed_at: new Date().toISOString(),
			attempt: randomUUID()
		};
		await writeFile(path.join(stage, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
		await rm(archive, { force: true });
		await rename(stage, destination);
		stage = undefined;
		await activate(provider, base, path.join(destination, t.binary), version);
		return receipt;
	} finally {
		if (stage) await rm(stage, { recursive: true, force: true });
	}
}
