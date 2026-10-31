import { h, icon } from './dom.js';

export type MenuItem = {
	label: string;
	run: () => void;
	disabled?: boolean;
	/** Why it is disabled, shown as its tooltip. */
	hint?: string;
	danger?: boolean;
};

let open: { close: () => void } | null = null;

/**
 * A "⋯" button that opens a small menu beside it. One menu is open at a time; it closes on a
 * choice, Escape, or a click elsewhere. The host has no menu component, so this is the page's own.
 */
export function menuButton(label: string, items: () => MenuItem[], extra = '') {
	const button = h(
		'button',
		{
			class: `fv-icon-btn fv-menu-btn ${extra}`.trim(),
			type: 'button',
			title: label,
			'aria-label': label,
			'aria-haspopup': 'menu',
			'aria-expanded': 'false'
		},
		icon('more')
	);
	button.addEventListener('click', (e) => {
		e.stopPropagation();
		const wasMine = button.getAttribute('aria-expanded') === 'true';
		open?.close();
		if (wasMine) return;
		const list = h('div', { class: 'fv-menu', role: 'menu' });
		for (const item of items())
			list.append(
				h(
					'button',
					{
						class: `fv-menu-item${item.danger ? ' is-danger' : ''}`,
						type: 'button',
						role: 'menuitem',
						disabled: !!item.disabled,
						title: item.disabled ? (item.hint ?? '') : '',
						on: {
							click: (ev: Event) => {
								ev.stopPropagation();
								close();
								item.run();
							}
						}
					},
					item.label
				)
			);
		const anchor = button.closest<HTMLElement>('.fv-menu-anchor') ?? button.parentElement!;
		anchor.append(list);
		button.setAttribute('aria-expanded', 'true');
		const onDoc = (ev: Event) => {
			const t = ev.target as Node;
			if (!list.contains(t) && !button.contains(t)) close();
		};
		const onKey = (ev: KeyboardEvent) => {
			if (ev.key === 'Escape') {
				close();
				button.focus();
			}
		};
		function close() {
			list.remove();
			button.setAttribute('aria-expanded', 'false');
			document.removeEventListener('click', onDoc, true);
			document.removeEventListener('keydown', onKey);
			if (open === handle) open = null;
		}
		const handle = { close };
		open = handle;
		document.addEventListener('click', onDoc, true);
		document.addEventListener('keydown', onKey);
		(list.querySelector('button:not([disabled])') as HTMLElement | null)?.focus();
	});
	return button;
}

/** Close whatever menu is open (on navigation). */
export const closeMenus = () => open?.close();
