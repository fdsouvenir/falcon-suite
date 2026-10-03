# Falcon Work — design system (OpenClaw Control UI host theme)

Falcon Work is a **native page inside the OpenClaw Control UI**. It must look built in: it uses the
Control UI's own theme, fonts, spacing and page layout, and has **no palette, fonts or page frame of
its own**. Never draw the page inside a dark card or centred box; the content fills the page area
next to the Control UI sidebar, exactly like OpenClaw's built-in pages (Workboard, Automations).

These values are taken from the installed Control UI stylesheet (OpenClaw 2026.9.7). Design in the
**light** theme; the same variables switch for dark mode.

## Color (light theme)

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#faf9f7` | Page background (warm off-white) |
| `--bg-content` | `#f4f1ec` | Content area behind lists |
| `--bg-elevated` / `--card` | `#ffffff` | Cards, rows, dialogs |
| `--bg-hover` | `#efebe4` | Row hover, active toggles |
| `--text` | `#403c35` | Body text |
| `--text-strong` | `#211e1a` | Titles, item names |
| `--muted` | `#6e6960` | Secondary text, metadata, section labels |
| `--border` | `#e8e4dc` | Hairline separators and card borders |
| `--border-strong` | `#d6d0c5` | Inputs, emphasised separators |
| `--accent` | `#bd4531` | Primary buttons, links, focus (brick red) |
| `--accent-subtle` | `#bd453114` | Selected/attention background tint |
| `--accent-2` | `#0d9488` | Secondary highlight (teal), selected items |
| `--ok` | `#166534` | Completed, achieved |
| `--warn` | `#92400e` | Warnings, waiting, overdue |
| `--danger` | `#b91c1c` | Failed, destructive |
| `--info` | `#1d4ed8` | Informational |

Dark theme equivalents: bg `#0e1015`, card `#161920`, text `#bcbcc0`, text-strong `#f4f4f5`,
muted `#8b8b94`, border `#1e2028`, accent `#ff5c5c`.

Status colours are used **sparingly** — a small dot or short text label, never a filled banner.

## Typography

- Body and UI: **Instrument Sans** (fallback system-ui). Mono: **JetBrains Mono**, only for ids
  and code.
- Sizes: xs 11px · sm 12px · md 14px (body) · lg 16px.
- Page title: 24px, weight 600, `--text-strong`, no uppercase.
- Section headers: 13px, weight 600, `--muted`-tinted text with a small coloured dot before them
  (as Workboard column headers do). No ALL-CAPS headings.
- Item titles: 14–15px, weight 600, `--text-strong`.

## Spacing, shape, depth

- Spacing scale: 4, 8, 12, 16, 20, 24, 32, 40px.
- Radius: 6px small, 10px default, 14px large, full for pills/avatars.
- Cards: white on the warm background, 1px `--border`, 10px radius, no heavy shadow
  (at most `0 1px 2px #3c2a180d`).
- Dense lists: rows separated by 1px `--border`, 8–12px vertical padding.

## Page layout

- The page sits to the right of the Control UI's left sidebar (light beige, agent identity at top,
  Pages list, Sessions list). Show that sidebar in mockups so the page reads in context; the
  Work item in it uses a **list-with-checkmarks** icon and is selected.
- Page header: title "Work" on the left; on the right a quiet toolbar — search field, agent filter
  select, and one primary button "New" (accent). Secondary buttons are borderless and muted.
- Content is full width (no max-width card), with 24–32px page padding.

## Components

- Buttons: primary = accent fill, white text, 8px radius, 32–36px tall; secondary = transparent,
  muted text.
- Chips/pills: small, `--bg-hover` background, 11–12px text.
- Session reference: a compact chip with a small status dot (running teal, idle muted, failed
  danger, missing warn) and the session's title.
- Agent: small round avatar with the agent's name.
- Warnings: a row with a small warn-coloured triangle icon, a bold short kind ("Stalled Task") and
  a one-line explanation in body text.

## Tone

Calm, dense, operator-grade. Real data, no marketing copy, no decorative illustration, no gradients,
no glassmorphism, no emoji.
