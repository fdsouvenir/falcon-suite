import type { Ctx, EntryDetail } from './app.js';
import { ago, h, icon, iconButton, shownPath, who } from './dom.js';
import { menuButton } from './menu.js';

const MASK = '•'.repeat(16);
const FIELD_WORD: Record<string, string> = {
	Password: 'password',
	UserName: 'username',
	URL: 'URL',
	Notes: 'notes',
	Title: 'title'
};

/** One History line in words: "OpenClaw · read", "fred · revealed password". */
export function historyLine(ev: { actor: string; action: string; outcome: string; detail: any }) {
	const d = ev.detail ?? {};
	const field = FIELD_WORD[d.field] ?? 'password';
	const fields = (d.fields as string[] | undefined)?.map((f) => FIELD_WORD[f] ?? f) ?? [];
	const verb =
		{
			resolve: d.field && d.field !== 'Password' ? `read ${field}` : 'read',
			store: 'stored',
			create_entry: 'created',
			request: 'asked for a value',
			fill_request: 'filled in the password',
			dismiss_request: 'dismissed the request',
			reveal: `revealed ${field}`,
			copy: `copied ${field}`,
			edit_entry: d.to
				? `moved it to ${shownPath(d.to)}`
				: fields.length
					? `edited ${fields.join(', ')}`
					: 'saved without changes',
			recycle_entry: d.forever ? 'deleted forever' : 'moved to Recycle Bin',
			delete_forever: 'deleted forever',
			create_group: 'created group',
			rename_group: d.to ? `renamed group to ${shownPath(d.to)}` : 'renamed group',
			move_group: d.to ? `moved group to ${shownPath(d.to)}` : 'moved group',
			delete_group: 'deleted group'
		}[ev.action] ?? ev.action.replace(/_/g, ' ');
	const failed =
		ev.outcome === 'ok' ? '' : ev.outcome === 'not_found' ? ' (not found)' : ` (${ev.outcome})`;
	return {
		who: ev.actor.startsWith('agent:') ? `${who(ev.actor)} (agent)` : who(ev.actor),
		verb: verb + failed
	};
}

/** Copy text, saying so on the button for a moment. */
export async function copyText(button: HTMLElement | null, text: string) {
	await navigator.clipboard.writeText(text);
	if (!button) return;
	button.classList.add('is-done');
	button.setAttribute('title', 'Copied');
	setTimeout(() => {
		button.classList.remove('is-done');
		button.setAttribute('title', 'Copy');
	}, 1500);
}

/** A field shown in full, with a copy button. */
function plainField(
	label: string,
	value: string,
	opts: { link?: boolean; multiline?: boolean } = {}
) {
	if (!value)
		return h(
			'div',
			{ class: 'fv-field' },
			h('span', { class: 'fv-label' }, label),
			h('span', { class: 'fv-not-set' }, 'not set')
		);
	const copy = iconButton('copy', `Copy ${label.toLowerCase()}`, () => void copyText(copy, value));
	return h(
		'div',
		{ class: 'fv-field' },
		h('span', { class: 'fv-label' }, label),
		h(
			'div',
			{ class: `fv-value-row${opts.multiline ? ' is-multiline' : ''}` },
			opts.link && /^https?:\/\//i.test(value)
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
				: h('span', { class: `fv-value${opts.multiline ? ' fv-notes' : ''}` }, value),
			opts.multiline ? null : copy
		)
	);
}

/**
 * The Password (spec §6): masked, with Reveal/Hide and Copy. Both go through the backend, which
 * records them. A revealed value hides again after 15 seconds.
 */
export function secretField(
	c: Ctx,
	e: EntryDetail,
	field: 'Password' = 'Password',
	label = 'Password'
) {
	if (!e.set[field])
		return h(
			'div',
			{ class: 'fv-field' },
			h('span', { class: 'fv-label' }, label),
			h('span', { class: 'fv-not-set' }, 'not set')
		);
	const key = `${e.uuid}:${field}`;
	const value = h('span', { class: 'fv-secret-value' });
	const status = h('span', { class: 'fv-error-text', role: 'status' });
	let toggle: HTMLButtonElement;
	const show = () => {
		const shown = c.secrets.get(key);
		value.textContent = shown ?? MASK;
		value.classList.toggle('is-masked', shown === null);
		toggle.replaceChildren(icon(shown === null ? 'eye' : 'eyeOff'));
		toggle.title = shown === null ? 'Reveal' : 'Hide';
		toggle.setAttribute(
			'aria-label',
			shown === null ? `Reveal ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`
		);
	};
	toggle = iconButton('eye', 'Reveal', async () => {
		status.textContent = '';
		if (c.secrets.get(key) !== null) return c.secrets.hide(key);
		try {
			c.secrets.show(key, await c.reveal(e, field, 'reveal'));
		} catch (err) {
			status.textContent = (err as Error).message;
		}
	}) as HTMLButtonElement;
	const copy = iconButton('copy', `Copy ${label.toLowerCase()}`, async () => {
		status.textContent = '';
		try {
			await copyText(copy, c.secrets.get(key) ?? (await c.reveal(e, field, 'copy')));
		} catch (err) {
			status.textContent = (err as Error).message;
		}
	});
	c.secrets.watch(key, show, value);
	show();
	return h(
		'div',
		{ class: 'fv-field' },
		h('span', { class: 'fv-label' }, label),
		h('div', { class: 'fv-secret' }, value, toggle, copy),
		status
	);
}

