# Falcon Suite

A set of separately installable OpenClaw plugins. Each package in `packages/` is its own plugin,
installed and configured on its own.

- `docs/work-spec.md` — the Work 5 specification.
- `docs/work-commands.md` — the Work command list.
- `docs/vault-spec.md` — the Vault 5 specification.
- `packages/work/src/store/schema.ts` — the Work data model.
- `packages/work/seed/` — tooling for an evaluation database: `lib.mjs` (a builder over the draft
  schema) and `report.mjs` (renders the Work tab's content as text). The seed data itself was real
  personal work and is kept local, so it is not in this repository.
- `.stitch/` — the Stitch design system (`DESIGN.md`) and tooling. Screen exports are local only
  for the same reason.

## Packages

- `packages/work` — **Falcon Work** (`@fdsouvenir/falcon-work`, plugin id `falcon-work`).
- `packages/vault` — **Falcon Vault** (`@fdsouvenir/falcon-vault`, plugin id `falcon-vault`).

## Suite branding

Every suite module uses **Falcon [module name]** in the Control UI sidebar and
**Falcon [module name] v[version]** as its page heading. This applies to current and future
modules, in both preview and production channels. Sidebar labels do not include a version.

The heading uses that module's own release version, supplied by release staging rather than
hardcoded in the UI. Prereleases show the suffix (`5.0.0-preview.38` becomes `vpreview.38`);
stable releases show the full version (`5.0.0` becomes `v5.0.0`). Work and Vault can be installed
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
