import type { ControlUiHost } from 'openclaw/plugin-sdk/control-ui';
import { h } from './dom.js';

type Field =
	| { id: string; label: string; kind?: 'text'; value?: string; placeholder?: string }
	| {
			id: string;
			label: string;
			kind: 'select';
			value?: string;
			options: { value: string; label: string }[];
	  };

/**
 * A small form in the host's own dialog (the host's components wherever they exist). `submit`
 * returns an error message to show in place, or nothing to close the dialog.
 */
export function formDialog(
	host: ControlUiHost,
	opts: {
		title: string;
		description?: string;
		fields: Field[];
		submitLabel: string;
		danger?: boolean;
		submit: (values: Record<string, string>) => Promise<string | void>;
	}
) {
	const values: Record<string, string> = {};
	const handles: { dispose: () => void }[] = [];
	const error = h('p', { class: 'fv-error-text', role: 'alert' });
	const inputs = opts.fields.map((f) => {
		values[f.id] = f.value ?? '';
		let control: HTMLElement;
		if (f.kind === 'select') {
			control = h('div', { class: 'fv-select' });
			if (!values[f.id] && f.options[0]) values[f.id] = f.options[0].value;
			let handle: { update: (p: never) => void; dispose: () => void };
			const props = (value: string) => ({
				options: f.options,
				value,
				accessibleLabel: f.label,
				searchable: true,
				onSelect: (v: string) => {
					values[f.id] = v;
					handle.update(props(v) as never);
				}
			});
			handle = host.components.mountSelectPicker(control, props(values[f.id])) as never;
			handles.push(handle);
		} else {
			control = h('input', {
				class: 'fv-input',
				type: 'text',
				placeholder: f.placeholder ?? '',
				'aria-label': f.label,
				on: { input: (e: Event) => (values[f.id] = (e.target as HTMLInputElement).value) }
			});
			(control as HTMLInputElement).value = values[f.id];
		}
		return h('label', { class: 'fv-field' }, h('span', { class: 'fv-label' }, f.label), control);
	});
	const holder = h('div');
	document.body.append(holder);
	const close = () => {
		for (const x of handles) x.dispose();
		dialog.dispose();
		holder.remove();
	};
	const submit = h(
		'button',
		{ class: `fv-btn ${opts.danger ? 'fv-btn-danger' : 'fv-btn-primary'}`, type: 'submit' },
		opts.submitLabel
	);
	const form = h(
		'form',
		{
			class: 'fv-dialog-form',
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
		h('h2', { class: 'fv-dialog-title' }, opts.title),
		opts.description ? h('p', { class: 'fv-muted' }, opts.description) : null,
		...inputs,
		error,
		h(
			'div',
			{ class: 'fv-dialog-actions' },
			h(
				'button',
				{ class: 'fv-btn fv-btn-quiet', type: 'button', on: { click: () => close() } },
				'Cancel'
			),
			submit
		)
	);
	const dialog = host.components.mountDialog(holder, {
		label: opts.title,
		content: form,
		returnFocusTarget: document.activeElement as HTMLElement | null,
		onCancel: () => {
			close();
		}
	});
	queueMicrotask(() => (form.querySelector('input') as HTMLElement | null)?.focus());
}

/** A message in the host's dialog, with one button. */
export function messageDialog(host: ControlUiHost, title: string, message: string) {
	formDialog(host, {
		title,
		description: message,
		fields: [],
		submitLabel: 'OK',
		submit: async () => {}
	});
}
