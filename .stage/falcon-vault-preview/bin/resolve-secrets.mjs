#!/usr/bin/env node
// Falcon Vault's SecretRef resolver: OpenClaw exec-provider protocol v1 (spec §5). OpenClaw
// materializes this from the manifest's `secretProviderIntegrations` and runs it with the
// Gateway's Node. Values are written to stdout only.
import { fileURLToPath } from 'node:url';
import { main, MAX_INPUT_BYTES } from '../dist/resolver.js';

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
	chunks.push(chunk);
	size += chunk.length;
	if (size > MAX_INPUT_BYTES) break; // enough to know it is too large
}
process.exitCode = await main(
	Buffer.concat(chunks).toString('utf8'),
	process.env,
	fileURLToPath(import.meta.url),
	(text) => process.stdout.write(text),
	(reason) => process.stderr.write(`${reason}\n`)
);
