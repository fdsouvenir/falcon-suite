# Falcon Vault 5 — specification (draft)

Status: **approved by Fred**, 2026-10-08. Screens: `.stitch/README.md` (Falcon Vault 5).

Settled before drafting (Fred, 2026-10-08):

1. Vault is its own KeePassXC vault, not a front end on OpenClaw's shared secret store.
2. Agents reach a value only through a SecretRef in OpenClaw config. No executor grants, and only
   one kind of entry.
3. Kept from 4.4: audit history, group management, an agent tool. Recovery snapshots are out.
4. Agents may store a password they chose themselves: create-only, never overwriting, never reading
   back (§7).
5. The plugin reads and writes the database itself with a JavaScript KDBX library. `keepassxc-cli`
   is not a prerequisite, and agents use the `falcon_vault` tool, not the CLI. Installing the
   plugin is the whole install.

## 1. Purpose

Vault is **the operator's password manager, inside OpenClaw**, and the place OpenClaw's config
credentials come from.

Two things follow from that, and every rule below serves one of them:

1. **It is a real password manager.** Entries have a username, password, URL and notes, live in
   groups, and can be searched, revealed and copied by a person. The database is an ordinary
   KeePassXC file the operator owns. It opens in the KeePassXC desktop app, can be backed up like
   any file, and outlives the plugin.
2. **Values never reach a model.** A credential reaches OpenClaw at runtime through a SecretRef,
   resolved inside the Gateway. Agents can see what exists and can ask for what is missing, but no
   agent-facing surface ever returns a value.

Vault is **gateway-scoped and shared**: anyone who can sign in to the Control UI sees and manages
every entry. Per-person permissions are out of scope.

## 2. Vocabulary

| Word          | What it is                                                                         |
| ------------- | ---------------------------------------------------------------------------------- |
| **Vault**     | The one KeePassXC database the plugin opens.                                       |
| **Group**     | A KeePassXC group. Groups nest.                                                    |
| **Entry**     | A KeePassXC entry: Title, UserName, Password, URL, Notes.                          |
| **Path**      | An entry's or group's full location, `Group/Sub/Title`. This is its identity.      |
| **Reference** | The SecretRef id that resolves an entry's field: `Path` or `Path:Field`.           |
| **Usage**     | A place in OpenClaw config whose SecretRef resolves from an entry.                 |
| **Request**   | An entry an agent has asked for, which has no password yet (§7).                   |
| **Event**     | One row of audit history: who did what to which path, when, and whether it worked. |

## 3. Storage

- The database is `<state>/passwords.kdbx`, unlocked by the key file `<state>/vault.key`. There is
  no master password, no unlock prompt and no
  lock button. Filesystem ownership protects the key.
- These locations are fixed. Feature plugins take no config in this SDK, as with Work.
- **Provisioning is invisible.** On start, an existing database is opened as it is, and no entry
  is rewritten. If there is neither a database nor a key, the plugin creates both. A key without a
  database, or a database without a key, is an error. The plugin never overwrites either file.
- **No host prerequisites.** The plugin reads and writes KDBX 4 with `kdbxweb` (the library behind
  KeeWeb), plus a WebAssembly Argon2 for databases that use it. A database the plugin creates is
  KDBX 4 with Argon2id. Checked 2026-10-08 on a copy of Verl's database (KDBX 4.1, AES-KDF, 108
  entries): the library opened it with the key file, added an entry and saved, and
  `keepassxc-cli` 2.7.6 read the result with every entry intact.
- If startup fails, the Vault tab says **Vault unavailable** and why. It never shows an empty list in that case.
  Gateway service health carries the same reason.
- **One writer at a time.** Every operation, and every resolver run, holds an exclusive lock on
  `<state>/falcon-vault/vault.lock`. A change is saved to a private temporary file, which is fsynced
  and renamed over the original, and then the directory is fsynced. A failed change leaves the
  original untouched.
- **Edits made outside the plugin are respected.** The KeePassXC desktop app may also have the file
  open. Before every save, the plugin checks that the file on disk is still the one it loaded. If it
  changed, the plugin reloads it and applies the change again, so an outside edit is never
  overwritten.
- The plugin's own data lives in `<state>/falcon-vault/`: the lock and `audit.db`. Nothing else.

## 4. Entries and groups

- Every entry is the same kind of thing: KeePassXC's standard fields, holding plain values.
  Entries created in the Vault tab, by an agent, or in the KeePassXC desktop app are
  indistinguishable.
- **An entry's identity is its exact path**, never a title search. A renamed or moved entry is a
  different path. Nothing is matched by its old name.
