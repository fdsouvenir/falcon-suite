import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Account } from './model.js';
export class Registry {
	constructor(readonly dir: string) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	list(): Account[] {
		try {
			const data = JSON.parse(readFileSync(path.join(this.dir, 'accounts.json'), 'utf8'));
			if (data.version !== 1 || !Array.isArray(data.accounts)) throw new Error('Invalid registry');
			return data.accounts;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw new Error('Account registry is unavailable.');
		}
	}
	get(id: string): Account {
		const a = this.list().find((a) => a.id === id);
		if (!a) throw new Error('Account not found.');
		return a;
	}
	save(account: Account) {
		const accounts = this.list();
		const i = accounts.findIndex((a) => a.id === account.id);
		if (i < 0) accounts.push(account);
		else accounts[i] = account;
		this.write(accounts);
	}
	remove(id: string) {
		this.write(this.list().filter((a) => a.id !== id));
	}
	private write(accounts: Account[]) {
		const tmp = path.join(this.dir, `accounts.${randomUUID()}.tmp`);
		writeFileSync(tmp, JSON.stringify({ version: 1, accounts }), { mode: 0o600 });
		renameSync(tmp, path.join(this.dir, 'accounts.json'));
	}
}
