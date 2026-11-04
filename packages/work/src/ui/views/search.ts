import type { Ctx } from '../app.js';
import { h, count } from '../dom.js';
import { backLink, empty, itemLink, kindChip, searchField } from '../parts.js';
import type { SearchHit } from '../types.js';

/** Search results: Jobs, Projects and Tasks whose words match. */
export async function searchView(c: Ctx, q: string) {
	const hits = q
		? ((await c.read<{ results?: SearchHit[] }>({ view: 'search', text: q })).results ?? [])
		: [];
	return h(
		'div',
		{ class: 'fw-detail' },
		h(
			'header',
			{ class: 'fw-detail-head' },
			backLink(c),
			h(
				'div',
				{ class: 'fw-home-head' },
				h('h1', { class: 'fw-title' }, 'Search'),
				searchField(c, q)
			),
			h(
				'p',
				{ class: 'fw-meta' },
				q ? `${count(hits.length, 'result')} for “${q}”` : 'Type words to find.'
			)
		),
		hits.length
			? h(
					'div',
					{ class: 'fw-results' },
					hits.map((r) =>
						h(
							'article',
							{ class: 'fw-result-row' },
							kindChip(r.kind),
							h(
								'div',
								{ class: 'fw-result-main' },
								itemLink(c, r, 'fw-item-link fw-result-title'),
								r.status_line ? h('p', { class: 'fw-card-line' }, r.status_line) : null
							)
						)
					)
				)
			: q
				? empty('Nothing matches.')
				: null
	);
}
