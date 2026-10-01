# Falcon Suite

Separately installable OpenClaw plugins: **Work** first, then **Vault**; Integrations later.
A clean rebuild — nothing here carries code or data from Falcon Dash 4.x.

Status: **local draft, not published.**

- `docs/work-spec.md` — the Work 5 specification draft.
- `packages/work/schema.sql` — the draft data model behind it.
- `packages/work/seed/` — an evaluation database seeded with real work Verl did for Fred.
  - `node packages/work/seed/seed.mjs` rebuilds `work-seed.db`.
  - `node packages/work/seed/report.mjs packages/work/seed/work-seed.db > packages/work/seed/view.md`
    renders the Work tab's content as text.
