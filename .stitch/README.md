# Stitch

- Project: **Falcon Work 5** — `projects/5529516345320503010`; design system asset
  `assets/4f56214e4f1d42dc88a573d6a161d0f4`, created from `DESIGN.md`.
- `DESIGN.md` — OpenClaw Control UI host theme (light), taken from the installed Control UI CSS.
- `mcp.mjs` — minimal Stitch MCP client; reads the API key from KeePassXC
  (`Services/APIs/Stitch MCP`) and never prints it. `node mcp.mjs tools/call '<json>'`.
- `shot.mjs` — renders a downloaded screen's HTML at full size with Playwright
  (Stitch's own screenshot is 512px wide). Run from a directory where `playwright` resolves.
- `screens/` — accepted screens (HTML + PNG).

| Screen                    | Stitch id                          | Rounds                                                                                                 |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Work overview             | `a1f5dee0b08b44dcb5c27a0cedfc9d92` | generated, 2 correction rounds, then Question/Decision interactions                                    |
| Work overview, dark       | `b096ab84af9e4f48862dc4d87b5c07a6` | colour-only remap to the dark host tokens; some text left too dim (mockup artifact)                    |
| Areas & Projects          | `ed1c650d99aa4640a49c394362a6b2e0` | generated, 1 correction round, then Area chip row replacing the Area pane                              |
| Project page + Task panel | `e390e417ff9c47718183ff72dd451ebc` | generated, 2 correction rounds (second restored panel content an edit had replaced with placeholders)  |
| Objectives tab            | `fc3e9f9e40a54548a51624f588aeda2e` | generated, 1 correction round                                                                          |
| Objective page            | `cfe0d614345a4d5c918c053c5a567b7d` | generated, 1 correction round                                                                          |
| Activity tab              | `9fb33c0fc8924755b0dfff69b7a9b12b` | generated, 1 correction round                                                                          |
| Overview, calm (proposed) | `5bfc8d87d0f346c587c78c841c8c67dc` | generated from the alpha sample data, 1 correction round                                               |
| Overview + Decision panel | `9a36fda5d7b54fa3a2065ca69e769018` | generated, 1 correction round; that round dropped the DECIDE group, restored by hand in the local HTML |

## Falcon Vault 5

- Project: **Falcon Vault 5** — `projects/7201604652252946872`; design system asset
  `assets/32ab4a7b5bd5445ebeccf3ad25edba7b`, created from `vault/DESIGN.md` (the Work design system
  with Vault's page layout and secret-field components). Mockups use sample data only.

| Screen                   | Stitch id                          | Rounds                                                          |
| ------------------------ | ---------------------------------- | --------------------------------------------------------------- |
| Browse + entry pane      | `42d8285ec80f4721a4e7c1913b119673` | generated, 2 correction rounds                                  |
| Edit in place            | `e709a4f4ee684a06ba1218205ae681f1` | generated, 1 correction round                                   |
| New entry panel          | `33f65569828d49079d2ce36ccfa1f72c` | generated                                                       |
| Needs a value (fill in)  | `8e1d5d81ba224c70ba2ceff810d91791` | generated, 1 correction round                                   |
| Delete step + group menu | `ee6b93b4fcd9471bb7f18e2718a2908c` | generated, 1 correction round; group menu is clipped (artifact) |
| Mobile list              | `87e7f9becb1c4384a23da63ae5841e0d` | generated, 1 correction round                                   |
| Mobile entry, editing    | `cfcba313416b4d289f11470772ddf721` | generated, 1 correction round                                   |
