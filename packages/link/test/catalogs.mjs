// Minimal CLI catalog responses in the published JSON shapes of gog and m365cli.
const g = (name) => 'https://www.googleapis.com/auth/' + name;
export const services = [
	{ service: 'gmail', user: true, scopes: [g('gmail.modify'), g('gmail.settings.basic')] },
	{ service: 'calendar', user: true, scopes: [g('calendar')] },
	{ service: 'people', user: true, scopes: ['profile'] },
	{ service: 'keep', user: false, scopes: [g('keep')] }
];
const workload = (id, service, access, scopes, extra = {}) => ({
	id,
	service,
	label: id,
	access,
	scopes,
	personal: true,
	work: true,
	tenant_admin_consent: false,
	compatibility_bundle: false,
	notes: '',
	...extra
});
export const workloads = [
	workload('mail', 'mail', 'read/write', ['Mail.Read', 'Mail.Send'], {
		compatibility_bundle: true
	}),
	workload('mail-read', 'mail', 'read', ['Mail.Read']),
	workload('mail-send', 'mail', 'send', ['Mail.Send']),
	workload('mail-write', 'mail', 'read/write', ['Mail.ReadWrite']),
	workload('groups', 'groups', 'read', ['Group.Read.All'], {
		personal: false,
		tenant_admin_consent: true
	})
];
