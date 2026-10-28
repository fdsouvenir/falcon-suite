# Falcon Link preview qualification — 2026-10-24

## Qualified adapter contracts

| Provider  | Executable | Minimum | Latest checked (2026-10-28) | Source               | Link installs on |
| --------- | ---------- | ------- | --------------------------- | -------------------- | ---------------- |
| Google    | `gog`      | 0.44.0  | 0.47.1                      | `openclaw/gogcli`    | Linux x64/arm64  |
| Microsoft | `m365cli`  | 2.1.0   | 2.2.0                       | `fdsouvenir/m365cli` | Linux x64/arm64  |

Since preview.9 Link installs each CLI's latest GitHub release; the minimums above are the
only version requirements. The archive checks below were recorded for the 2026-10-24 preview.

Both release archives were downloaded into an isolated temporary test root using the actual
Link installer, checked against GitHub asset SHA-256 digests, extracted without archive-path
writes, executed with `--version`, and activated. No host CLI or installed plugin was changed.
Linux x64 execution passed. The arm64 asset path exists; execution on arm64 remains unverified.

Google archive SHA-256 (Linux amd64):
`c3ed94efca90c754cdda300e3c7f8cc2f3d7df86d3fdc5d11f996c7518a09c24`.
Microsoft archive SHA-256 (Linux amd64):
`ae1c3e62e88d281b7945914dbe4db951d94b8e347ec74ae27b07da44b042b8d2`.

Google's real released CLI accepted an isolated fixture desktop-client configuration and
produced remote step-1 OAuth URLs for mail-read, mail-send with calendar/contacts, drafts,
and calendar/drive/contacts. URL scopes matched Link's selection exactly, including Google's
mandatory identity scopes and the contacts/directory bundle. Each test was cancelled without
opening provider consent or exchanging a code. These are offline contract checks, not live login.

Microsoft's released source documents named delegated profiles, `--account` selection,
`auth status --json`, `auth check --json`, device-code login and the exact workload/scopes.
The adapter parses only the known Microsoft device-login URL/code; no arbitrary stderr is shown.
Other locales or future CLI output formats may fail to surface a code and require cancellation;
this preview does not claim a stable machine-readable device-code event stream.

## What connection checks mean

- Google: exact email plus stored provider subject and a successful refresh check in the
  isolated CLI account store. Scope metadata from the CLI is labeled recorded, not verified grants.
- Microsoft: `--account <stable-id> auth check --json` performs Graph `/me`; the CLI verifies the
  selected profile and Link additionally pins the returned provider ID and verified address.
- Neither check tests mail sends, drafts, calendar writes or every selected workload. Both
  adapters leave complete independently verified granted scopes unknown.
- Consent cancellation/expiry, provider denial, tenant-admin consent and revoked refresh remain
  failures or unknowns, never connected success.

## Acceptance limits

Full Google/Microsoft hosted customer sign-in, business tenant consent, real service operations,
agent use in an installed test Office, restart recovery in a real Gateway, and arm64 execution
remain unverified. Preview publication is not customer acceptance or a production installation.
Issues #9–#14 remain open for their unmet acceptance conditions.

Local process-boundary tests cover multiple identities and isolated stores, explicit selection,
wrong callback state, person-bound login handles, cancellation, identity mismatch/revocation,
reconnect stability, unsupported permissions and invalid purpose labels. Existing status tests
cover missing/failing/unresponsive executables and unsafe output.

The built UI is checked in a local real-browser harness using the installed OpenClaw host
stylesheet. That verifies rendering and local interaction against a fixture host, not the
Gateway's authenticated transport or hosted Office acceptance.

## Local validation result

Workspace build, all three plugin validations, formatting, and **102 local tests** passed
(12 Link, 38 Vault, 52 Work). A fresh worktree inherited umask 0002, so Vault's pre-existing
resolver permission check initially failed on a group-writable checkout file. Restoring its
local executable permissions to 0755 resolved that environment-only failure; no Vault source
change or test weakening was made.

The real-browser fixture checks passed for desktop (1280px) and mobile (390px), native roster
owner choices, Other purpose labels, no default permission selection, form preservation after
refresh, the chain-link navigation contribution, and zero browser console errors. Authenticated
Gateway transport and hosted human consent remain outside that fixture's evidence.

A corrupted-download regression check confirms failed digest verification retains the active
CLI pointer, executable bytes and account data untouched.

Final review caught a partial-sign-in cleanup defect: missing registry email caused local token
removal to be skipped. Existing Google and Microsoft account tests were extended and shown
failing before the fix. Disconnect now inspects only that stable account's isolated CLI store,
removes its saved token/profile even without a verified email, and never touches another
account's store. Failed inventory/removal does not report successful disconnection.

## 2026-10-25 sign-in feedback follow-up

Alpha (current bldg006 Office office-4) reports both provider setups ready. A read-only
Google credential inventory for the failed account returned no saved account/token.
A separate temporary CLI probe accepted the configured desktop client and produced
the selected Gmail-read authorization URL; no user consent or code exchange was attempted.
The original failure stage is unavailable: preview.1 discarded the persistent failure
reason. These checks do not establish successful hosted Google login.

