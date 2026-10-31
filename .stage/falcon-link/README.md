# Falcon Link

A separately installable native OpenClaw page for connecting Google, Microsoft and HubSpot
accounts.
Package: `@fdsouvenir/falcon-link`; plugin id: `falcon-link`.

## What it does

- Lists each person's and agent's Google, Microsoft and HubSpot accounts with their owner, purpose and
  access in plain words. A connected account shows no status; otherwise it shows Needs
  attention, Signing in… or Not connected.
- Adds accounts, changes their access, checks them and removes them — including accounts
  already present in the CLIs' own stores. Removing an account deletes its saved sign-in from
  the CLI's store and removes it from Link's list.
- Uses the existing command-line tools for everything provider-specific:
  [gog](https://github.com/openclaw/gogcli) for Google and
  [m365cli](https://github.com/fdsouvenir/m365cli) for Microsoft (not the unrelated PnP CLI)
  and HubSpot's Agent CLI `hubspot` for HubSpot. Link does not implement a second mail,
  calendar or CRM client.
- Installs HubSpot's official Agent CLI skills for every agent (see below).

## Permissions

The permission form has one row per service, each with a single choice. Rows come from the
CLIs themselves, so they follow the installed version:

- **Google** — Email uses gog's Gmail modes: Read; Send only; Read and send; Read, write
  drafts and send; Full access (read, send, organize and delete to trash, and change mail
  settings, including forwarding and delegation). Calendar,
  Contacts, Drive and every other user service from `gog auth services --json` offer Read or
  Read and change where gog has a read-only variant, otherwise On. One `gog auth add` command
  requests every row's level. People is gog's OpenID profile scope and is not a choice.
- **Microsoft** — rows come from `m365cli auth workloads --json`. New connections are
  offered every workload that is not a compatibility bundle. Email is Off / Read / Read and
  change, with sending as a separate choice because Microsoft grants it separately. Rows say
  when they are for work or school accounts only, or need approval from the organization's
  administrator. Accounts saved with bundle workloads keep working; changing their access
  preselects the equivalent rows.

Provider scope strings appear only under the form's collapsed Technical details. After
Microsoft sign-in and on Check connection, Link reads `m365cli auth check`'s grant report.
Each account card lists its access under "Access": the access Microsoft granted when it
reports the grant, otherwise the selection; for Google, the access gog recorded at sign-in.
Selected Microsoft permissions that Microsoft did not grant are named on the card.

## Sign-in

When the operator configured the hosted callback (see below), Google and Microsoft sign-in
complete automatically after consent. Otherwise Google uses gog's remote flow (paste the
address shown in the browser after signing in) and Microsoft uses m365cli's device code.
Microsoft sign-in lets m365cli detect personal or work accounts (`--audience auto`); work-only
workloads and a provisioned tenant use the work audience.

Accounts found in a CLI's own store are managed in that store with its own selection
(gog: email and OAuth client; m365cli: profile). Link never replaces that store's OAuth client.
The hosted callback is used for them only when their OAuth client is the provisioned Link
client; otherwise the manual or device-code flow is used.

Cancelling sign-in leaves everything as it was. Changing access doesn't remove access
already given; the page links to Google's or Microsoft's app-access page for that.

## HubSpot

HubSpot uses HubSpot's Agent CLI (`hubspot`, 0.16.0 or later). Nothing needs provisioning:
sign-in goes through HubSpot's own CLI app and code page, so there is no Link client or
callback.

- **Connect to HubSpot** runs `hubspot auth login url` in the account's own store, opens
  HubSpot's approval page, and the person pastes the code HubSpot shows. Link runs
  `hubspot auth login exchange --code …`, then `hubspot whoami --format json` confirms the
  HubSpot account (portal), the user and the permissions granted. People choose permissions
  on HubSpot's page; the card lists what was granted in plain words.
- **Use a service key** checks the pasted key with `whoami` and keeps it only in that
  account's `.config/hubspot/.env` (0600), never in `accounts.json`, responses or logs.
  HubSpot CLI 0.16.0 does not read `.env` files itself, so Link passes the key as
  `HUBSPOT_ACCESS_TOKEN` when it runs the CLI for that account. The card is labelled Admin:
  a service key works for the whole HubSpot account with no per-user audit trail.
- Plain messages cover administrator approval (App Governance), no permissions granted, the
  wrong HubSpot account or user, and expired codes. Raw CLI output is never shown or saved.
- `HUBSPOT_ACCESS_TOKEN` and `HUBSPOT_PORTAL_ID` from the Gateway environment are removed
  for every account; each account selects its own store and portal.
- Existing logins in the CLI's own store are found with `hubspot auth list`. Removing an
  account runs `hubspot auth logout` for that HubSpot account; Falcon Link stays in HubSpot's
  Connected apps until it is removed there, and the page links to it.

### HubSpot skills

Link installs HubSpot's official skills from
[HubSpot/agent-cli-skills](https://github.com/HubSpot/agent-cli-skills) (Apache-2.0) once,
into OpenClaw's shared managed skills directory (`<state>/skills`), so every agent on the
Office has them. There is no per-agent choice. No community ClawHub HubSpot skills are used.

`skills-sh:HubSpot/agent-cli-skills/<slug>` does not resolve on ClawHub, so Link resolves the
repository's `main` to a commit, downloads that commit's tarball from the GitHub API, checks it
holds a single folder for that commit and only plain files, and installs each skill folder
with `openclaw skills install <folder> --as hubspot-<slug> --global --force`. The skill's
`name` is set to the same `hubspot-<slug>` (the repository has one called `work`) with a
comment saying so, and the license is copied in; nothing else changes.

The HubSpot page has one row: Installed, Update available (the repository moved on) or
Install, plus Remove. Installing or updating the CLI also brings the skills up to date unless
someone removed them. Link records the installed commit in `skills/hubspot.json`, removes
skills dropped upstream, and removes only skills whose OpenClaw source record points at
Link's own staging copy. The `openclaw` command must be on the Gateway's PATH.

## Command-line tools

Link needs gog 0.44.0 or later, m365cli 2.1.0 or later and hubspot 0.16.0 or later. On Linux
x64/arm64 Link installs the latest GitHub release of gog and m365cli, and HubSpot's published
`hubspot-linux-<arch>.bin` checked against its `hubspot-linux-<arch>.sha256`, as ordinary
commands in `~/.local/bin` (which must be on the Office PATH). Link never runs HubSpot's
`install.sh`, which edits shell startup files. Installation checks the known repository, the expected asset name,
GitHub's SHA-256 asset digest and size/time bounds. Link updates only a command it installed
(its bytes match Link's installation receipt) and keeps previous copies for rollback; it
never overwrites a tool installed some other way. The page checks for a newer release when
it loads (cached for about an hour) and offers Update when one is available.

The HubSpot CLI updates itself. Link doesn't pin or block that: an update is available when
HubSpot's published SHA-256 differs from the installed binary, and Update runs
`hubspot upgrade`. Link knows it installed `hubspot` from its receipt's path, so a binary
that changed through its own update is still Link's, not "installed outside Link".

On other systems, install the tools yourself; sign-in, discovery and account management work
whenever the tool is present.

## Operator provisioning

The page contains no application IDs, secrets or setup forms. Without provisioning it says
that sign-in isn't set up on this Office. An operator runs the included script outside
customer onboarding:

```sh
node scripts/provision.mjs /absolute/gateway-state/falcon-link /private/link-config.json
```

The input JSON supports (placeholders shown):

```json
{
	"google_credentials_file": "/private/google-client.json",
	"microsoft_client_id": "00000000-0000-0000-0000-000000000000",
	"microsoft_tenant": "optional-tenant.example",
	"microsoft_client_secret_file": "/private/microsoft-secret",
	"callback": {
		"url": "https://link-callback.example",
		"office": "office-id",
		"token_file": "/private/callback-token",
		"version": "0.1.1"
	}
}
```

Google needs the provider's client JSON (0600): a web client when the hosted callback is
configured, otherwise a desktop client. Microsoft needs an Entra application registration.
The script validates and merges existing provisioning atomically.

Keyring passwords: gog stores use `GOG_KEYRING_PASSWORD` and m365cli stores use
`M365CLI_KEYRING_PASSWORD`; `FALCON_LINK_KEYRING_PASSWORD` is used only when a CLI-specific
variable is unset. The script never overwrites or rotates an existing value. It fills a
missing CLI variable from `FALCON_LINK_KEYRING_PASSWORD` when that is set, and otherwise
generates one only when that CLI has no Link-managed accounts. It sets the values through
native OpenClaw `env.vars` configuration, so normal agent commands inherit them, and sets
`plugins.entries.<plugin-id>.hooks.allowConversationAccess=true` for the account-facts hook.
Restart the Gateway afterwards.

## Hosted sign-in callbacks

An operator can deploy the self-hostable
[Link Callback Worker](../../workers/link-callback/README.md) (version 0.1.1, protocol 1) and
set `callback` in provisioning; `callback.version` must match the deployed Worker. Hosted
sign-in is used first when it is configured. Microsoft authorization uses the `common`
authority unless `microsoft_tenant` is provisioned. Each Office keeps its CLI account
stores, tokens and refreshes; the Worker only relays short-lived, encrypted authorization
codes.

## Account facts for agents

`falcon_link_accounts` lists accounts with owner, purpose, connection state and selected,
recorded or granted scopes. With `account_id` it returns the CLI arguments and storage
environment for that account. The CLIs are on the normal PATH and the keyring password
variables are already present in the command environment.

For a HubSpot account it returns `HUBSPOT_PORTAL_ID` and the account's own
`XDG_CONFIG_HOME`, plus a `command_prefix` such as
`env -u HUBSPOT_ACCESS_TOKEN XDG_CONFIG_HOME='…' HUBSPOT_PORTAL_ID='…' '/home/…/hubspot'`,
because OpenClaw's exec refuses XDG overrides in its `env` parameter. A service-key account's
prefix reads the key from its file when the command runs, so the key never appears in the
conversation.

A compact `before_prompt_build` brief lists the same accounts. Account facts are omitted in
group, channel and room conversations and provided in every other session.

## State and recovery

Metadata lives in the plugin's `accounts.json` (0600), written atomically. Accounts created
by Link keep their CLI state under `accounts/<stable-id>/`, with an encrypted file keyring per
account; accounts found in a CLI's own store stay there. Restarting ends pending sign-ins;
connected accounts remain. Losing a keyring password requires reconnecting the affected
accounts. For a tool rollback, restore a previous copy into `~/.local/bin`; never change
account directories or keyring passwords.

## Adding an integration

Each integration is one folder, `src/providers/<id>/`: `ui.ts` (name, permission mapping,
access labels, revoke links; safe for the browser) and `index.ts` (tool source and minimum
version, setup check, sign-in methods, discovery, connection check, removal, per-account
environment, agent invocation and optional skills). Register it in `src/providers/index.ts`
and `src/providers/ui.ts`. Optional provider artwork is keyed by ID in `src/control-ui.ts`.

## Develop

From the repository root:

```sh
npm ci --include=dev
npm run build
npm run validate
npm test
npm run format:check
```

The page requires OpenClaw's Custom plugin UI lab. Validation uses repository-local build
state, never an installed plugin. See `docs/link-spec.md` and `docs/link-qualification.md`.
