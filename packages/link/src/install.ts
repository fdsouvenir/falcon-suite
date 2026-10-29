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
import { run } from './cli.js';
import { provider as providerOf } from './providers/index.js';

type Release = {
	tag_name: string;
	assets: { name: string; browser_download_url: string; digest?: string }[];
};
async function get(url: string): Promise<Response> {
	const u = new URL(url);
	if (u.protocol !== 'https:' || !['api.github.com', 'github.com'].includes(u.hostname))
		throw new Error('Unsupported release source.');
	const response = await fetch(url, {
		signal: AbortSignal.timeout(30000),
		headers: { Accept: 'application/vnd.github+json' }
	});
	if (!response.ok) throw new Error('Release lookup failed. Try again later.');
	return response;
}
// Release lookups are cached in memory to stay well inside GitHub's unauthenticated limit.
const HOUR = 60 * 60 * 1000;
const releases = new Map<string, { at: number; release: Release | null }>();
function githubSource(provider: string) {
	const source = providerOf(provider).tool.source;
	if (source.kind !== 'github') throw new Error('Unsupported release source.');
	return source;
}
export async function latestRelease(provider: string, retryFailure = false) {
	const cached = releases.get(provider);
	if (cached && Date.now() - cached.at < HOUR && (cached.release || !retryFailure))
		return cached.release;
	let release: Release | null = null;
	try {
		const r = (await (
			await get(`https://api.github.com/repos/${githubSource(provider).repo}/releases/latest`)
		).json()) as Release;
		if (/^v\d+\.\d+\.\d+$/.test(r.tag_name) && Array.isArray(r.assets)) release = r;
	} catch {}
	releases.set(provider, { at: Date.now(), release });
	return release;
}
export function releaseCheckedAt(provider: string) {
	const at = releases.get(provider)?.at;
	return at ? new Date(at).toISOString() : null;
}
const busy = new Set<string>();
export async function install(dir: string, provider: string) {
	if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
		throw new Error('Link installs CLIs on Linux x64 and arm64 only.');
	const lock = `${dir}:${provider}`;
	if (busy.has(lock)) throw new Error('Installation is already running.');
	busy.add(lock);
	let stage: string | undefined;
	try {
		const t = { ...githubSource(provider), binary: providerOf(provider).tool.binary };
		const release = await latestRelease(provider, true);
		if (!release) throw new Error('Release lookup failed. Try again later.');
		const version = release.tag_name.slice(1);
		const name = `${t.archive}_${version}_linux_${process.arch === 'x64' ? 'amd64' : 'arm64'}.tar.gz`;
		const asset = release.assets.find((a) => a.name === name);
		if (
			!asset ||
			!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') ||
			asset.browser_download_url !==
				`https://github.com/${t.repo}/releases/download/${release.tag_name}/${name}`
		)
			throw new Error('Release checksum or source is unavailable.');
		const response = await get(asset.browser_download_url);
		const reader = response.body!.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 64 * 1024 * 1024) {
				await reader.cancel();
				throw new Error('Release archive is too large.');
			}
			chunks.push(value);
		}
		const bytes = Buffer.concat(chunks);
		if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest)
			throw new Error('Release checksum mismatch. Existing tool retained.');
		const base = path.join(dir, 'tools', provider);
		await mkdir(base, { recursive: true, mode: 0o700 });
		const destination = path.join(base, version);
		const activate = async () => {
			// The installed command is an ordinary user-local executable on the Office PATH.
			// Versioned download copies remain only for rollback, never required by the agent.
			const bin = path.join(homedir(), '.local', 'bin');
			if (!(process.env.PATH ?? '').split(path.delimiter).includes(bin))
				throw new Error('Add ~/.local/bin to the Office command PATH before installation.');
			await mkdir(bin, { recursive: true, mode: 0o755 });
			const command = path.join(bin, t.binary);
			const receiptPath = path.join(base, 'path-install.json');
			const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
			const nextDigest = digest(await readFile(path.join(destination, t.binary)));
			try {
				const stat = await lstat(command);
				if (!stat.isFile())
					throw new Error(
						'Existing CLI is not a regular file; preserve it and ask your administrator.'
					);
				const currentDigest = digest(await readFile(command));
				if (currentDigest !== nextDigest) {
					let previousReceipt;
					try {
						previousReceipt = JSON.parse(await readFile(receiptPath, 'utf8'));
					} catch {}
					if (previousReceipt?.binary_sha256 !== currentDigest)
						throw new Error(
							'Existing CLI was installed or changed outside Link; it has been preserved.'
						);
					await copyFile(command, path.join(base, `previous-${randomUUID()}`));
				}
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
			}
			const pending = path.join(bin, `.${t.binary}-${randomUUID()}`);
			try {
				await copyFile(path.join(destination, t.binary), pending);
				await chmod(pending, 0o755);
				await rename(pending, command);
			} finally {
				await rm(pending, { force: true });
			}
			const pendingReceipt = path.join(base, `.path-install-${randomUUID()}`);
			await writeFile(
				pendingReceipt,
				JSON.stringify({ path: command, version, binary_sha256: nextDigest }),
				{ mode: 0o600 }
			);
			await rename(pendingReceipt, receiptPath);

			let previous: string | null = null;
			try {
				previous = JSON.parse(await readFile(path.join(base, 'current.json'), 'utf8')).version;
			} catch {}
			const tmp = path.join(base, `.current-${randomUUID()}.json`);
			await writeFile(tmp, JSON.stringify({ version, previous_version: previous }), {
				mode: 0o600
			});
			await rename(tmp, path.join(base, 'current.json'));
		};
		// Already installed versions are immutable; no in-place overwrite of a working binary.
		try {
			const receipt = JSON.parse(await readFile(path.join(destination, 'receipt.json'), 'utf8'));
			if (receipt.digest === asset.digest) {
				const output = await run(path.join(destination, t.binary), ['--version']);
				if (!output.includes(version)) throw new Error('Installed executable failed validation.');
				await activate();
				return receipt;
			}
			throw new Error('Installed version has a different receipt.');
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
		}
		stage = await mkdtemp(path.join(base, '.stage-'));
		const archive = path.join(stage, 'release.tar.gz');
		await writeFile(archive, bytes, { mode: 0o600 });
		const entries = (await run('tar', ['-tzf', archive])).trim().split('\n');
		// Extract only the exact executable to stdout, never archive paths, links or bundled files.
		const entry = entries.find((e) => e === t.binary || e === `./${t.binary}`);
		if (!entry) throw new Error('Executable missing from archive.');
		// execFile's normal string runner is unsuitable for binary data.
		const { execFile } = await import('node:child_process');
		const binary = await new Promise<Buffer>((resolve, reject) =>
			execFile(
				'tar',
				['-xOzf', archive, entry],
				{ encoding: 'buffer', timeout: 20000, maxBuffer: 64 * 1024 * 1024 },
				(err, stdout) => (err ? reject(new Error('Archive extraction failed.')) : resolve(stdout))
			)
		);
		const binaryPath = path.join(stage, t.binary);
		await writeFile(binaryPath, binary, { mode: 0o700 });
		await chmod(binaryPath, 0o700);
		const output = await run(binaryPath, ['--version']);
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
		await rm(archive);
		await rename(stage, destination);
		stage = undefined;
		await activate();
		return receipt;
	} finally {
		if (stage) await rm(stage, { recursive: true, force: true });
		busy.delete(lock);
	}
}
