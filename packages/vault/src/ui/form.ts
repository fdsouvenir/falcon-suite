import type { Ctx, EntryDetail } from './app.js';
import { avatar, h, icon, iconButton, shownPath, who } from './dom.js';
import { mobileBar, usages } from './entry.js';
import { groupOptions } from './tree.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%+=';

/** A random password (spec §14.1): 24 characters, from the browser's CSPRNG, without bias. */
export function generatePassword(length = 24): string {
	const out: string[] = [];
	const limit = 256 - (256 % ALPHABET.length);
	while (out.length < length) {
		for (const b of crypto.getRandomValues(new Uint8Array(length * 2)))
			if (b < limit && out.length < length) out.push(ALPHABET[b % ALPHABET.length]);
	}
	return out.join('');
}

const input = (opts: {
	label: string;
	value?: string;
	placeholder?: string;
	type?: string;
	mono?: boolean;
}) => {
	const el = h('input', {
		class: `fv-input${opts.mono ? ' fv-input-mono' : ''}`,
		type: opts.type ?? 'text',
		placeholder: opts.placeholder ?? '',
		'aria-label': opts.label,
		autocomplete: 'off',
		spellcheck: 'false'
	});
	el.value = opts.value ?? '';
	return el;
};

const field = (label: string, control: HTMLElement, ...after: (HTMLElement | null)[]) =>
	h('label', { class: 'fv-field' }, h('span', { class: 'fv-label' }, label), control, ...after);

/**
 * The Password input with Reveal/Hide and "Generate password" as a small text button under it
 * (spec §9). Editing an existing password reveals it through the backend (recorded) on request.
 */
function passwordInput(
	c: Ctx,
	opts: { label: string; placeholder: string; existing?: EntryDetail; onChange?: () => void }
) {
	const el = input({
		label: opts.label,
		placeholder: opts.placeholder,
		type: 'password',
		mono: true
	});
	let original: string | null = null; // the stored value, once revealed for editing
	const status = h('span', { class: 'fv-error-text', role: 'status' });
	const toggle = iconButton('eye', 'Reveal', async () => {
		status.textContent = '';
		if (el.type === 'text') {
			el.type = 'password';
			toggle.replaceChildren(icon('eye'));
			return;
		}
		if (opts.existing?.set.Password && original === null && !el.value) {
			try {
				original = await c.reveal(opts.existing, 'Password', 'reveal');
				el.value = original;
			} catch (err) {
				status.textContent = (err as Error).message;
				return;
			}
		}
		el.type = 'text';
		toggle.replaceChildren(icon('eyeOff'));
		// Hidden again after 15 seconds, as a revealed value is in the entry view (spec §6).
		setTimeout(() => {
			if (el.type === 'text') {
				el.type = 'password';
				toggle.replaceChildren(icon('eye'));
			}
		}, 15_000);
	});
	el.addEventListener('input', () => opts.onChange?.());
	const generate = h(
		'button',
		{
			class: 'fv-generate',
			type: 'button',
			on: {
				click: () => {
					el.value = generatePassword();
					el.type = 'text';
					toggle.replaceChildren(icon('eyeOff'));
					opts.onChange?.();
				}
			}
		},
		icon('refresh', 13),
		'Generate password'
	);
	const box = h('div', { class: 'fv-input-wrap' }, el, toggle);
	return {
		node: field(opts.label, box, generate, status),
		/** The new password, or undefined when it was left as it is. */
		value: () => (el.value === '' || el.value === original ? undefined : el.value),
		el
	};
}

/** The host's searchable picker for the Group field. */
function groupPicker(c: Ctx, value: string, onSelect: (v: string) => void) {
	const holder = h('div', { class: 'fv-select' });
	const options = groupOptions(c, { top: 'Top level' });
	let handle: { update: (p: never) => void; dispose: () => void };
	const props = (v: string) => ({
		options,
		value: v,
		accessibleLabel: 'Group',
		searchable: true,
		onSelect: (next: string) => {
			onSelect(next);
			handle.update(props(next) as never);
		}
	});
	handle = c.host.components.mountSelectPicker(holder, props(value)) as never;
	c.track(handle);
	return holder;
}

