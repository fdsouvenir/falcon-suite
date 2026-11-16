import type { Catalog, Row } from '../../model.js';

// Stripe Link permission rows: every option `link-cli auth login` can request
// (commands/auth/schema.ts). Scopes go to `--scope`; financial data is requested as source
// actions (`--source-actions`, sent as authorization_details of type `source`), written here as
// `source:<action>`.
export const SOURCE = 'source:';
const row = (
	id: string,
	label: string,
	description: string,
	level: string,
	levelDescription: string,
	scope: string
): Row => ({
	id,
	label,
	description,
	group: 'main',
	levels: [{ id: `${id}:on`, label: level, description: levelDescription, scopes: [scope] }]
});

const rows: Row[] = [
	row(
		'payments',
		'Payments',
		'Payment credentials from your Link wallet.',
		'Get payment credentials',
		'Get one-time virtual cards and payment tokens from your Link wallet for purchases.',
		'payment_methods.agentic'
	),
	row(
		'link_transactions',
		'Link transactions',
		'Purchases and payments made through Link.',
		'See Link transactions',
		'See transactions processed through Link.',
		SOURCE + 'read_link_transactions'
	),
	row(
		'external_transactions',
		'Bank and card transactions',
		'Transactions from bank accounts and cards connected to Link.',
		'See bank and card transactions',
		'See transactions imported from bank accounts and cards connected to Link.',
		SOURCE + 'read_external_transactions'
	),
	row(
		'balances',
		'Balances',
		'Balances of accounts connected to Link.',
		'See balances',
		'See current and available balances of accounts connected to Link.',
		SOURCE + 'read_balances'
	),
	row(
		'source_details',
		'Account details',
		'Which bank accounts and cards are connected to Link.',
		'See account details',
		'See the bank or card issuer name, account type and last four digits of accounts connected to Link.',
		SOURCE + 'read_source_details'
	)
];

export const STRIPE_LINK_CATALOG: Catalog = {
	rows,
	saved: {},
	technical: [
		'userinfo:read is always included so Link can confirm which Link account signed in.',
		'Scopes starting with source: are financial-data actions, requested with link-cli --source-actions.'
	]
};
// The `--scope` values and source actions for a set of catalog scopes.
export function splitAccess(scopes: string[]) {
	return {
		scopes: scopes.filter((s) => !s.startsWith(SOURCE)),
		source_actions: scopes.filter((s) => s.startsWith(SOURCE)).map((s) => s.slice(SOURCE.length))
	};
}
