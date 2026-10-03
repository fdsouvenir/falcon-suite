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
| Work overview | `a1f5dee0b08b44dcb5c27a0cedfc9d92` | generated, 2 correction rounds, then Question/Decision interactions |
| Work overview, dark | `b096ab84af9e4f48862dc4d87b5c07a6` | colour-only remap to the dark host tokens; some text left too dim (mockup artifact) |
| Areas & Projects | `f3e2c7a23ed242d4a7c488ef3445b53f` | generated, 1 correction round |
