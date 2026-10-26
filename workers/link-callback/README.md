# Link Callback Worker

Version **0.1.0**, protocol **1**. Self-hostable callback handoff for Falcon Link's
Google and Microsoft accounts. No Falcon-operated hostname, Cloudflare account,
provider client ID, or credential is embedded in this package.

## Boundaries

One service can serve many Offices. Each Office has a separate, random enrollment
credential; the Worker stores its SHA-256 digest in the `OFFICE_KEYS_JSON` secret.
Provisioning owns that enrollment, not customer UI. Removal from the map prevents
new sessions; existing sessions expire within ten minutes.

Sign-in starts in the authenticated Office UI. The Office generates an ephemeral
RSA-OAEP key pair and independent retrieval secret. The Worker receives the public
key, provider and OAuth state, never a private key or PKCE verifier. It accepts a
callback only for that pending provider/state and encrypts the code to the Office
using RSA-OAEP SHA-256 plus AES-256-GCM. The Office retrieves it once over outbound
HTTPS and performs the provider exchange itself. Access/refresh tokens never pass
through the Worker. The normal CLI encrypted stores and account selection remain
Office-local. Owner/purpose are local metadata, not authority grants.

Each sign-in uses its own SQLite-backed Durable Object. Atomic synchronous writes
reject duplicate callbacks, concurrent consumers and cancellation races. Logical
expiry is enforced on every operation; an alarm removes the record. Cloudflare
storage recovery can retain historical records; codes are encrypted before being
persisted and the decrypting key exists only in the originating Office's memory.
A restart, lost one-time response or interrupted exchange requires a new sign-in.
No refresh-token broker or fleet-wide account-token database is introduced.

Invocation URL logs and trace sampling are disabled to avoid recording callback
query parameters. Application error logs contain only a fixed event and version.
Do not enable request/query logging, third-party analytics or request-body tracing
on this hostname. This service has no browser-side scripts or external assets.

## Deploy

Use Node 24.16+ and `npm ci --include=dev` from the repository root. Set the
operator's Cloudflare credentials privately using Wrangler's supported environment
or login mechanism. Verify account and permissions before deployment.

Copy `wrangler.jsonc` to a private deployment config **in this directory**, preserving
its binding and migration. Add the selected account and custom domain:

```json
{
	"account_id": "<your-account>",
	"routes": [{ "pattern": "<your-callback-hostname>", "custom_domain": true }]
}
```

Merge those fields, do not replace the whole config with this snippet. The private
config must not be committed. Generate a random 32-byte base64url token for each
Office. Store the token in that Office's private file and its lowercase hex SHA-256
digest in a private JSON map, for example `{"office-id":"<sha256-digest>"}`.
For a new Worker, create a private secrets JSON file containing
`{"OFFICE_KEYS_JSON":"<JSON-encoded map>"}` and pass it with
`wrangler deploy --secrets-file /private/worker-secrets.json`. Required secrets
cannot be installed before a new Worker exists. For later updates, use
`wrangler secret put OFFICE_KEYS_JSON` with stdin (not a command-line secret
argument). Adding an Office merges into the existing map;
never silently discard other Office entries.

Run `npm run types --workspace workers/link-callback`, the build and tests. Deploy
with the private config and a release message identifying `0.1.0` plus the source
commit. Record the returned Cloudflare version ID and `/health` response. Preserve
both the semver and Cloudflare version ID for rollback. Never roll back a Durable
Object class migration by deleting its namespace or data. Start with one test
Office, not the fleet. No paid plan or product upgrade is required by this recipe;
qualify the target account's existing entitlements before deployment.

## Provider and Office configuration

Register exactly these redirect URIs, substituting the operator's hostname:

- Google **web-application** client: `https://<host>/oauth2/callback/google`.
  Keep an existing desktop client for manual login; do not alter its type.
- Microsoft **mobile/desktop public client**: `https://<host>/oauth2/callback/microsoft`.
  Enable authorization code + PKCE; preserve existing device-code settings and
  permitted personal/business audiences. Do not use an SPA redirect (its refresh
  tokens expire after 24 hours). No Microsoft application secret is needed for
  the public-client flow. If an operator chooses a confidential client instead,
  provision its secret privately on the Office for exchange and CLI refresh.

Use Link's operator-only `scripts/provision.mjs` to merge:

```json
{
	"google_credentials_file": "/private/google-web-client.json",
	"microsoft_client_id": "<your-application-id>",
	"callback": {
		"url": "https://<your-callback-hostname>",
		"office": "<permanent-office-id>",
		"token_file": "/private/link-callback-token",
		"version": "0.1.0"
	}
}
```

Files must be private (0600), and the usual `FALCON_LINK_KEYRING_PASSWORD` remains
required. Link refuses a Worker version/protocol mismatch. With no `callback`
configuration, Google manual and Microsoft device-code login remain available.
No grant-verification feature is implied by callback delivery.

## Checks

`npm run build --workspace workers/link-callback` performs typecheck and packaging
with the pinned Wrangler. `npm test --workspace workers/link-callback` exercises the
actual Workers runtime: provider binding, Office enrollment, encrypted handoff,
wrong claimant, concurrent consume, replay, cancellation and denial. Provider
consent and live Office token refresh are separate acceptance checks.
