import type { ProviderUi } from '../types.js';
import { STRIPE_LINK_CATALOG } from './catalog.js';

// Each granted scope or source action in the words of its permission row.
const labels = Object.fromEntries(
	STRIPE_LINK_CATALOG.rows.flatMap((r) =>
		r.levels.flatMap((l) => l.scopes.map((s) => [s, l.label]))
	)
);

const ui: ProviderUi = {
	id: 'stripe-link',
	// Stripe's consumer wallet is called Link; "Stripe Link" keeps it apart from Falcon Link.
	name: 'Stripe Link',
	group: 'payments',
	cli: 'link-cli',
	// Link reads the account (link-cli user-info retrieve) to confirm who signed in.
	baseline: ['userinfo:read'],
	permissions: 'catalog',
	connect: 'Sign in with Stripe Link',
	revoke: () => ({
		lead: 'Settings → Apps and agents in your Link account at ',
		links: [{ label: 'app.link.com', href: 'https://app.link.com' }]
	}),
	remove_note: () => 'Removing also signs Falcon Link out of this Link account.',
	// Found in link-cli's own store; the address is known after the first check.
	title: (a) => (a.email ? null : 'Stripe Link account (not checked yet)'),
	access: { labels }
};
export default ui;