/** Edit in place (spec §9), or New entry when `e` is null. */
export function entryForm(c: Ctx, e: EntryDetail | null) {
	const p = c.params;
	const isNew = !e;
	let group = e ? e.group : p.v ? '' : (p.g ?? '');
	const title = input({ label: 'Title', value: e?.title, placeholder: 'e.g. GitHub — deploy key' });
	const username = input({
		label: 'Username',
		value: e?.username,
		placeholder: 'Username or email'
	});
	const url = input({ label: 'URL', value: e?.url, placeholder: 'https://…' });
	const notes = h('textarea', {
		class: 'fv-input fv-textarea',
		rows: 4,
		placeholder: 'Add notes, purpose, or rotation policy…',
		'aria-label': 'Notes'
	});
	notes.value = e?.notes ?? '';
	const password = passwordInput(c, {
		label: 'Password',
		placeholder: e?.set.Password ? '•'.repeat(16) : isNew ? '' : 'not set',
		existing: e ?? undefined
	});
	const status = h('p', { class: 'fv-error-text', role: 'alert' });
	const warn = h('div', { class: 'fv-confirm', hidden: true });
	let confirmed = false;
	const save = h(
		'button',
		{ class: 'fv-btn fv-btn-primary', type: 'submit', disabled: isNew },
		isNew ? 'Create entry' : 'Save'
	);
	const mobileSave = h(
		'button',
		{
			class: 'fv-btn fv-btn-text fv-accent',
			type: 'submit',
			form: 'fv-entry-form',
			disabled: isNew
		},
		isNew ? 'Create' : 'Save'
	);
	title.addEventListener('input', () => {
		save.disabled = mobileSave.disabled = !title.value.trim();
		confirmed = false;
		warn.hidden = true;
	});
	const cancel = () =>
		c.go({ ...p, m: undefined, ...(isNew ? { e: undefined, u: undefined } : {}) });

	async function submit(ev: Event) {
		ev.preventDefault();
		status.textContent = '';
		const fields = {
			title: title.value.trim(),
			group,
			username: username.value,
			url: url.value.trim(),
			notes: notes.value,
			...(password.value() !== undefined ? { password: password.value() } : {})
		};
		// Renaming or moving an entry that has Usages warns first, naming each one (spec §4).
		const moves = e && (fields.title !== e.title || fields.group !== e.group);
		if (moves && e!.usages.length && !confirmed) {
			confirmed = true;
			warn.hidden = false;
			warn.replaceChildren(
				h('h3', { class: 'fv-confirm-title' }, 'This breaks config references'),
				h(
					'p',
					{ class: 'fv-small' },
					`OpenClaw reads this entry at ${shownPath(e!.path)}. After the move these settings stop working until you point them at the new path:`
				),
				h(
					'ul',
					{ class: 'fv-confirm-list' },
					e!.usages.map((u) =>
						h('li', { title: u.config_path }, h('span', { class: 'fv-dot fv-dot-danger' }), u.label)
					)
				),
				h('p', { class: 'fv-small' }, 'Save again to move it anyway.')
			);
			return;
		}
		save.disabled = mobileSave.disabled = true;
		try {
			const r = isNew
				? await c.edit('create_entry', { fields })
				: await c.edit('update_entry', { path: e!.path, uuid: e!.uuid, fields });
			c.go({
				...p,
				e: r.path,
				u: undefined,
				m: undefined,
				...(isNew && !p.v ? { g: group || undefined } : {})
			});
		} catch (err) {
			status.textContent = (err as Error).message;
			save.disabled = mobileSave.disabled = false;
		}
	}

	return h(
		'form',
		{ class: 'fv-pane fv-form', id: 'fv-entry-form', on: { submit } },
		mobileBar(c, isNew ? 'New entry' : e!.title, mobileSave),
		isNew
			? h(
					'header',
					{ class: 'fv-pane-head' },
					h(
						'div',
						{ class: 'fv-pane-titles' },
						h('h2', { class: 'fv-pane-title' }, 'New entry'),
						h('span', { class: 'fv-muted fv-small' }, 'Add credentials to your vault')
					),
					iconButton('x', 'Close', cancel)
				)
			: null,
		h(
			'div',
			{ class: 'fv-pane-body' },
			h(
				'div',
				{ class: 'fv-form-top' },
				field('Title', title),
				field(
					'Group',
					groupPicker(c, group, (v) => ((group = v), (confirmed = false)))
				)
			),
			field('Username', username),
			password.node,
			field('URL', url),
			field('Notes', notes),
			e ? usages(e) : null,
			warn,
			status,
			e
				? h(
						'button',
						{
							class: 'fv-btn fv-btn-text fv-danger-text fv-mobile',
							type: 'button',
							on: { click: () => c.go({ ...p, m: 'delete' }) }
						},
						icon('trash', 16),
						'Move to Recycle Bin'
					)
				: null
		),
		h(
			'footer',
			{ class: 'fv-pane-foot' },
			h(
				'button',
				{ class: 'fv-btn fv-btn-quiet', type: 'button', on: { click: cancel } },
				'Cancel'
			),
			save
		)
	);
}

