import type { Account } from '../../model.js';
import type { ProviderUi } from '../types.js';

// The account's WhatsApp number, from its linked JID (<number>@s.whatsapp.net).
export const number = (a: Account) =>
	a.provider_id ? `+${a.provider_id.split('@')[0]}` : 'WhatsApp account (not checked yet)';

const ui: ProviderUi = {
	id: 'wacli',
	name: 'WhatsApp',
	group: 'messaging',
	cli: 'wacli',
	baseline: [],
	permissions: 'provider',
	consent_note:
		'There is nothing to choose here: this Office becomes a linked device of your WhatsApp account, and agents use wacli in read-only mode.',
	connect: 'Link WhatsApp',
	phone: {
		label: 'Phone number (optional)',
		help: 'To link with a code you type on your phone instead of scanning a QR code, enter this WhatsApp account’s number with its country code.'
	},
	technical: [
		'wacli (github.com/openclaw/wacli, MIT) connects as a WhatsApp Web linked device using the whatsmeow library. Each account keeps its own wacli store on this Office.'
	],
	revoke: () => ({ lead: 'Settings → Linked devices in WhatsApp on your phone', links: [] }),
	remove_note: () =>
		'Removing also signs this Office out of WhatsApp, which removes it from Linked devices on your phone.',
	title: (a) => number(a),
	tags: (a) =>
		a.sync === 'running'
			? [
					{
						label: 'Syncing',
						note: 'wacli sync is running and saving new messages on this Office.'
					}
				]
			: a.sync === 'stopped'
				? [
						{
							label: 'Sync stopped',
							note: 'wacli sync isn’t running. Link starts it again automatically.'
						}
					]
				: [],
	access: {
		labels: {},
		unknown: () =>
			'Read the messages, chats and contacts wacli saves on this Office. Agents get wacli in read-only mode.'
	}
};
export default ui;
