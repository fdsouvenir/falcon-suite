import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { CallbackConfig } from './callback.js';
import { PublicError } from './providers/types.js';
export type Provision = {
	google_credentials_file?: string;
	microsoft_client_id?: string;
	microsoft_tenant?: string;
	microsoft_client_secret_file?: string;
	callback?: CallbackConfig;
};
export function provision(dir: string): Provision {
	try {
		const p = JSON.parse(readFileSync(path.join(dir, 'provision.json'), 'utf8'));
		return p;
	} catch {
		return {};
	}
}
// Each CLI uses its own keyring password variable; Link's variable is the fallback.
export function keyringPassword(variable: string) {
	return process.env[variable] || process.env.FALCON_LINK_KEYRING_PASSWORD;
}
// The home directory of a Link-created account's isolated CLI stores.
export function accountHome(dir: string, id: string) {
	if (!/^acct_[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid account identifier.');
	return path.join(dir, 'accounts', id);
}
// Isolated home and XDG roots. No process-wide default, installed configuration or existing
// credential is changed; each integration adds its own CLI settings.
export function isolatedEnvironment(dir: string, id: string): NodeJS.ProcessEnv {
	const home = accountHome(dir, id);
	mkdirSync(home, { recursive: true, mode: 0o700 });
	return {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: path.join(home, '.config'),
		XDG_DATA_HOME: path.join(home, '.local', 'share'),
		XDG_STATE_HOME: path.join(home, '.local', 'state'),
		XDG_CACHE_HOME: path.join(home, '.cache')
	};
}
export function run(
	binary: string,
	args: string[],
	env = process.env,
	timeout = 20000,
	classify?: (stderr: string) => PublicError | undefined
): Promise<string> {
	return new Promise((resolve, reject) =>
		execFile(
			binary,
			args,
			{ env, timeout, maxBuffer: 262144, encoding: 'utf8', windowsHide: true },
			(err, out, stderr) =>
				err
					? reject(
							classify?.(stderr) ??
								new Error(
									'CLI operation failed. Check configuration, consent, and connection, then try again.'
								)
						)
					: resolve(out)
		)
	);
}
// Output and exit status for adapters that classify known failures themselves. The caller
// must never persist or display the raw text.
export function runRaw(
	binary: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeout = 20000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	return new Promise((resolve) =>
		execFile(
			binary,
			args,
			{ env, timeout, maxBuffer: 262144, encoding: 'utf8', windowsHide: true },
			(err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' })
		)
	);
}
export async function json(
	binary: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeout?: number,
	classify?: (stderr: string) => PublicError | undefined
): Promise<any> {
	try {
		return JSON.parse(await run(binary, args, env, timeout, classify));
	} catch (e) {
		if (e instanceof PublicError) throw e;
		throw new Error(
			'CLI response could not be verified. Check configuration, consent, and connection, then try again.'
		);
	}
}
export function deviceLogin(
	binary: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	message: (chunk: string) => void,
	done: (success: boolean) => void
): ChildProcess {
	const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
	let bytes = 0;
	let settled = false;
	const finish = (ok: boolean) => {
		if (!settled) {
			settled = true;
			clearTimeout(timer);
			done(ok);
		}
	};
	child.stdout!.on('data', (chunk) => {
		bytes += chunk.length;
		if (bytes > 262144) child.kill();
	});
	child.stderr!.on('data', (chunk) => {
		bytes += chunk.length;
		if (bytes > 262144) child.kill();
		else message(chunk.toString());
	});
	const timer = setTimeout(
		() => {
			child.kill();
			finish(false);
		},
		15 * 60 * 1000
	);
	timer.unref();
	child.on('error', () => finish(false));
	child.on('close', (code) => finish(code === 0));
	return child;
}