/** Needs a value (spec §9): the agent's reason, what it filled in, and an empty Password. */
export function fillForm(c: Ctx, e: EntryDetail) {
	const p = c.params;
	const asker = e.request!.actor;
	const status = h('p', { class: 'fv-error-text', role: 'alert' });
	const save = h(
		'button',
		{ class: 'fv-btn fv-btn-primary', type: 'submit', disabled: true },
		'Save'
	);
	const mobileSave = h(
		'button',
		{ class: 'fv-btn fv-btn-text fv-accent', type: 'submit', form: 'fv-fill-form', disabled: true },
		'Save'
	);
	const password = passwordInput(c, {
		label: 'Password / Secret key',
		placeholder: 'Paste the key',
		onChange: () => (save.disabled = mobileSave.disabled = !password.el.value)
	});
	const after = () => c.go({ ...p, e: undefined, u: undefined, m: undefined });
	const dismiss = h('button', { class: 'fv-btn fv-btn-quiet', type: 'button' }, 'Dismiss request');
	dismiss.addEventListener('click', async () => {
		dismiss.disabled = true;
		try {
			await c.edit('dismiss_request', { path: e.path, uuid: e.uuid });
			after();
		} catch (err) {
			status.textContent = (err as Error).message;
			dismiss.disabled = false;
		}
	});
	const plain = (label: string, value: string, link = false) =>
		h(
			'div',
			{ class: 'fv-field fv-field-ruled' },
			h('span', { class: 'fv-label' }, label),
			value
				? link && /^https?:\/\//i.test(value)
					? h(
							'a',
							{
								class: 'fv-value fv-link',
								href: value,
								target: '_blank',
								rel: 'noopener noreferrer'
							},
							value
						)
					: h('span', { class: 'fv-value' }, value)
				: h('span', { class: 'fv-not-set' }, 'not set')
		);
	return h(
		'form',
		{
			class: 'fv-pane fv-form',
			id: 'fv-fill-form',
			on: {
				submit: async (ev: Event) => {
					ev.preventDefault();
					const value = password.el.value;
					if (!value) return;
					save.disabled = mobileSave.disabled = true;
					try {
						await c.edit('fill_request', {
							path: e.path,
							uuid: e.uuid,
							fields: { password: value }
						});
						c.go({
							...p,
							v: undefined,
							g: e.group || undefined,
							e: e.path,
							u: e.uuid,
							m: undefined
						});
					} catch (err) {
						status.textContent = (err as Error).message;
						save.disabled = mobileSave.disabled = false;
					}
				}
			}
		},
		mobileBar(c, e.title, mobileSave),
		h(
			'header',
			{ class: 'fv-pane-head' },
			h(
				'div',
				{ class: 'fv-pane-titles' },
				h('h2', { class: 'fv-pane-title' }, e.title),
				h('span', { class: 'fv-muted fv-small' }, e.group ? shownPath(e.group) : 'Top level')
			)
		),
		h(
			'div',
			{ class: 'fv-pane-body' },
			h(
				'div',
				{ class: 'fv-callout' },
				avatar(asker),
				h(
					'p',
					null,
					h('strong', { class: 'fv-strong' }, `${who(asker)} asked for this: `),
					e.request!.reason
				)
			),
			plain('Username', e.username),
			plain('URL', e.url, true),
			password.node,
			e.notes
				? h(
						'div',
						{ class: 'fv-field' },
						h('span', { class: 'fv-label' }, 'Notes'),
						h('span', { class: 'fv-value fv-notes fv-muted' }, e.notes)
					)
				: null,
			status
		),
		h(
			'footer',
			{ class: 'fv-pane-foot fv-pane-foot-fill' },
			h('div', { class: 'fv-foot-row' }, dismiss, save),
			h('p', { class: 'fv-muted fv-small fv-center' }, `${who(asker)} is told when you save.`)
		)
	);
}
