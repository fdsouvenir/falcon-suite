import type { Account } from '../../model.js';
import type { ProviderUi } from '../types.js';

// Plain names for HubSpot record types in scopes such as crm.objects.<type>.read.
const OBJECTS: Record<string, string> = {
	contacts: 'contacts',
	companies: 'companies',
	deals: 'deals',
	tickets: 'tickets',
	owners: 'record owners',
	quotes: 'quotes',
	line_items: 'line items',
	products: 'products',
	custom: 'custom records',
	leads: 'leads',
	users: 'users',
	marketing_events: 'marketing events',
	goals: 'goals',
	appointments: 'appointments',
	courses: 'courses',
	listings: 'listings',
	services: 'services',
	invoices: 'invoices',
	orders: 'orders',
	carts: 'carts',
	subscriptions: 'subscriptions',
	feedback_submissions: 'feedback submissions'
};
// "View and change contacts", "View deal properties", … from HubSpot's scope names.
function describe(scopes: string[]) {
	const groups = new Map<string, { read: boolean; write: boolean }>();
	let other = false;
	for (const scope of scopes) {
		const m =
			/^crm\.(objects|schemas|lists)\.(?:([a-z_]+)\.)?(read|write|highly_sensitive\.[a-z_.]+)$/.exec(
				scope
			);
		if (!m || m[3].startsWith('highly_sensitive')) {
			other = true;
			continue;
		}
		const name =
			m[1] === 'lists'
				? 'lists'
				: m[1] === 'schemas'
					? `properties of ${OBJECTS[m[2]] ?? m[2].replaceAll('_', ' ')}`
					: (OBJECTS[m[2]] ?? m[2].replaceAll('_', ' '));
		const g = groups.get(name) ?? { read: false, write: false };
		g[m[3] as 'read' | 'write'] = true;
		groups.set(name, g);
	}
	const items = [...groups].map(([name, g]) =>
		g.read && g.write ? `View and change ${name}` : g.write ? `Change ${name}` : `View ${name}`
	);
	if (other) items.push('Other HubSpot permissions');
	return items;
}
const serviceKey = (a: Account) => a.auth === 'service_key';
const ui: ProviderUi = {
	id: 'hubspot',
	name: 'HubSpot',
	cli: 'hubspot',
	baseline: ['oauth'],
	permissions: 'provider',
	consent_note:
		"You'll choose what Falcon Link can do on HubSpot's own approval page. Once you're connected, this page shows what HubSpot allowed.",
	connect: 'Connect to HubSpot',
	key: {
		action: 'Use a service key',
		field: 'Service key',
		help: 'Create a service key in your HubSpot account settings, then paste it here. Falcon Link keeps it only in this account’s own HubSpot settings on this Office.',
		note: 'Service keys work for the whole HubSpot account, and HubSpot has no per-user audit trail for them: changes show as made by the key, not by a person.'
	},
	revoke: (a) =>
		serviceKey(a)
			? { lead: 'your HubSpot account settings to deactivate the service key', links: [] }
			: {
					lead: '',
					links: [
						{
							label: "HubSpot's Connected apps page",
							href: `https://app.hubspot.com/integrations-settings/${a.provider_id ?? ''}${a.provider_id ? '/installed' : ''}`
						}
					]
				},
	remove_note: (a) =>
		serviceKey(a)
			? 'The service key keeps working in HubSpot until you deactivate it there.'
			: "Falcon Link stays in HubSpot's Connected apps until you remove it there.",
	title: (a) =>
		serviceKey(a) || !a.email ? (a.provider_id ? `HubSpot account ${a.provider_id}` : null) : null,
	tags: (a) =>
		serviceKey(a)
			? [
					{
						label: 'Admin',
						note: 'Service key: works for the whole HubSpot account, with no per-user audit trail.'
					}
				]
			: [],
	access: {
		labels: {
			automation: 'Manage workflows',
			tickets: 'View and change tickets',
			content: 'Manage website content',
			forms: 'Manage forms',
			'conversations.read': 'Read conversations',
			'conversations.write': 'Reply to conversations',
			'crm.import': 'Import records',
			'crm.export': 'Export records',
			'sales-email-read': 'Read sales email content',
			timeline: 'Add timeline events',
			'e-commerce': 'Manage products and line items',
			'settings.users.read': 'View users',
			'business-intelligence': 'View analytics'
		},
		describe,
		unknown: (a) =>
			serviceKey(a)
				? 'A service key can do whatever was allowed when it was created in HubSpot.'
				: null
	}
};
export default ui;
