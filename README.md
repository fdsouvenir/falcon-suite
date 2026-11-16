# Falcon Suite

A set of separately installable OpenClaw plugins. Each package in `packages/` is its own plugin,
installed and configured on its own.

- `docs/work-spec.md` — the Falcon Work 2.0 specification (draft: the clerk, Jobs, the new pages).
- `docs/work-commands.md` — the Work command list.
- `docs/vault-spec.md` — the Vault 5 specification.
- `docs/link-spec.md` — the approved Falcon Link requirements and issue sequence.
- `packages/work/src/store/schema.ts` — the Work data model.
- `packages/work/seed/` — tooling for an evaluation database: `lib.mjs` (a builder over the draft
  schema) and `report.mjs` (renders the Work tab's content as text). The seed data itself was real
  personal work and is kept local, so it is not in this repository.
- `.stitch/` — the Stitch design system (`DESIGN.md`) and tooling. Screen exports are local only
  for the same reason.

## Packages

- `packages/work` — **Falcon Work** (`@fdsouvenir/falcon-work`, plugin id `falcon-work`).
- `packages/vault` — **Falcon Vault** (`@fdsouvenir/falcon-vault`, plugin id `falcon-vault`).
- `packages/link` — **Falcon Link** (`@fdsouvenir/falcon-link`, plugin id `falcon-link`);
  Google/Microsoft connections, account ownership and purpose; preview delivery in progress.

## Suite branding

Every suite module uses **Falcon [module name]** in the Control UI sidebar and
**Falcon [module name] v[version]** as its page heading. This applies to current and future
modules, in both preview and production channels. Sidebar labels do not include a version.

The heading uses that module's own release version, supplied by release staging rather than
hardcoded in the UI. Prereleases show the suffix (`5.0.0-preview.38` becomes `vpreview.38`);
stable releases show the full version (`1.0.0` becomes `v1.0.0`). Work and Vault can be installed
at different versions; neither displays another module's version.

## Develop

Node 24.16+. From the repository root (with `NODE_ENV=production` in the environment, npm skips the
dev dependencies the build needs: use `npm install --include=dev`):

```sh
npm install
npm run build      # tsc + openclaw plugins build, per package
npm run validate   # openclaw plugins validate, per package
npm test
npm run format:check
```

Native plugin UI needs **Settings → Labs → Custom plugin UI**
(`gateway.controlUi.experimental.customPlugins: true`) on the Gateway.

## Release

Each package is one ClawHub listing with one identity (`falcon-<module>`, **Falcon <Module>**,
`@fdsouvenir/falcon-<module>`). The release channel is a ClawHub tag on that listing:

```sh
node scripts/stage.mjs <work|vault|link> preview X.Y.Z-preview.N [--publish]   # tagged `preview`
node scripts/stage.mjs <work|vault|link> production X.Y.Z [--publish]          # tagged `latest`
```

Without `--publish` it stages, builds, validates and runs `clawhub package publish --dry-run`.
A plain `openclaw plugins install clawhub:@fdsouvenir/falcon-<module>` installs `latest`;
`...@preview` installs the preview, and `openclaw plugins update <plugin-id>` keeps the channel it
was installed from. Publishing a preview does not move `latest`. ClawHub has no command to move a
package tag: `latest` only advances when a higher production version is published, so a bad
production release is fixed by publishing a higher one.

Pick versions from `clawhub package inspect @fdsouvenir/falcon-<module> --versions` (and earlier
publish logs: submitted-but-unpublished versions are taken). Preview numbering on this listing
starts fresh; versions on the retired `@fdsouvenir/falcon-<module>-preview` listings don't carry
over, and a preview must not reuse a version already on the production listing.

Until 2026-11-16 previews were separate listings with their own plugin ids
(`falcon-<module>-preview`). On a test Office still running one, its config entry
(`plugins.entries.falcon-<module>-preview`), Work's `falcon-work-preview/work.db` and Link's
`falcon-link-preview/` accounts and provisioning stay under the old id and don't move to
`falcon-<module>`; Vault's database is at a fixed location, but a secrets provider naming
`pluginId: falcon-vault-preview` must name `falcon-vault`. Reinstall cleanly: uninstall the
`-preview` plugin, install `...@preview`, then redo its settings (for Link, run
`scripts/provision.mjs` for `falcon-link` and sign in again). Test Offices only; nothing migrates.
