import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { CallbackConfig } from './callback.js';
import type { Provider } from './model.js';
export const TOOLS = {
	google: {
		binary: 'gog',
		repo: 'openclaw/gogcli',
		archive: 'gogcli',
		// gogcli CHANGELOG 0.44.0: "Photos: upload media and list/create app-created albums with an
		// explicit append-scope opt-in" — Link passes `--photos-scope append`.
		minimum: '0.44.0'
	},
	microsoft: {
		binary: 'm365cli',
		repo: 'fdsouvenir/m365cli',
		archive: 'm365cli',
		// m365cli 2.1.0 added `auth workloads`, the grant report and `--audience auto`.
		minimum: '2.1.0'
	}
} as const;
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
const KEYRING = { google: 'GOG_KEYRING_PASSWORD', microsoft: 'M365CLI_KEYRING_PASSWORD' } as const;
export function keyringPassword(provider: Provider) {
	return process.env[KEYRING[provider]] || process.env.FALCON_LINK_KEYRING_PASSWORD;
}
export function readiness(dir: string, provider: Provider) {
	const p = provision(dir);
	let ready = !!keyringPassword(provider);
	if (provider === 'google') {
		try {
			const raw = JSON.parse(readFileSync(p.google_credentials_file ?? '', 'utf8'));
			const c = p.callback ? raw.web : raw.installed;
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
			? ''
			: `${provider === 'google' ? 'Google' : 'Microsoft'} sign-in isn't set up on this Office. Contact your administrator.`
	};
}
export function executable(dir: string, provider: Provider): string {
	const tool = TOOLS[provider];
	const normal = path.join(homedir(), '.local', 'bin', tool.binary);
	if ((process.env.PATH ?? '').split(path.delimiter).includes(path.dirname(normal))) {
		try {
			accessSync(normal, constants.X_OK);
			return normal;
		} catch {}
	}
	let version: string | undefined;
	try {
		const current = JSON.parse(
			readFileSync(path.join(dir, 'tools', provider, 'current.json'), 'utf8')
		);
		if (/^\d+\.\d+\.\d+$/.test(current.version)) version = current.version;
	} catch {}
	const managed = version ? path.join(dir, 'tools', provider, version, tool.binary) : '';
	// After migration, removing the normal command must not reactivate a private copy.
	const migrated = existsSync(path.join(dir, 'tools', provider, 'path-install.json'));
	if (!migrated && managed && existsSync(managed)) return managed;
	// Prefer normal CLI installations. Private preview paths are legacy fallback only.
	for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!path.isAbsolute(folder)) continue;
		const candidate = path.join(folder, tool.binary);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return tool.binary;
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
		XDG_DATA_HOME: path.join(home, '.local', 'share'),
		XDG_STATE_HOME: path.join(home, '.local', 'state'),
		XDG_CACHE_HOME: path.join(home, '.cache'),
		GOG_CONFIG_DIR: path.join(home, 'gog'),
		GOG_DATA_DIR: path.join(home, 'gog-data'),
		GOG_STATE_DIR: path.join(home, 'gog-state'),
		GOG_CACHE_DIR: path.join(home, 'gog-cache'),
		GOG_KEYRING_BACKEND: 'file',
		GOG_KEYRING_PASSWORD: keyringPassword('google'),
		M365CLI_CONFIG_DIR: path.join(home, '.config', 'm365cli'),
		M365CLI_KEYRING_BACKEND: 'file',
		M365CLI_KEYRING_PASSWORD: keyringPassword('microsoft'),
		M365CLI_CLIENT_ID: provision(dir).microsoft_client_id
	};
	// Do not inherit account/client selection or service-account overrides from the host.
	for (const key of [
		'GOG_ACCOUNT',
		'GOG_CLIENT',
		'GOG_HOME',
		'GOOGLE_APPLICATION_CREDENTIALS',
		'M365CLI_ACCOUNT',
		'M365CLI_PROFILE',
		'M365CLI_AUDIENCE'
	])
		delete (env as NodeJS.ProcessEnv)[key];
	return env;
}

// Only recognized gog stage markers become public facts. Never retain raw stderr,
// which can contain addresses, codes, tokens or provider diagnostic payloads.
export class GoogleCompletionError extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
	}
}
function googleCompletionError(stderr: string): GoogleCompletionError | undefined {
	const stages = [
		[
			'OAuth completed, but saving the refresh token failed:',
			'google_token_storage_failed',
			'Google authorization completed, but the encrypted account store could not save the connection. Contact your administrator before reconnecting.'
		],
		[
			'fetch authorized email:',
			'google_identity_failed',
			'Google authorization completed, but the account identity could not be confirmed. Reconnect to try again.'
		],
		[
			'authorized as ',
			'google_account_mismatch',
			'Google returned a different account address. Reconnect with the intended account.'
		],
		[
			'exchange code:',
			'google_exchange_failed',
			'Google could not exchange the authorization code. Reconnect and complete a new sign-in.'
		]
	] as const;
	for (const [marker, code, message] of stages)
		if (stderr.includes(marker)) return new GoogleCompletionError(code, message);
	return undefined;
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
			(err, out, stderr) =>
				err
					? reject(
							(args[0] === 'auth' && args[1] === 'add' && args[args.indexOf('--step') + 1] === '2'
								? googleCompletionError(stderr)
								: undefined) ??
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
	} catch (e) {
		if (e instanceof GoogleCompletionError) throw e;
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
