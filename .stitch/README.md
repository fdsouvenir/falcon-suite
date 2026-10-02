# Stitch

- Project: **Falcon Work 5** — `projects/5529516345320503010`; design system asset
  `assets/4f56214e4f1d42dc88a573d6a161d0f4`, created from `DESIGN.md`.
- `DESIGN.md` — OpenClaw Control UI host theme (light), taken from the installed Control UI CSS.
- `mcp.mjs` — minimal Stitch MCP client; reads the API key from KeePassXC
  (`Services/APIs/Stitch MCP`) and never prints it. `node mcp.mjs tools/call '<json>'`.
- `shot.mjs` — renders a downloaded screen's HTML at full size with Playwright
  (Stitch's own screenshot is 512px wide). Run from a directory where `playwright` resolves.
- `screens/` — accepted screens (HTML + PNG).

| Screen | Stitch id | Rounds |
| --- | --- | --- |
| Work overview | `e4517724fd104f13919c2c738eac0ac7` | generated, 2 correction rounds |
