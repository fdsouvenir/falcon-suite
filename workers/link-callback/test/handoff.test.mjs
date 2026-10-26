import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, webcrypto } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const token = randomBytes(32).toString('base64url');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const mf = new Miniflare(
	convertV4MiniflareOptions({
		modules: true,
		scriptPath: new URL('../dist/index.js', import.meta.url).pathname,
		compatibilityDate: '2026-10-26',
		durableObjects: { SESSIONS: { className: 'CallbackSession', useSQLite: true } },
		bindings: { OFFICE_KEYS_JSON: JSON.stringify({ bravo: sha(token) }) }
	})
);
after(() => mf.dispose());
const call = (route, options) => mf.dispatchFetch('https://callback.example' + route, options);
async function start(provider = 'google') {
	const state = randomBytes(32).toString('base64url'),
		poll = randomBytes(32).toString('base64url');
	const keys = await webcrypto.subtle.generateKey(
		{
			name: 'RSA-OAEP',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256'
		},
		true,
		['encrypt', 'decrypt']
	);
	const body = {
		provider,
		state,
		poll_hash: sha(poll),
		public_key: await webcrypto.subtle.exportKey('jwk', keys.publicKey)
	};
	const options = {
		method: 'POST',
		headers: {
			Authorization: 'Bearer ' + token,
			'X-Link-Office': 'bravo',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	};
	const r = await call('/v1/sessions', options);
	assert.equal(r.status, 201);
	const { id } = await r.json();
	return { state, poll, keys, id, options };
}
const consume = (s, poll = s.poll, method = 'POST') =>
	call('/v1/sessions/' + s.id, { method, headers: { Authorization: 'Bearer ' + poll } });
async function decrypt(s, envelope) {
	const key = await webcrypto.subtle.decrypt(
		'RSA-OAEP',
		s.keys.privateKey,
		Buffer.from(envelope.key, 'base64')
	);
	const aes = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
	return JSON.parse(
		Buffer.from(
			await webcrypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64') },
				aes,
				Buffer.from(envelope.ciphertext, 'base64')
			)
		).toString()
	);
}
test('health identifies the versioned public protocol', async () => {
	const r = await call('/health');
	assert.equal(r.headers.get('Cache-Control'), 'no-store');
	assert.deepEqual(await r.json(), { name: 'Link Callback Worker', version: '0.1.0', protocol: 1 });
});
test('unregistered Offices cannot create handoffs, including prototype property names', async () => {
	for (const office of ['alpha', 'toString', '__proto__'])
		assert.equal(
			(
				await call('/v1/sessions', {
					method: 'POST',
					headers: { Authorization: 'Bearer ' + token, 'X-Link-Office': office }
				})
			).status,
			401
		);
});
test('Google and Microsoft callbacks are encrypted to their originating Office; replay and cross-provider callbacks fail', async () => {
	for (const provider of ['google', 'microsoft']) {
		const s = await start(provider);
		assert.equal((await consume(s)).status, 202);
		assert.equal((await call('/v1/sessions', s.options)).status, 409);
		assert.equal(
			(
				await call(
					`/oauth2/callback/${provider === 'google' ? 'microsoft' : 'google'}?state=${s.state}&code=test-code`
				)
			).status,
			400
		);
		const r = await call(`/oauth2/callback/${provider}?state=${s.state}&code=test-code`);
		assert.equal(r.status, 200);
		assert.equal(r.headers.get('Referrer-Policy'), 'no-referrer');
		assert.doesNotMatch(await r.text(), /test-code/);
		assert.equal(
			(await call(`/oauth2/callback/${provider}?state=${s.state}&code=second-code`)).status,
			400
		);
		const envelope = await (await consume(s)).json();
		assert.doesNotMatch(JSON.stringify(envelope), /test-code/);
		assert.deepEqual(await decrypt(s, envelope), { provider, state: s.state, code: 'test-code' });
		assert.equal((await consume(s)).status, 404);
	}
});
test('another session or Office cannot claim a result; only one concurrent consumer wins', async () => {
	const a = await start(),
		b = await start();
	await call(`/oauth2/callback/google?state=${a.state}&code=test-code`);
	assert.equal((await consume(a, b.poll)).status, 404);
	const responses = await Promise.all([consume(a), consume(a)]);
	assert.deepEqual(responses.map((r) => r.status).sort(), [200, 404]);
	const envelope = await responses.find((r) => r.status === 200).json();
	await assert.rejects(() => decrypt(b, envelope));
});
test('cancelled sessions cannot accept late callbacks and missing/invalid states fail closed', async () => {
	const s = await start();
	assert.equal((await consume(s, s.poll, 'DELETE')).status, 200);
	assert.equal((await call(`/oauth2/callback/google?state=${s.state}&code=late`)).status, 400);
	assert.equal((await consume(s)).status, 404);
	assert.equal((await call('/oauth2/callback/google?state=missing&code=code')).status, 400);
	assert.equal(
		(
			await call(
				'/oauth2/callback/google?state=' + randomBytes(32).toString('base64url') + '&code=code'
			)
		).status,
		400
	);
});
test('provider denial is delivered once without reflecting provider diagnostics', async () => {
	const s = await start('microsoft');
	await call(
		`/oauth2/callback/microsoft?state=${s.state}&error=access_denied&error_description=private-diagnostic`
	);
	const result = await decrypt(s, await (await consume(s)).json());
	assert.equal(result.error, 'consent_not_completed');
	assert.doesNotMatch(JSON.stringify(result), /private-diagnostic/);
});
