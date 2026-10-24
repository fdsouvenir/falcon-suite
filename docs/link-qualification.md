# Falcon Link preview qualification — 2026-10-24

## Qualified adapter contracts

| Provider  | Executable | Release | Source               | Preview platform |
| --------- | ---------- | ------- | -------------------- | ---------------- |
| Google    | `gog`      | 0.47.0  | `openclaw/gogcli`    | Linux x64/arm64  |
| Microsoft | `m365cli`  | 1.0.0   | `fdsouvenir/m365cli` | Linux x64/arm64  |

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
