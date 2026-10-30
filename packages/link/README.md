# Falcon Link

A separately installable native OpenClaw page for connecting Google, Microsoft, HubSpot,
Dropbox and ZoomInfo accounts.
Package: `@fdsouvenir/falcon-link`; plugin id: `falcon-link`.

## What it does

- Lists each person's and agent's Google, Microsoft, HubSpot, Dropbox and ZoomInfo accounts with their owner, purpose and
  access in plain words. A connected account shows no status; otherwise it shows Needs
  attention, Signing in… or Not connected.
- Adds accounts, changes their access, checks them and removes them — including accounts
  already present in the CLIs' own stores. Removing an account deletes its saved sign-in from
  the CLI's store and removes it from Link's list.
- Uses the existing command-line tools for everything provider-specific:
  [gog](https://github.com/openclaw/gogcli) for Google and
  [m365cli](https://github.com/fdsouvenir/m365cli) for Microsoft (not the unrelated PnP CLI)
  HubSpot's Agent CLI `hubspot` for HubSpot, Dropbox's
  [dbxcli](https://github.com/dropbox/dbxcli) for Dropbox and ZoomInfo's
  [gtm](https://github.com/Zoominfo/gtm-ai-cli) for ZoomInfo. Link does not implement a second
  mail, calendar, CRM, file or sales-data client.
- Installs HubSpot's and ZoomInfo's official agent skills for every agent (see below).

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
- **Dropbox** — Link's own rows (see Dropbox below): Files, Sharing, File requests, Contacts and
  Account, plus a collapsed team administration section for team admins.

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

## Dropbox

Dropbox uses Dropbox's official CLI, [dbxcli](https://github.com/dropbox/dbxcli) (3.5.0 or
later), not the Dropbox desktop sync app. The operator provisions only the Falcon Link Dropbox
app key (`dropbox_app_key`); the app is a public (PKCE) client with no secret.

- **Permissions.** One row per area, each a single choice in plain words:
  - Files: Off / View files (`files.metadata.read`, `files.content.read`) / View and change
    files (adds `files.metadata.write`, `files.content.write`).
  - Sharing: Off / See shared links and folders (`sharing.read`) / Share files and manage links
    (adds `sharing.write`).
  - File requests and Contacts: Off / See / Create and manage (or Manage).
  - Account: `account_info.read` is always included so Link can confirm the account; a checkbox
    adds `account_info.write`.
  - **Dropbox team administration — for team admins**, collapsed: Team info, Members (plus
    "Remove members from the team" with Manage), Groups, Team files and folders (plus
    "Permanently delete files (can't be recovered)" with View and change, because Dropbox
    allows `files.permanent_delete` only in a team sign-in), Sharing and
    governance policies, Sign-in sessions and Activity log, each Off / See / Manage.
- **Why team administration is a second sign-in.** Dropbox links any authorization that asks
  for a team scope to the whole team rather than the person, and such a token reaches a person's
  files only on their behalf (`Dropbox-API-Select-User`, dbxcli `--as-member`). So Link asks
  for the person's choices in one sign-in and the team choices in a second one that a team admin
  approves, and says so on the form. The team sign-in always includes `team_info.read` so Link
  can confirm the team and `team_data.member`, without which Dropbox refuses any team sign-in
  (`scope_team_data_member_required`). The approving team must be the account's own team.
- **Sign-in.** Link builds Dropbox's authorize address itself (PKCE S256,
  `token_access_type=offline`, `scope` = the chosen scopes) because `dbxcli login` sends no
  scope and would get every scope the app allows. With the hosted callback configured, sign-in
  returns automatically (`/oauth2/callback/dropbox`); otherwise Dropbox shows a code to paste.
  Link exchanges the code at `https://api.dropboxapi.com/oauth2/token` and requires the granted
  `scope` to include every chosen scope. Nothing is saved until every sign-in has finished.
- **Storage.** Link writes the account's own dbxcli auth file
  (`accounts/<id>/.config/dbxcli/auth.json`, 0600, in dbxcli's format): the person's credential
  under `personal`, the team credential under `teamManage` (`dbxcli team …`) and, with Team
  files, `teamAccess` (`--as-member`), each with its refresh token and the app key dbxcli
  refreshes with. dbxcli keeps this file unencrypted; it is readable only by the Office user.
- **Checks.** `dbxcli account --output=json` confirms the account (and that a reconnect is the
  same account); with team administration, `dbxcli team info --output=json` confirms it is the
  account's team. The card lists the access Dropbox granted at sign-in in plain words.
- **Existing sign-ins.** An account in dbxcli's own store (`DBXCLI_AUTH_FILE`, otherwise
  `~/.config/dbxcli/auth.json`) is listed, can be checked, reconnected and removed. Removing an
  account deletes its dbxcli auth file; Link doesn't revoke the token at Dropbox, and the page
  links to Dropbox's connected apps page.

## ZoomInfo

ZoomInfo uses ZoomInfo's official CLI, [gtm](https://github.com/Zoominfo/gtm-ai-cli) (MIT).
ZoomInfo needs a paid license (GTM.ai self-serve or Enterprise); the account's plan, credits and
admin settings decide what it can do. Nothing needs provisioning.

- **One account per Office.** gtm keeps its sign-in in `~/.config/gtm-ai` with no way to point
  it elsewhere, so an Office has one ZoomInfo account. While one exists the page offers no Add
  account and says why.
- **Sign-in uses gtm's own app.** ZoomInfo registers sign-in apps only for approved vendors, so
  Link doesn't register its own and doesn't use gtm's vendor name itself: it runs
  `gtm auth login`, which registers and signs in as gtm normally does. That app returns only
  to `http://localhost:9876/callback` on the computer running gtm — the Office — so the
  person's browser ends on a page that can't be reached. Before the person goes to sign in, the
  page shows a large warning with numbered steps: the error page is expected; copy the whole
  address from the address bar and paste it back here within 5 minutes. Sign-in opens in a new
  tab and the warning stays next to the paste box while Link waits.
- **How the address gets back.** Link starts `gtm auth login` with its own `xdg-open` and
  `open` commands (which do nothing) first on its PATH, so gtm can't open a browser on the
  Office's desktop and prints the sign-in address instead; Link shows that address. When the
  person pastes the address (text around it is fine), Link requires `localhost` or
  `127.0.0.1` and `/callback`, sends its query string unchanged to the waiting gtm on
  `127.0.0.1:9876`, waits for gtm to finish, then confirms the account with
  `gtm auth whoami`. gtm checks the state, exchanges the code and saves the sign-in. The pasted
  address is never logged or saved. If the person declined on ZoomInfo's page, sign-in ends as
  cancelled. gtm stops waiting after 5 minutes; the sign-in then expires and Try again starts a
  new one. If port 9876 is in use, the page says so.
- **Identity and access.** The card shows the name and ZoomInfo username from
  `gtm auth whoami`; reconnecting must sign in the same username (otherwise the earlier
  sign-in is put back). Every sign-in has the same fixed scopes, so there is nothing to choose;
  the card says in plain words what the account can do and that searches and enrichment can use
  the account's ZoomInfo credits. Scope names appear only under Technical details.
- **Existing sign-in.** A sign-in already in `~/.config/gtm-ai` that `gtm auth whoami`
  accepts is listed and can be checked, reconnected and removed.
- **Removing** deletes gtm's saved sign-in (`~/.config/gtm-ai/credentials`) and keeps gtm's
  registered app (`client_id`) for the next sign-in. Like the other integrations, Link doesn't
  revoke tokens at ZoomInfo (`gtm auth logout` would).
- **Skills.** Link installs ZoomInfo's official `gtm-ai-cli` skill from the same repository
  (`.claude/skills/`) as `zoominfo-gtm-ai-cli`, the same way as HubSpot's skills.

## Command-line tools

Link needs gog 0.44.0 or later, m365cli 2.1.0 or later, hubspot 0.16.0 or later, dbxcli
3.5.0 or later and gtm 1.0.0 or later. On Linux x64/arm64 Link installs the latest GitHub
release of gog, m365cli and dbxcli (whose archive must also be listed in the release's
`SHA256SUMS`), and of gtm (the single `gtm-linux-x64` binary, checked against GitHub's
SHA-256 asset digest; ZoomInfo publishes no Linux arm64 build, and the page says so there), and HubSpot's published
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
	"dropbox_app_key": "dropboxappkey",
	"callback": {
		"url": "https://link-callback.example",
		"office": "office-id",
		"token_file": "/private/callback-token",
		"version": "0.1.2"
	}
}
```

Google needs the provider's client JSON (0600): a web client when the hosted callback is
configured, otherwise a desktop client. Microsoft needs an Entra application registration.
Dropbox needs its app key.
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
[Link Callback Worker](../../workers/link-callback/README.md) (version 0.1.2, protocol 1) and
set `callback` in provisioning; `callback.version` must match the deployed Worker. Dropbox
callbacks need Worker 0.1.2. Hosted sign-in is used first when it is configured. Microsoft authorization uses the `common`
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

For a Dropbox account it returns `DBXCLI_AUTH_FILE` and a `command_prefix`
(`env -u DBXCLI_ACCESS_TOKEN DBXCLI_AUTH_FILE='…' '/home/…/dbxcli'`), because a
`DBXCLI_ACCESS_TOKEN` in the environment would override the file, plus the requested and granted
scopes for the person and, separately, for team administration.

For a ZoomInfo account it returns no arguments or environment: `gtm` uses the one sign-in saved
on the Office.

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