The follow-up fixes an empty-address reconnect lock, persists bounded stage-specific
errors (never raw CLI stderr, OAuth codes or tokens), and supplies private-session Link
lookup-tool discovery even when the agent owns no connected accounts. Human account
identities remain live-lookup only; no AGENTS.md edits or behavioral grants are added.

All XDG data/state/cache and gog data/cache roots are now explicitly account-local.
The original adapter isolated config/state but could inherit Office-wide data/cache
paths. Alpha’s actual Gateway environment confirms a shared XDG data root; the
reproduced runtime environment also returned zero saved Google accounts. A synthetic
real-gog probe of the corrected layout placed its keyring under the temporary account
data directory and its remote OAuth state under the temporary account config directory. Existing shared stores are neither copied nor deleted: affected preview accounts
may need a fresh sign-in into their isolated store. Alpha has only the failed account
and no saved Google token in its original CLI inventory. No installed plugin code was
patched and no user login was replayed during this investigation.

Fred subsequently confirmed consent completed and the redirect URL was submitted.
The released gog completion command performs exchange, identity lookup and token
storage before returning; the adapter now distinguishes those qualified stderr stage
markers using fixed public messages, discarding raw diagnostics. Unknown failures remain
unspecified completion failures, never assumed exchange failures. Process-boundary
regressions cover exchange, identity, storage and unknown output, with a private marker
verified absent from persisted account data.

Alpha’s unauthenticated token and userinfo endpoints returned HTTP 404 and 401 respectively,
confirming endpoint reachability, not account access. A deliberately invalid synthetic
refresh token with the provisioned client returned HTTP 400 / invalid_grant, consistent
with usable client configuration but not proof of a successful human login. No user
authorization code or token was replayed. The original failed completion cannot be
retrospectively classified from preview.1’s discarded stderr.

## Compact brief and existing account discovery — 2026-10-25

Private hooks now include human and agent accounts in a four-column table grouped by
CLI, without internal registry metadata or operating instructions. The human-account
regression failed against the previous agent-only hook before the fix. The existing
process-boundary discovery case exercises both real CLI JSON schemas, explicit Google
client and Microsoft profile selection, unassigned metadata, recorded versus unknown
scopes, metadata persistence across restart, and refusal to remove native credentials.
Discovered inventory is not proof of successful refresh, consent or service access.
Existing Microsoft application-only profiles are excluded from human-account discovery.
No installed Falcon plugin is used as a test target or upgraded by this release.

A read-only run of the new discovery adapter against this host's installed gog found
three saved Google accounts (19, 12 and 33 recorded scopes). It did not import them into
the installed plugin, change credentials, perform refresh or assign owner/purpose.
Microsoft discovery was exercised with its published schema in an isolated CLI fixture;
this host has no m365cli executable. Live customer sign-in remains unverified.

## Account access cards — 2026-10-26

The account card is organized around account identity, owner/purpose, connection status
and one plain-English capability list. Scope IDs, requested/granted duplicate rows and
identity-check timestamps are removed from the card. Change access (or finish sign-in)
is the main action; edit, check and disconnect are under a collapsed Manage account.

The CLI currently saves requested Google scopes, not independently verified Google
grants. The card calls those Selected access and says current permissions are not
confirmed. Only independently verified grants may appear as Allowed access. Known
empty grants never fall back to a broader sign-in request. Inactive accounts do not show
stale permission lists. Unknown permissions are not silently translated into known access.
This change does not implement provider grant verification.

An extended existing rendered-UI regression failed before the redesign, then passed.
Local Chrome fixtures checked desktop and phone layouts, active/incomplete/disconnected/
unverified states, saved vs verified permissions, collapsed management and working edit,
no horizontal phone overflow and zero page errors. These are local fixture checks, not
hosted customer acceptance. No release or installation is part of this change.

## Preview.9 contract checks — 2026-10-28

Checked against the released gog 0.47.1 binary and an m365cli build of the 2.2.0 commit
(which reports `v2.1.0-11-ga62c062` because it was built before tagging). No provider
consent or code exchange was attempted.

- Version parsing: `v0.47.1` and `v2.1.0-11-ga62c062` are recognized; the git-describe build
  sorts after 2.1.0 and before 2.2.0. Both meet the minimums.
- `m365cli auth workloads --json` parses into 7 rows (Email with a separate Send email choice,
  Calendar, Contacts, Tasks, OneDrive files, Groups, Excel workbooks) from 18 workloads; the
  5 compatibility bundles remain valid saved selections.
- Google: for every row level (39) plus mixed-level and preview.8 selections (4),
  `gog auth add … --remote --step 1 --json --no-input` with a throwaway `GOG_HOME` and a
  dummy client produced an authorization URL whose scopes exactly match Link's selection.
- Link's read-only scope set for each of the 15 services with a Read level equals the scopes
  gog 0.47.1 itself requests for that service with `--readonly`.
- gog's global `--readonly` only affects the command it is passed to; Link does not use it.
