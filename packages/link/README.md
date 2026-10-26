# Falcon Link

A separately installable native OpenClaw page for Google and Microsoft connections.
Package: `@fdsouvenir/falcon-link`; plugin id: `falcon-link`.

## Preview capabilities

- Integration sidebar on desktop; integration list and slide-in details on mobile.
- OpenClaw host theme, suite styling and native chain-link navigation icon.
- Human/agent owner picker backed by OpenClaw `users.list` and `agents.list`.
- Purpose is Work, Personal, or Other with a custom label of up to 40 characters.
- Explicit permission selection, actual scope review, Google remote sign-in and Microsoft
  device-code sign-in, multiple isolated accounts, stable IDs and explicit CLI selection.
- Reconnect/change permissions, local disconnect and read-only live identity checks.
- Linux x64/arm64 CLI installation and updates from pinned GitHub releases, verified using
  GitHub's SHA-256 asset digests. Commands are ordinary executables in `~/.local/bin` on
  the Office PATH, usable directly by the agent. Unrelated existing tools and credentials
  are preserved; verified previous download copies remain available for rollback.
- Google `gog` 0.47.0 (`openclaw/gogcli`); Microsoft `m365cli` 1.0.0
  (`fdsouvenir/m365cli`), **not** the unrelated PnP CLI. Newer upstream releases are reported
  but cannot be installed until qualified in Link.

Preview release does not imply hosted customer login acceptance. Full sign-in requires the
person's provider consent. Business Microsoft consent may require a tenant administrator.
Windows/macOS installation and broker flows are not supported by this preview.

## Operator provisioning

The normal page contains no application IDs, secrets or setup forms. A fresh install loads
and reports “connection setup is incomplete; contact your administrator.”

The provisioning script preserves the Office keyring password (or generates one for a fresh
Office) and supplies `FALCON_LINK_KEYRING_PASSWORD`, `GOG_KEYRING_PASSWORD`, and
`M365CLI_KEYRING_PASSWORD` through native OpenClaw `env.vars` configuration. Restart the
Gateway after provisioning so normal agent commands inherit the CLI password variables.
Conflicting existing passwords are rejected without replacement. Losing the original key
when accounts already exist is not repaired by silently generating another key. Do not put this password in a chat, public package, or
customer page. Both CLIs use their own encrypted file keyring inside each account directory.
Losing this password requires reconnecting the affected accounts.

An operator uses the included local script, outside customer onboarding:

```sh
node scripts/provision.mjs /absolute/gateway-state/falcon-link /private/link-config.json
```

For preview use the directory `falcon-link-preview`. The input JSON supports:

```json
{
	"google_credentials_file": "/private/google-desktop-client.json",
	"microsoft_client_id": "00000000-0000-0000-0000-000000000000",
	"microsoft_tenant": "optional-tenant.example"
}
```

These are placeholders, not supplied credentials. Google requires the provider's installed/desktop
application JSON with client ID and secret, stored privately (0600). Microsoft requires an Entra
public-client registration supporting the chosen audience and device flow. The script validates
and merges existing provisioning atomically; it does not replace Gateway config or schedulers.
Configuration changes are read on each setup request; no plugin config values are exposed.

Google sign-in uses `--remote --step 1/2`, so the user's browser need not reach the Office's
localhost. After consent, the person pastes the full redirect URL in Link; CLI and Link both
check OAuth state. Redirect URLs and device codes are ephemeral, person-bound, and not logged
or persisted in the account registry. Microsoft sign-in remains in a bounded CLI process;
only the recognized Microsoft verification URL/code is surfaced, never raw stderr.

## Account facts and CLI usage

`falcon_link_accounts` lists owner, purpose, verified account identity, requested permissions,
CLI-recorded scopes (where available), connection state and last identity check. With an
`account_id`, it returns the explicit executable/account arguments and isolated configuration
environment. Passwords/tokens are never returned: the environment mapping references the
operator-provided password variable by name. The agent's existing CLI skill executes service
operations; Link does not add a second mail/calendar API implementation.

Connection permissions do **not** grant an agent permission to send mail or override standing
instructions. Owner and purpose are user-selected metadata, not an access-control grant.
No account records or instructions are written into AGENTS.md.

A compact `before_prompt_build` brief lists all human and agent accounts in private
main/dashboard sessions, grouped by gogcli and m365cli: email, owner's profile display
name, purpose and readable scopes. Failed connections are flagged. The brief also points to `falcon_link_accounts` for account selection and storage environment.
Use the returned configuration paths and account arguments with the ordinary PATH command,
keeping the inherited keyring variables. No password values or authority grants appear in
the brief, and no internal account IDs are included in its table. Public/group routes receive
no account brief and cannot enumerate accounts through the inventory tool.

Link also reads existing CLI inventories using non-interactive `gog auth list` and
`m365cli auth status`, cached for one minute. Discovered accounts retain native storage
and explicit client/profile selection. Owner and purpose remain unassigned until edited
in Link; discovery is not a live authentication check. Google stored scopes are labeled
recorded, not independently verified grants; Microsoft scopes remain unknown when the
inventory does not expose them. Discovery failures are shown as unavailable, not empty.
Reconnect and disconnect for discovered accounts remain in their original CLI; Link does
not migrate or remove their credentials. Link-created accounts retain isolated stores.
This is not an access-control boundary against agents with shell/filesystem access in the
same Office. OpenClaw governs runtime access.

Requested scopes and CLI-recorded scopes are distinct from independently verified provider
grants. Neither adapter currently exposes complete independent provider grant readback, so
`granted_scopes` remains null. Identity checks do not imply service health or tested writes.
Disconnect removes only local credentials. Changing permission selections does not revoke prior
provider consent; narrower consent may require revocation at Google/Microsoft and fresh login.

## State and recovery

Metadata lives in the plugin's own `accounts.json` (0600), written atomically. CLI state lives
under `accounts/<stable-id>/`, with a separate HOME/config and encrypted keyring per account.
Preview and stable plugin identities have separate roots; no credential migration is implied.
Sign-in cancellation, expiry, CLI errors, identity mismatch and revoked refresh all remain
non-connected states. Restarting ends pending sign-ins; existing connected accounts remain.
An uncertain exchange is not automatically retried; inspect/check that account or reconnect.

CLI download directories are immutable rollback copies. Installation atomically publishes the
verified binary to `~/.local/bin/gog` or `~/.local/bin/m365cli`, after digest and version checks.
An existing file may only be updated when its bytes match the prior installation receipt;
other tools and symlinks are preserved. Legacy private preview binaries are a fallback until
installation migrates them to PATH. For rollback, restore the previous qualified executable
in `~/.local/bin`; never change account directories or keyring passwords as rollback.

## Develop

From the repository root:

```sh
npm ci --include=dev
npm run build
npm run validate
npm test
npm run format:check
```

Native UI requires OpenClaw's Custom plugin UI lab. Validation uses repository-local build
state, never an installed production plugin. See `docs/link-spec.md` and `docs/link-qualification.md`
for acceptance limits and release evidence.

## Hosted sign-in callbacks

An operator can provision a self-hosted, version-pinned **Link Callback Worker** to
complete Google and Microsoft sign-in automatically without copying a localhost
URL or entering a device code. See [the Worker deployment guide](../../workers/link-callback/README.md).
With no callback service configured, the existing manual/device-code flows remain.
Each Office retains its CLI account stores, tokens and refresh operations. The
callback service receives only encrypted-at-rest, short-lived authorization-code
handoffs, not account tokens. Deployments supply their own hostname and provider
registration configuration; the public package contains neither.
