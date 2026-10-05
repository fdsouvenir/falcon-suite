# Falcon Suite

A set of separately installable OpenClaw plugins. Each package in `packages/` is its own plugin,
installed and configured on its own.

- `docs/work-spec.md` — the Work 5 specification.
- `docs/work-commands.md` — the Work command list.
- `packages/work/src/store/schema.ts` — the Work data model.
- `packages/work/seed/` — tooling for an evaluation database: `lib.mjs` (a builder over the draft
  schema) and `report.mjs` (renders the Work tab's content as text). The seed data itself was real
  personal work and is kept local, so it is not in this repository.
- `.stitch/` — the Stitch design system (`DESIGN.md`) and tooling. Screen exports are local only
  for the same reason.

## Packages

- `packages/work` — **Falcon Work** (`@fdsouvenir/falcon-work`, plugin id `falcon-work`).

## Develop

Node 24.16+. From the repository root:

```sh
npm install
npm run build      # tsc + openclaw plugins build, per package
npm run validate   # openclaw plugins validate, per package
npm test
npm run format:check
```

Native plugin UI needs **Settings → Labs → Custom plugin UI**
(`gateway.controlUi.experimental.customPlugins: true`) on the Gateway.