/** "Used by OpenClaw" (spec §5, §9): only when config uses the entry. */
export function usages(e: EntryDetail, intro = true) {
	if (!e.usages.length) return null;
	return h(
		'section',
		{ class: 'fv-section' },
		h(
			'h3',
			{ class: 'fv-section-title' },
			h('span', { class: 'fv-dot fv-dot-ok', 'aria-hidden': 'true' }),
			'Used by OpenClaw'
		),
		intro
			? h(
					'p',
					{ class: 'fv-muted fv-small' },
					'OpenClaw reads this entry for these settings. Renaming or deleting it breaks them.'
				)
			: null,
		h(
			'ul',
			{ class: 'fv-usages' },
			e.usages.map((u) =>
				h(
					'li',
					{ class: 'fv-usage' },
					h(
						'span',
						{ class: 'fv-usage-label' },
						u.label + (u.field !== 'Password' ? ` (${FIELD_WORD[u.field]})` : '')
					),
					h('span', { class: 'fv-mono' }, u.config_path)
				)
			)
		)
	);
}

/** A short History (spec §9): the last few lines, repeats folded into one ("OpenClaw · read ×4"). */
function history(e: EntryDetail) {
	const lines: { who: string; verb: string; at: string; times: number }[] = [];
	for (const ev of e.history) {
		const line = historyLine(ev);
		const last = lines[lines.length - 1];
		if (last && last.who === line.who && last.verb === line.verb) last.times++;
		else lines.push({ ...line, at: ev.at, times: 1 });
	}
	if (!lines.length) return null;
	return h(
		'section',
		{ class: 'fv-section' },
		h(
			'h3',
			{ class: 'fv-section-title' },
			h('span', { class: 'fv-dot fv-dot-muted', 'aria-hidden': 'true' }),
			'History'
		),
		h(
			'ul',
			{ class: 'fv-history' },
			lines
				.slice(0, 5)
				.map((line) =>
					h(
						'li',
						{ class: 'fv-history-row' },
						h(
							'span',
							null,
							h('strong', { class: 'fv-strong' }, line.who),
							h(
								'span',
								{ class: 'fv-muted' },
								` · ${line.verb}${line.times > 1 ? ` ×${line.times}` : ''}`
							)
						),
						h('span', { class: 'fv-mono fv-muted' }, ago(line.at))
					)
				)
		)
	);
}

/** The SecretRef to paste into config (the "⋯" menu's Copy config reference). */
export const configReference = (c: Ctx, e: EntryDetail) =>
	JSON.stringify({ source: 'exec', provider: c.overview.provider_alias, id: e.reference });

