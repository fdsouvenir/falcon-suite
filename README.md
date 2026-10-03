# Falcon Suite

Separately installable OpenClaw plugins: **Work** first, then **Vault**; Integrations later.
A clean rebuild — nothing here carries code or data from Falcon Dash 4.x.

Status: **design stage.** Nothing is implemented yet.

- `docs/work-spec.md` — the Work 5 specification draft.
- `packages/work/schema.sql` — the draft data model behind it.
- `packages/work/seed/` — tooling for an evaluation database: `lib.mjs` (a builder over the draft
  schema) and `report.mjs` (renders the Work tab's content as text). The seed data itself was real
  personal work and is kept local, so it is not in this repository.
- `.stitch/` — the Stitch design system (`DESIGN.md`) and tooling. Screen exports are local only
  for the same reason.