- **Entries:** create, edit any field, rename, move to another group, remove.
- **Groups:** create, remove when empty. Renaming a group is done by creating the new group, moving
  its entries, and removing the old one. The UI offers this as one **Rename group** action, saved
  in one write.
- **Removing an entry asks you to type its title**, and the button stays disabled until the text
  matches exactly. A removed entry goes to the database's Recycle Bin, as KeePassXC does, and the
  Recycle Bin is shown as an ordinary group, so a mistaken removal is undone by moving the entry
  back. Verl's database has its Recycle Bin enabled.
- Renaming, moving or removing an entry that has **Usages** (§5) warns first, naming each Usage.
  Vault never rewrites config to follow a moved entry.

## 5. References and Usages

- The plugin declares its resolver in its manifest under `secretProviderIntegrations`. OpenClaw
  materializes the command from the installed plugin at startup and reload, so `openclaw.json`
  holds no file path:

  ```json
  "secrets": { "providers": { "keepassxc": {
    "source": "exec",
    "pluginIntegration": { "pluginId": "falcon-vault", "integrationId": "falcon-vault" }
  } } }
  ```

  Disabling or removing the plugin makes these SecretRefs fail closed.

- Reference grammar is unchanged from 4.4: `Path` returns Password, and `Path:Field` returns
  `Password`, `UserName`, `URL`, `Notes` or `Title`.
- OpenClaw's exec id grammar is `^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$`. **It has no spaces.** An
  entry whose path has a space or other excluded character cannot be referenced. The entry view
  says so and suggests a rename, rather than offering a Reference that would never resolve.
- The resolver implements exec-provider protocol v1. It accepts at most 50 ids per request, takes
  the lock, reads only the named fields, and returns `NOT_FOUND` per id without revealing whether
  other entries exist. Its output goes only to OpenClaw's protected resolver pipe.
- **Usages are never stored.** Each time an entry is shown, Vault reads OpenClaw's live config
  (`api.runtime.config.current()`) for SecretRefs whose provider is Vault's and whose id names that
  entry, so the list is always current. The entry view lists them by config path, for example
  `models.providers.anthropic.apiKey`.

## 6. Who can see a value

- **A signed-in person** can reveal or copy one field of one entry, through an explicit action in
  the Vault tab. These are Control UI actions that require `operator.write`. No agent tool exists
  for them.
- **The Gateway runtime** receives values through the resolver, to use config credentials.
- **Agents never receive a value** from Vault, from any tool, in any form. An agent may hand Vault
  a value it already has (§7); it cannot read one back.
- A revealed value hides again after 15 seconds, and is cleared when the UI disconnects.
- Values never appear in logs, tool results, audit rows or errors.

What this does not protect against: anything running as the Gateway's Unix user, including an
agent with a host shell, can read the database and key file directly. Vault's boundary is the tool
and UI surface, not the operating system. Removing a credential locally does not revoke it
upstream. Rotate it at the provider if it was exposed.

## 7. Agent tool

One tool, `falcon_vault`, with these actions:

- `list` — paths of groups and entries, optionally under a group or matching a search. For each
  entry: its UserName and URL, which fields are set, its Reference (or why it has none), and
  whether it is a Request. Never a Password or Notes value.
- `get` — the same metadata for one path, plus its Usages.
- `store` — create a new entry with Title, UserName, **Password**, URL and Notes, for a credential
  the agent already holds (for example, one it chose when signing up for a service). Create-only: it
  fails if the path exists. The result confirms the path and Reference, never the value.
- `request` — create an entry with Title, UserName, URL and Notes but **no password**, plus a
  one-line reason, for a credential only the person has. The Vault tab shows it under **Needs a
  value** until a person fills in the password. Never overwrites an existing path.

An agent cannot edit, move, rename or remove entries, and cannot change a password once stored.

## 8. Audit history

- `<state>/falcon-vault/audit.db`: append-only and STRICT. Triggers reject updates and deletes.
- One Event per operation attempt and its outcome: action, path, actor (`person:<id>`,
  `agent:<id>` or `resolver`), time, outcome. No values, ever.
- Resolver reads are recorded too, one Event per id, so a person can see when config last used an
  entry.
- The Vault tab shows each entry's history in its detail view, and the whole Vault's history in a
  History view filtered by path, actor or action.
- There is no retention limit in 5.0.

## 9. The human's view

Designed in Stitch on OpenClaw's own theme (`.stitch/README.md`, Falcon Vault 5). Like Work, the
page uses the Control UI's theme variables only, so it follows OpenClaw's light/dark setting.

- **Header:** "Vault", then only **New group** (quiet) and **New entry** (primary). Below it, one
  full-width search across every entry.
