// Contract between Link's shared service/page and each integration module.
// Each integration lives in src/providers/<id>/: `ui.ts` holds browser-safe presentation and
// permission data; `index.ts` holds the server adapter around that integration's CLI.
import type { ChildProcess } from 'node:child_process';
import type { CallbackHandoff } from '../callback.js';
import type { Account, Catalog, Owner, Permissions, Purpose } from '../model.js';
import type { Registry } from '../store.js';

export type Revoke = { lead: string; links: { label: string; href: string }[] };
export type ProviderUi = Permissions & {
	id: string;
	name: string;
	cli: string;
	// 'catalog': Link offers the CLI's permission rows. 'provider': people choose on the
	// provider's own consent page and Link reads back what was granted.
	permissions: 'catalog' | 'provider';
	consent_note?: string;
	email_required?: boolean;
	// Label of the action that starts sign-in.
	connect: string;
	// A second way to connect with a pasted key (for example an API or service key).
	key?: { action: string; field: string; help: string; note: string };
	revoke(a: Account): Revoke;
	remove_note?(a: Account): string | null;
	title?(a: Account): string | null;
	tags?(a: Account): { label: string; note: string }[];
	access: {
		key?(scope: string): string;
		labels: Record<string, string>;
		describe?(scopes: string[]): string[];
		unknown?(a: Account): string | null;
	};
};

// A CLI published as GitHub release archives, or as a vendor-hosted single binary with a
// published SHA-256 file that may update itself.
export type ToolSource =
	| { kind: 'github'; repo: string; archive: string }
	| {
			kind: 'vendor';
			binary(arch: 'x64' | 'arm64'): string;
			checksum(arch: 'x64' | 'arm64'): string;
			upgrade: string[];
	  };
export type Tool = { binary: string; minimum: string; source: ToolSource; version_prefix?: string };
export type SkillSource = { repo: string; branch: string; prefix: string };

export type SignInMethod =
	'hosted_callback' | 'paste_redirect' | 'paste_code' | 'device_code' | 'api_key';
export type Login = {
	provider: string;
	id: string;
	account_id: string;
	state:
		| 'starting'
		| 'awaiting_consent'
		| 'verifying'
		| 'connected'
		| 'failed'
		| 'cancelled'
		| 'expired';
	expires_at: string;
	url: string | null;
	code: string | null;
	message: string;
	// Set when the person pastes something back: a redirect address or a code.
	paste?: { label: string; kind: 'url' | 'text' };
	hosted?: boolean;
	// Private to the server.
	email: string;
	prepared?: unknown;
	child?: ChildProcess;
	args?: string[];
	actor: string;
	callback?: CallbackHandoff;
	verifier?: string;
	consuming?: boolean;
	prior: Account | null;
};
export type StartInput = {
	account_id?: string;
	provider: string;
	owner: Owner;
	purpose: Purpose;
	permissions: string[];
	email?: string;
};
export type KeyInput = {
	account_id?: string;
	provider: string;
	owner: Owner;
	purpose: Purpose;
	key: string;
};
// Fixed, plain message safe to show and persist. Never built from raw CLI output.
export class PublicError extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
	}
}
// Failure reported if a sign-in step throws; providers update it as they progress.
export type Stage = { code: string; message: string };

// What the shared service offers an integration module.
export interface Host {
	readonly dir: string;
	readonly registry: Registry;
	catalog(provider: string): Promise<Catalog>;
	tool(a: Account): string;
	env(a: Account): NodeJS.ProcessEnv;
	check(id: string, completingLogin?: boolean): Promise<Account>;
	fail(l: Login, message: string, code?: string): void;
	finish(id: string, value: string, actor: string, fromCallback?: boolean): Promise<unknown>;
}

export interface ProviderModule {
	ui: ProviderUi;
	tool: Tool;
	skills?: SkillSource;
	methods: SignInMethod[];
	readiness(dir: string): { state: 'ready' | 'setup_required'; message: string };
	// Permission rows from the CLI. Absent when permissions are chosen on the provider's page.
	catalog?(tool: string): Promise<Catalog>;
	// Accounts already saved in the CLI's own store.
	discover(tool: string): Promise<Account[]>;
	// Environment for Link's own CLI runs for this account.
	environment(dir: string, a: Account): NodeJS.ProcessEnv;
	// Input checks before anything changes; called again with the existing account on reconnect.
	validate?(input: StartInput, prior: Account | null): void;
	prepare?(dir: string, input: StartInput, catalog: Catalog | null): unknown;
	start(host: Host, l: Login, a: Account, stage: Stage): Promise<void>;
	// Completes a sign-in from something the person pasted (or a hosted-callback redirect).
	finish?(host: Host, l: Login, value: string, fromCallback: boolean): Promise<void>;
	// Completes a hosted-callback sign-in with the authorization code.
	complete?(host: Host, l: Login, code: string): Promise<void>;
	connectKey?(host: Host, a: Account, key: string, prior: Account | null): Promise<void>;
	// Live identity check; updates the account. Throws when it cannot be verified.
	verify(host: Host, a: Account, completingLogin: boolean): Promise<void>;
	// Removes only this account's saved sign-in from the CLI store and confirms it is gone.
	remove(host: Host, a: Account): Promise<void>;
	invocation(host: Host, a: Account): Promise<Record<string, unknown>>;
	identified?(a: Account): boolean;
	brief: {
		heading: string;
		note?: string;
		identity?(a: Account): string;
		scopes(a: Account): string;
	};
}
