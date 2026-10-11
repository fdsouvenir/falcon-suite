# Falcon Vault

**Credentials for your agents and OpenClaw, in your own KeePassXC database** — for
[OpenClaw](https://openclaw.ai).

Vault is an ordinary KeePassXC database that you own: it opens in the KeePassXC desktop app, backs
up like any file, and outlives the plugin. OpenClaw reads config credentials from it through
SecretRefs. Agents browse metadata, retrieve credentials for authorized jobs, store credentials
they already hold, and ask for missing ones.

## What you get

- A native **Vault** page in the Control UI that follows your theme, light or dark: groups,
  search across every entry, and an entry pane where you reveal (it hides again after 15
  seconds) or copy a password, edit in place, and see which OpenClaw settings use the entry.
- **Needs a value** — credentials your agents asked for. Fill one in and the agent's session is
  told it is ready (never the value).
- **Recycle Bin**, as in KeePassXC: removing an entry is undone by moving it back.
- **History** of every operation and every read by OpenClaw: who, what, which entry, when. Never a
  value.
- A SecretRef **resolver**, declared by the plugin, so `openclaw.json` holds no file path.

Agents get one tool, `falcon_vault`: `list`, `get`, `store` (a credential the agent already holds,
create-only, never echoed back) and `request` (ask you for one). `retrieve` (path, optional field, optional uuid for duplicate paths) immediately returns one field,
Password by default, from the same database. There are no Vault approval tiers, prompts or standing
grants. Agents cannot edit, move or remove entries.

Prefer an existing protected authenticated integration when available. Retrieval works independently
of the SecretRef subprocess, including when the host's executable-ownership policy blocks that path.
**Retrieved values reach the model provider, session transcripts and subsequent tool arguments.**
Retrieve only what the authorized job needs; possessing a credential does not authorize new actions.
`list` and `get` remain free of Password and Notes values. Keep secrets out of titles, usernames,
URLs and request reasons: those are visible metadata. Retrieval history records the entry, field,
trusted calling agent/session when supplied by OpenClaw, and outcome—not the value. No model-supplied
identity is accepted, and a value is not returned if its audit record cannot be written. Startup
failures before the database opens are reported through service health, not retrieval history;
schema-invalid calls are rejected by OpenClaw before Vault runs.

## Install

```sh
openclaw plugins install clawhub:@fdsouvenir/falcon-vault
```

The Vault page is native Control UI: turn on **Settings → Labs → Custom plugin UI**
(`gateway.controlUi.experimental.customPlugins: true`).

To resolve config credentials from Vault, add a provider that points at the plugin:

```json
"secrets": { "providers": { "falcon-vault": {
  "source": "exec",
  "pluginIntegration": { "pluginId": "falcon-vault", "integrationId": "falcon-vault" }
} } }
```

and reference entries by path, for example
`{ "source": "exec", "provider": "falcon-vault", "id": "Providers/anthropic" }` for the Password,
or `"Providers/anthropic:UserName"` for another field (`Password`, `UserName`, `URL`, `Notes`,
`Title`). Paths cannot contain spaces; the entry pane says when an entry cannot be referenced, and
its "⋯" menu copies the reference.

OpenClaw runs the resolver only when no directory between the plugin and the script is group- or
world-writable. If the installer left the plugin folder group-writable (a `002` umask does this),
Vault removes that write permission when it starts and logs it; run `openclaw secrets reload` once
after that first start.

Requires OpenClaw 2026.9.6 or later.

## What Vault keeps on your Gateway

- `passwords.kdbx` and its key file `vault.key`, in the Gateway's state directory. There is no
  master password: anyone who can read those two files can open the database, so keep them
  readable only by the Gateway's user (Vault creates them that way). An existing database is opened as it is. If neither file
  exists, Vault creates both (KDBX 4, Argon2id); if only one exists, Vault reports it and creates
  nothing.
- `falcon-vault/` — the lock that keeps one writer at a time (the Vault tab, agents and the
  resolver), and `audit.db`, the history. History is append-only and holds names, never values.
  Changes saved by the KeePassXC desktop app are noticed before every save and never overwritten.

Anything running as the Gateway's user, including an agent with a shell, can read the database and
key file directly: Vault protects the tool and UI surface, not the operating system. Removing a
credential here does not revoke it; rotate it at the provider if it was exposed.

## Source

[github.com/fdsouvenir/falcon-suite](https://github.com/fdsouvenir/falcon-suite) — licensed
CC BY-NC 4.0.