- **Group tree:** "Needs a value" pinned at the top when there are Requests; "All entries"; the
  groups; "Recycle Bin" at the bottom as an ordinary group. Each group has a "⋯" menu: Rename group,
  New subgroup, Move group to…, Delete group (only when empty). Entries move between groups by
  editing their Group field.
- **List:** each entry's title, with username · site underneath.
- **Entry pane:** Username, Password (masked, Reveal/Hide and Copy), URL, Notes. Then, only if
  OpenClaw config uses the entry, **Used by OpenClaw**: each setting by name with its config path,
  and the sentence "Renaming or deleting it breaks them." Then a short History. There is no
  separate Reference section; the Reference is copied from the "⋯" menu (Copy config reference).
- **Edit in place:** Edit turns the pane into a form (Title, Group, fields, Notes) with Cancel and
  Save. "Generate password" is a small text button under the Password field, not a primary
  control.
- **New entry:** the same form in the pane, titled "New entry", with the Group prefilled from the
  tree selection.
- **Delete, two steps:** "Move to Recycle Bin" shows an inline confirmation in the pane; if config
  uses the entry, it lists the settings that will stop working. In the Recycle Bin, "Delete
  forever" asks once more. No typing the title.
- **Needs a value:** selecting a Request shows the agent's reason, the fields it filled in, and an
  empty Password field with Save and Dismiss request. On Save the entry leaves Needs a value and
  the asking agent's session is told the entry is ready (never the value).
- **Mobile:** one column. A top bar with the Control UI menu, "Vault" and "+"; search; a group
  button that opens the tree as a bottom sheet, with a "needs a value" pill beside it; the list.
  Tapping an entry opens it full screen with Back; Edit happens in that screen with Save in the top
  bar and "Move to Recycle Bin" at the bottom. Inputs are 44px tall with 16px text so phones don't
  zoom.
- **Vault unavailable** replaces the whole page when startup failed, and gives the reason.

## 10. Persistence and packaging

- Package `@fdsouvenir/falcon-vault`, plugin id `falcon-vault`, in `packages/vault`, on the suite's
  shared 5.x version line with preview and production listings, as for Work.
- A feature contract shared by the backend, the agent tool and the native UI. UI-only operations
  (reveal, copy, write actions) have no `tool` declaration.
- The database is opened inside the Gateway process and kept loaded between operations. The
  resolver is a separate process, because OpenClaw runs exec providers that way. It loads the
  database under the same lock and writes values only to its protected stdout pipe.
- Dependencies: `kdbxweb` and a WebAssembly Argon2 (`hash-wasm`), bundled into the package. No
  native modules and no host binaries.
- Idempotency keys on writes, so a retried create doesn't make two entries.

## 11. Not in Vault

Recovery snapshots and restore · executor grants, JSON envelope entries, and any second entry shape
· master password, unlock or lock · syncing with OpenClaw's shared secret store · attachments,
TOTP, custom attributes and entry history · more than one database · configurable paths ·
per-person permissions · OAuth tokens and refresh (Integrations owns these) · documents.

## 12. Lessons carried from 4.x

These are written fresh where they're needed. No 4.x files are copied.

- Temp file, fsync, rename and directory fsync for every database change. One lock around every
  operation, resolver included.
- Path identity, and never title matching.
- An unavailable Vault is an explicit state, never an empty list.
- No visible provisioning step.
- Immutable audit table enforced by triggers.
- Bounded resolver input: 16 KiB, 50 ids, and only the fields the protocol defines.

## 13. Switchover on Verl (runbook, not code)

1. Check the live database for 4.x JSON-envelope entries, created by agents under executor grants.
   Each one is converted to a plain entry by hand or removed. Vault 5 reads them as plain text.
2. Install `falcon-vault`. Turn off Falcon Dash's Vault module so there's one `falcon_vault` tool
   and one Vault tab. Retire the `keepassxc` CLI skill (`~/.openclaw/skills/keepassxc`), so agents
   use the tool.
3. Replace `secrets.providers.keepassxc` with the `pluginIntegration` block in §5. The seven
   existing SecretRefs keep `provider: "keepassxc"` and need no edits.
4. Run `openclaw secrets audit --check --allow-exec` and then `openclaw secrets reload`, and check
   that every ref resolves.
5. Keep `falcon-dash/bin/keepassxc-secret-resolver.cjs` until step 4 passes. Falcon Dash's 4.x
   audit history and policy are not carried over.

## 14. Open for Fred

1. **Password generator** in the new-entry form? Small, but it isn't in 4.4.
2. **Provider alias.** The plan above keeps `keepassxc` so no refs change. Renaming it to
   `falcon-vault` is cleaner, but means editing all seven refs at switchover.
