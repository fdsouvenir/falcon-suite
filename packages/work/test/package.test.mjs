import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('openclaw.plugin.json'));

test('package and manifest agree on identity and version', () => {
	assert.equal(manifest.id, 'falcon-work');
	assert.equal(manifest.version, pkg.version);
});

// Spec §12 (Look): Work uses only the Control UI's theme — no colours or fonts of its own.
test('stylesheet uses host theme variables only', () => {
	const css = read('src/control-ui.css').replace(/\/\*[\s\S]*?\*\//g, '');
	assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'hard-coded hex colour');
	assert.doesNotMatch(css, /\b(rgb|rgba|hsl|hsla|oklch)\(/i, 'hard-coded colour function');
	assert.doesNotMatch(css, /@font-face|font-family:(?!\s*var\(--)/i, 'own font');
	assert.doesNotMatch(css, /[;{]\s*max-width\s*:/i, 'page frame'); // media queries are fine
});

test('the source identity is the production one', async () => {
	const { PLUGIN_ID } = await import('../dist/identity.js');
	assert.equal(PLUGIN_ID, manifest.id);
});

test('the gates the plugin runs are the gates the evaluation measured', async () => {
	const { readFileSync } = await import('node:fs');
	const g = await import('../dist/plugin/gates.js');
	const measured = JSON.parse(readFileSync(new URL('../eval/gates.json', import.meta.url), 'utf8'));
	assert.deepEqual(JSON.parse(JSON.stringify(g.LEFT_WAITING)), measured.left_waiting.question);
	const q = g.answersQuestion('{id}');
	const t = measured.answers_open_item.question_template;
	assert.deepEqual(q.instructions, t.instructions);
	assert.deepEqual(q.criteria, t.criteria);
	assert.deepEqual(
		g.answersDecision('{id}', {}).instructions,
		measured.answers_open_item.decision_template.instructions
	);
});
