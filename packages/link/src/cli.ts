import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Provider } from './model.js';
export const TOOLS = {
	google: { binary: 'gog', repo: 'openclaw/gogcli', version: '0.47.0', archive: 'gogcli' },
	microsoft: { binary: 'm365cli', repo: 'fdsouvenir/m365cli', version: '1.0.0', archive: 'm365cli' }
} as const;
export type Provision = {
	google_credentials_file?: string;
	microsoft_client_id?: string;
	microsoft_tenant?: string;
};
export function provision(dir: string): Provision {
	try {
		const p = JSON.parse(readFileSync(path.join(dir, 'provision.json'), 'utf8'));
		return p;
	} catch {
		return {};
	}
}
export function readiness(dir: string, provider: Provider) {
	const p = provision(dir);
	let ready = !!process.env.FALCON_LINK_KEYRING_PASSWORD && process.platform === 'linux';
	if (provider === 'google') {
		try {
			const c = JSON.parse(readFileSync(p.google_credentials_file ?? '', 'utf8')).installed;
			ready = ready && !!c?.client_id && !!c?.client_secret;
		} catch {
			ready = false;
		}
	} else
		ready =
			ready &&
			/^[a-fA-F0-9-]{36}$/.test(p.microsoft_client_id ?? '') &&
			(!p.microsoft_tenant || /^[a-zA-Z0-9.-]{1,255}$/.test(p.microsoft_tenant));
	return {
		state: ready ? 'ready' : 'setup_required',
		message: ready
			? 'Connection setup ready'
			: `${provider === 'google' ? 'Google' : 'Microsoft'} connection setup is incomplete. Contact your administrator.`
	};
}
export function executable(dir: string, provider: Provider): string {
	const tool = TOOLS[provider];
	let version: string = tool.version;
	try {
		const current = JSON.parse(
			readFileSync(path.join(dir, 'tools', provider, 'current.json'), 'utf8')
		);
		if (/^\d+\.\d+\.\d+$/.test(current.version)) version = current.version;
	} catch {}
	const managed = path.join(dir, 'tools', provider, version, tool.binary);
	return existsSync(managed) ? managed : tool.binary;
}
export function accountEnvironment(dir: string, id: string): NodeJS.ProcessEnv {
	if (!/^acct_[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid account identifier.');
	const home = path.join(dir, 'accounts', id);
	mkdirSync(home, { recursive: true, mode: 0o700 });
	// Both providers use isolated CLI-native configuration and encrypted token stores.
	// No process-wide default, installed configuration or existing credential is changed.
	const env = {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: path.join(home, '.config'),
		GOG_CONFIG_DIR: path.join(home, 'gog'),
		GOG_STATE_DIR: path.join(home, 'gog-state'),
		GOG_KEYRING_BACKEND: 'file',
		GOG_KEYRING_PASSWORD: process.env.FALCON_LINK_KEYRING_PASSWORD,
		M365CLI_KEYRING_BACKEND: 'file',
		M365CLI_KEYRING_PASSWORD: process.env.FALCON_LINK_KEYRING_PASSWORD,
		M365CLI_CLIENT_ID: provision(dir).microsoft_client_id
	};
	// Do not inherit account/client selection or service-account overrides from the host.
	for (const key of [
		'GOG_ACCOUNT',
		'GOG_CLIENT',
		'GOG_HOME',
		'GOG_DATA_DIR',
		'GOG_CACHE_DIR',
		'GOOGLE_APPLICATION_CREDENTIALS',
		'M365CLI_ACCOUNT',
		'M365CLI_PROFILE',
		'M365CLI_AUDIENCE'
	])
		delete (env as NodeJS.ProcessEnv)[key];
	return env;
}
export function run(
	binary: string,
	args: string[],
	env = process.env,
	timeout = 20000
): Promise<string> {
	return new Promise((resolve, reject) =>
		execFile(
			binary,
			args,
			{ env, timeout, maxBuffer: 262144, encoding: 'utf8', windowsHide: true },
			(err, out) =>
				err
					? reject(
							new Error(
								'CLI operation failed. Check configuration, consent, and connection, then try again.'
							)
						)
					: resolve(out)
		)
	);
}
export async function json(
	binary: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeout?: number
): Promise<any> {
	try {
		return JSON.parse(await run(binary, args, env, timeout));
	} catch {
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