/** The two-step removal (spec §9), inline in the pane. */
function confirmRemove(c: Ctx, e: EntryDetail, forever: boolean) {
	const status = h('p', { class: 'fv-error-text', role: 'alert' });
	const go = h(
		'button',
		{ class: 'fv-btn fv-btn-danger', type: 'button' },
		icon('trash', 14),
		forever ? 'Delete forever' : 'Move to Recycle Bin'
	);
	go.addEventListener('click', async () => {
		go.disabled = true;
		try {
			await c.edit(forever ? 'delete_forever' : 'recycle_entry', { path: e.path, uuid: e.uuid });
			c.go({ ...c.params, e: undefined, u: undefined, m: undefined });
		} catch (err) {
			status.textContent = (err as Error).message;
			go.disabled = false;
		}
	});
	const n = e.usages.length;
	return h(
		'div',
		{
			class: 'fv-confirm',
			role: 'group',
			'aria-label': forever ? 'Delete forever' : 'Move to Recycle Bin'
		},
		h(
			'h3',
			{ class: 'fv-confirm-title' },
			h('span', { class: 'fv-confirm-icon' }, icon('trash', 14)),
			forever ? 'Delete forever?' : 'Move to Recycle Bin?'
		),
		h(
			'p',
			{ class: 'fv-small' },
			forever
				? 'This removes it from the database for good. It cannot be undone.'
				: n
					? `OpenClaw uses this entry for ${n} setting${n > 1 ? 's' : ''}. ${n > 1 ? 'They' : 'It'} will stop working until you point ${n > 1 ? 'them' : 'it'} at another entry.`
					: 'You can move it back from the Recycle Bin by editing its group.'
		),
		n && !forever
			? h(
					'ul',
					{ class: 'fv-confirm-list' },
					e.usages.map((u) =>
						h(
							'li',
							{ title: u.config_path },
							h('span', { class: 'fv-dot fv-dot-danger', 'aria-hidden': 'true' }),
							u.label
						)
					)
				)
			: null,
		status,
		h(
			'div',
			{ class: 'fv-confirm-actions' },
			h(
				'button',
				{
					class: 'fv-btn fv-btn-quiet',
					type: 'button',
					on: { click: () => c.go({ ...c.params, m: undefined }) }
				},
				'Cancel'
			),
			go
		)
	);
}

/** The bar a phone shows over a full-screen entry: Back, the title, and one action. */
export function mobileBar(c: Ctx, title: string, action: HTMLElement | null) {
	const back =
		c.params.v === 'needs'
			? 'Needs a value'
			: c.params.v === 'recycle'
				? 'Recycle Bin'
				: c.params.g
					? c.params.g.split('/').pop()!
					: 'Vault';
	return h(
		'div',
		{ class: 'fv-mobile-bar' },
		h(
			'button',
			{
				class: 'fv-back',
				type: 'button',
				on: { click: () => c.go({ ...c.params, e: undefined, u: undefined, m: undefined }) }
			},
			icon('back'),
			back
		),
		h('span', { class: 'fv-mobile-title' }, title),
		action ?? h('span')
	);
}

/** The entry pane, reading (spec §9). */
export function entryView(c: Ctx, e: EntryDetail) {
	const p = c.params;
	const removing = p.m === 'delete' || p.m === 'forever';
	const edit = () => c.go({ ...p, m: 'edit' });
	const menu = menuButton('Entry actions', () => [
		{
			label: 'Copy config reference',
			run: () => void copyText(null, configReference(c, e)),
			disabled: !e.reference,
			hint: e.reference_problem ?? ''
		},
		{ label: 'Edit', run: edit },
		e.recycled
			? { label: 'Delete forever', run: () => c.go({ ...p, m: 'forever' }), danger: true }
			: { label: 'Move to Recycle Bin', run: () => c.go({ ...p, m: 'delete' }), danger: true }
	]);
	return h(
		'article',
		{ class: 'fv-pane', 'aria-label': e.title },
		mobileBar(
			c,
			e.title,
			h('button', { class: 'fv-btn fv-btn-text', type: 'button', on: { click: edit } }, 'Edit')
		),
		h(
			'header',
			{ class: 'fv-pane-head fv-menu-anchor' },
			h(
				'div',
				{ class: 'fv-pane-titles' },
				h('h2', { class: 'fv-pane-title' }, e.title || '(no title)'),
				h('span', { class: 'fv-muted fv-small' }, e.group ? shownPath(e.group) : 'Top level')
			),
			h(
				'div',
				{ class: 'fv-pane-actions' },
				h(
					'button',
					{ class: 'fv-btn fv-btn-text fv-desktop', type: 'button', on: { click: edit } },
					'Edit'
				),
				menu
			)
		),
		h(
			'div',
			{ class: `fv-pane-body${removing ? ' is-dimmed' : ''}` },
			e.duplicates
				? h(
						'p',
						{ class: 'fv-warn-text fv-small' },
						`${e.duplicates + 1} entries share this path. Rename one so each can be referenced.`
					)
				: null,
			h(
				'div',
				{ class: 'fv-fields' },
				plainField('Username', e.username),
				secretField(c, e),
				plainField('URL', e.url, { link: true }),
				plainField('Notes', e.notes, { multiline: true })
			),
			!e.reference && !e.recycled && e.reference_problem
				? h(
						'p',
						{ class: 'fv-muted fv-small fv-no-ref' },
						`No config reference: ${e.reference_problem}`
					)
				: null
		),
		removing ? confirmRemove(c, e, p.m === 'forever') : null,
		removing ? null : usages(e),
		removing ? null : history(e)
	);
}
