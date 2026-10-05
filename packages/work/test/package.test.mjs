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
