import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const moduleUrl = new URL('../dist/status.js', import.meta.url).href;

// Exercise the real child-process boundary, not a mocked version of the probe.
// Each fixture gets its own PATH in a child, so no test can alter another test's CLI.
async function inspect(script) {
	const dir = await mkdtemp(path.join(tmpdir(), 'falcon-link-'));
	try {
		if (script !== undefined)
			await writeFile(path.join(dir, 'gog'), `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
		const { stdout } = await run(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`import { overview } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await overview()));`
			],
			{ env: { ...process.env, PATH: dir }, timeout: 10000 }
		);
		return JSON.parse(stdout);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('reports the documented version, without exposing build output or inspecting accounts', async () => {
	const result = await inspect(
		`if (JSON.stringify(process.argv.slice(2)) !== '["--version"]') process.exit(9); console.log('v0.45.0 (abc123 2026-10-22)');`
	);
	assert.deepEqual(result.integrations[0].tool, { state: 'installed', version: 'v0.45.0' });
	assert.equal(result.integrations[1].tool.state, 'not_installed');
	assert.ok(result.integrations.every((i) => i.setup.state === 'setup_required'));
});

test('an absent executable is not installed', async () => {
	const result = await inspect();
	assert.deepEqual(result.integrations[0].tool, { state: 'not_installed', version: null });
});

test('a failing executable is not mistaken for an absent tool and output stays private', async () => {
	const result = await inspect(
		"console.error('private diagnostic'); console.log('private output'); process.exit(1);"
	);
	assert.equal(result.integrations[0].tool.state, 'check_failed');
	assert.doesNotMatch(JSON.stringify(result), /private diagnostic|private output/);
});

test('unexpected or multiline version output remains unknown and is not reflected', async () => {
	for (const output of [
		'development build',
		'0.45.0\nprivate diagnostic',
		'<img src=x onerror=alert(1)>'
	]) {
		const result = await inspect(`console.log(${JSON.stringify(output)});`);
		assert.deepEqual(result.integrations[0].tool, { state: 'unrecognized_version', version: null });
		assert.doesNotMatch(JSON.stringify(result), /private diagnostic|<img/);
	}
});

test('an unresponsive CLI is bounded and does not become not-installed', async () => {
	const result = await inspect('setInterval(() => {}, 1000);');
	assert.equal(result.integrations[0].tool.state, 'check_failed');
});
