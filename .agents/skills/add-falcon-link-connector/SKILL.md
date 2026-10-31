---
name: add-falcon-link-connector
description: Add a new integration (connector) to Falcon Link in the falcon-suite repo — research the provider's official CLI and sign-in model, spec it, build it as a provider module, release a preview, qualify a real sign-in on a test Office, then release stable. Use when Fred asks to add a service (e.g. "add <provider> to Link").
---

# Add a connector to Falcon Link

Falcon Link (`packages/link`) connects people's accounts to the provider's own **official CLI** and installs that CLI (and its official agent skill, if any) for agents. A connector is one provider module. Google (gog), Microsoft (m365cli), HubSpot (hs), Dropbox (dbxcli) and ZoomInfo (gtm) are the worked examples; read the closest one before starting.

Releasing to ClawHub or installing on an Office needs Fred's explicit request. "Add X" covers research → spec → build → preview release only when he says to release; ask otherwise.

## 1. Research (before proposing anything)

Answer each with evidence from the CLI's **source at a release tag** (clone to `~/.cache/link-<id>/`), not its README:

- **Official CLI?** Publisher, licence, latest release date, maintenance. Prefer the vendor's own CLI. If none exists, say so and stop for Fred's call.
- **Install assets:** Linux x64 and arm64? Archive or single binary? Verification: GitHub per-asset `digest` (sha256), a SHA256SUMS asset, or vendor checksum file. GPG-only with no published key isn't usable on its own; fall back to the GitHub digest.
- **Sign-in model:** OAuth with PKCE, device code, pasted code, or API key? Who owns the OAuth app: can we register our own (client ID seeded per Office, redirect to the hosted callback `https://link-callback.fredbot.link/oauth2/callback/<id>`), or must we use the CLI's built-in app? Check for restrictions (e.g. ZoomInfo's dynamic client registration only accepts approved vendor names — never impersonate the CLI's vendor name). Find the fixed redirect URI (localhost port?) and the scope parameter.
- **Credential store:** path, format, file mode, encryption, env overrides for location (needed for per-account isolation), and whether the CLI refreshes and rewrites the file itself. If Link drives OAuth itself, confirm a file Link writes is accepted and refreshed by the CLI.
- **Identity:** a command that returns the signed-in user (email/username) so reconnect can match the same account.
- **Permissions:** granular scopes (needs a plain-words permission UX like Dropbox's rows) or fixed (like ZoomInfo: nothing to choose)?
- **Agent skill:** does the vendor ship one (repo path)? Licence?
- **Account requirements:** paid plan, credits, admin approval — and whether a normal customer login works (not a special developer account).
- **Logo:** official brand asset source; never imply endorsement.

Report to Fred in plain words: recommended method, the problems (with the evidence), options, and what's verified vs assumed. Don't build until he decides the open product questions.

## 2. Spec

Write `~/.cache/link-<id>/SPEC.md` (copy to `~/repos/artifacts/link-<id>-<date>/SPEC.md`). Template: `~/.cache/link-zoominfo/SPEC.md`; the standing ground rules are in `~/.cache/link-p9/SPEC.md` ("Ground rules"): build only what's asked; no invented restrictions, defaults or warnings; facts only for agents (no behavioural instructions); tests only where they protect caller-visible behaviour; implementer lists own choices under "Decisions to confirm". Include Fred's product decisions verbatim, the verified CLI facts with file/line sources, requirements, verification steps, and the report format.

## 3. Build (delegate)

- Worktree from current `origin/main`: `git worktree add -b feat/link-<id> ~/repos/worktrees/falcon-link-<id> origin/main && npm ci`.
- Module layout (follow exactly): `packages/link/src/providers/<id>/index.ts` (server `ProviderModule`) and `ui.ts` (browser-safe `ProviderUi`), registered in `providers/index.ts` and `providers/ui.ts`. Contract in `providers/types.ts` — extend `ToolSource`/`SkillSource`/`ProviderUi` there when a provider needs something new, keeping existing providers working. Logo in `packages/link/assets/brand/` with its source in `assets/brand/README.md`. Tests in `packages/link/test/<id>.test.mjs` against a fake CLI.
- Our OAuth app settings (client ID, app key, secret file) are **never** in the package: add them to the allowed fields in `packages/link/scripts/provision.mjs` and make `readiness()` report setup required when missing. CLIs with their own built-in app need nothing seeded (readiness ready).
- A hosted-callback provider also needs the `workers/link-callback` Worker route + version bump; Verl deploys it after review.
- Docs: `packages/link/README.md` and a dated section in `docs/link-spec.md`.
- Spawn an isolated subagent with the spec; it pushes, opens a PR to main and gets CI green. It must not publish, install anywhere, sign in, touch credentials or merge.

## 4. Review and merge

Read the module diff yourself: sign-in path (nothing opens a browser on the Office desktop; pasted URLs/codes never logged or persisted), identity check on reconnect, remove only deletes this account's store, install verifies digests. View the UI harness screenshots (copy to the workspace to view). Check against Fred's specific UX asks. Then `gh pr merge <n> --merge --match-head-commit <sha>`.

## 5. Preview release

From a clean detached worktree at the merge commit:

```
git worktree add --detach ~/repos/worktrees/falcon-link-release-<n> origin/main
cd ~/repos/worktrees/falcon-link-release-<n>
NODE_ENV=development npm ci --include=dev      # NODE_ENV=production in the shell drops tsc
node scripts/stage.mjs link preview 0.1.0-preview.<n> --publish > ~/repos/artifacts/link-<id>-<date>/publish-preview<n>.log 2>&1
```

Pick `<n>` from `clawhub package inspect @fdsouvenir/falcon-link-preview --versions` **and** earlier publish logs (submitted-but-unpublished versions are taken). Follow the release skill's ClawHub recovery reference: `skillspector failed` / "judge not started" is a scanner-side failure — rescan the same version (`POST /api/v1/packages/<encoded name>/rescan` with `{"version":...}`), never bump to escape it. Done only when the version is public as latest, `clawhub package download` matches the registry SHA-256, and the stored ClawScan verdict (`clawhub scan download ... --kind plugin`) is benign.

## 6. Qualify on test Offices

Alpha = `bldg006-office-4`, Bravo = `bldg006-office-5` (scripts in `~/repos/artifacts/link-zoominfo-20261030/`: `install-offices-17.py`, `office-zi.js`, `verify-alpha.js`). Install the verified tgz, have Link install the CLI and skill (`install` session action), start a sign-in and cancel it to prove the URL/flow, then ask Fred for a real sign-in on Alpha and verify: account connected, the CLI's own whoami works, credential file 0600, one harmless read (a free search/list). Record a Falcon Work finding.

## 7. Stable release

Only when Fred says so. Same commit, `node scripts/stage.mjs link production <semver> --publish` (new connector → minor bump; check taken versions the same way). Same scan/download checks. Installing on a customer Office (e.g. kimg = `bldg007-office-1`): back up `openclaw.json`, `openclaw plugins install clawhub:@fdsouvenir/falcon-link@<version> --force --accept-capabilities --no-enable` (`plugins update` has kept a stale version), then confirm every existing account is still connected.

## Report

What works (verified, with evidence), what's untested, and what's still Fred's to decide.
