import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('openclaw.plugin.json'));

test('package and manifest agree on identity and version', () => {
	assert.equal(manifest.id, 'falcon-vault');
	assert.equal(pkg.name, '@fdsouvenir/falcon-vault');
	assert.equal(manifest.version, pkg.version);
	assert.deepEqual(manifest.contracts.tools, ['falcon_vault']);
});

test('the source identity is the production one', async () => {
	const { PLUGIN_ID } = await import('../dist/identity.js');
	assert.equal(PLUGIN_ID, manifest.id);
});

// Spec §5: the resolver is a manifest preset, so openclaw.json holds no file path.
test('the resolver is declared as a secret-provider integration that OpenClaw can run', async () => {
	const { INTEGRATION_ID } = await import('../dist/store/paths.js');
	const i = manifest.secretProviderIntegrations[INTEGRATION_ID];
	assert.equal(i.source, 'exec');
	assert.equal(i.command, '${node}');
	assert.match(i.args[0], /^\.\//);
	const script = new URL(`../${i.args[0]}`, import.meta.url);
	assert.ok(existsSync(script));
	assert.equal(statSync(script).mode & 0o022, 0, 'not group- or world-writable');
	assert.deepEqual(i.passEnv, ['OPENCLAW_STATE_DIR']);
	assert.ok(pkg.files.includes('bin'));
});

// Spec §10: dependencies are pure JavaScript and WebAssembly; no native modules, no host binaries.
test('dependencies are kdbxweb and hash-wasm, nothing native', () => {
	assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['hash-wasm', 'kdbxweb', 'typebox']);
	for (const dep of ['kdbxweb', 'hash-wasm']) {
		const p = JSON.parse(readFileSync(new URL(import.meta.resolve(`${dep}/package.json`)), 'utf8'));
		assert.equal(p.gypfile, undefined, `${dep} has no native build`);
		assert.equal(p.scripts?.install, undefined, `${dep} runs no install script`);
	}
});

// Spec §10: only the agent operation has a tool. Reveal, copy and writes are UI-only.
test('only the agent operation declares a tool', async () => {
	const { contract } = await import('../dist/contract.js');
	const tools = Object.entries(contract.operations)
		.filter(([, op]) => op.tool)
		.map(([name, op]) => [name, op.tool.name]);
	assert.deepEqual(tools, [['agent', 'falcon_vault']]);
	assert.equal(contract.operations.reveal.kind, 'action', 'reveal needs operator.write');
});

// Spec §9: Vault uses only the Control UI's theme — no colours or fonts of its own.
test('stylesheet uses host theme variables only', () => {
	const css = read('src/control-ui.css').replace(/\/\*[\s\S]*?\*\//g, '');
	assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'hard-coded hex colour');
	assert.doesNotMatch(css, /\b(rgb|rgba|hsl|hsla|oklch)\(/i, 'hard-coded colour function');
	assert.doesNotMatch(css, /@font-face|font-family:(?!\s*var\(--)/i, 'own font');
	assert.doesNotMatch(css, /[;{]\s*max-width\s*:/i, 'page frame'); // media queries are fine
});
