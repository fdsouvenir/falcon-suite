import type { Ctx } from './app.js';
import { h } from './dom.js';

type Field =
	| { id: string; label: string; kind?: 'text' | 'textarea'; value?: string; placeholder?: string }
	| {
			id: string;
			label: string;
			kind: 'select';
			value?: string;
			options: { value: string; label: string }[];
	  };

/**
 * A small form in the host's own dialog (spec §12, Look: the host's components wherever they
 * exist). `submit` returns an error message to show in place, or nothing to close the dialog.
 */
export function formDialog(
	c: Ctx,
	opts: {
		title: string;
		description?: string;
		fields: Field[];
		submitLabel: string;
		submit: (values: Record<string, string>) => Promise<string | void>;
	}
) {
	const values: Record<string, string> = {};
	const handles: { dispose: () => void }[] = [];
	const error = h('p', { class: 'fw-error-text', role: 'alert' });
	const inputs = opts.fields.map((f) => {
		values[f.id] = f.value ?? '';
		let control: HTMLElement;
		if (f.kind === 'select') {
			control = h('div', { class: 'fw-select' });
			if (!values[f.id] && f.options[0]) values[f.id] = f.options[0].value;
			let handle: { update: (p: never) => void; dispose: () => void };
			const props = (value: string) => ({
				options: f.options,
				value,
				accessibleLabel: f.label,
				onSelect: (v: string) => {
					values[f.id] = v;
					handle.update(props(v) as never);
				}
			});
			handle = c.host.components.mountSelectPicker(control, props(values[f.id])) as never;
			handles.push(handle);
		} else {
			control = h(f.kind === 'textarea' ? 'textarea' : 'input', {
				class: `fw-input${f.kind === 'textarea' ? ' fw-textarea' : ''}`,
				...(f.kind === 'textarea' ? { rows: 3 } : { type: 'text' }),
				placeholder: f.placeholder ?? '',
				'aria-label': f.label,
				on: { input: (e: Event) => (values[f.id] = (e.target as HTMLInputElement).value) }
			});
			(control as HTMLInputElement).value = values[f.id];
		}
		return h(
			'label',
			{ class: 'fw-field' },
			h('span', { class: 'fw-field-label' }, f.label),
			control
		);
	});
	const host = h('div');
	document.body.append(host);
	const close = () => {
		for (const x of handles) x.dispose();
		dialog.dispose();
		host.remove();
	};
	const submit = h('button', { class: 'fw-btn fw-btn-primary', type: 'submit' }, opts.submitLabel);
	const form = h(
		'form',
		{
			class: 'fw-dialog-form',
			on: {
				submit: async (e: Event) => {
					e.preventDefault();
					submit.disabled = true;
					error.textContent = '';
					try {
						const problem = await opts.submit(values);
						if (problem) error.textContent = problem;
						else close();
					} catch (err) {
						error.textContent = (err as Error).message;
					} finally {
						submit.disabled = false;
					}
				}
			}
		},
		h('h2', { class: 'fw-dialog-title' }, opts.title),
		opts.description ? h('p', { class: 'fw-muted' }, opts.description) : null,
		...inputs,
		error,
		h(
			'div',
			{ class: 'fw-dialog-actions' },
			h('button', { class: 'fw-btn', type: 'button', on: { click: () => close() } }, 'Cancel'),
			submit
		)
	);
	const dialog = c.host.components.mountDialog(host, {
		label: opts.title,
		content: form,
		returnFocusTarget: document.activeElement as HTMLElement | null,
		onCancel: () => {
			close();
		}
	});
	queueMicrotask(() => (form.querySelector('input,textarea') as HTMLElement | null)?.focus());
}

/** A message in the host's dialog, with one button. */
export function messageDialog(c: Ctx, title: string, message: string) {
	formDialog(c, {
		title,
		description: message,
		fields: [],
		submitLabel: 'OK',
		submit: async () => {}
	});
}
