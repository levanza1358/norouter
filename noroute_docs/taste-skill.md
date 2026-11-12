# Design taste skill (design-taste-frontend)

Installed: [tasteskill 2.5.1](https://www.tasteskill.dev/) (`design-taste-frontend`), MIT, from
`github.com/Leonxlnx/taste-skill`. Purpose: prevent AI-slop UI/UX — pages that look templated,
generic, or "AI-made" — in this project's dashboard and any HTML/CSS work.

Skill location: `.zcode/skills/design-taste-frontend/` (self-contained: SKILL.md, scripts, library,
references, photo/layout/icon assets — ~38 MB, 1.6k files; keep intact, scripts resolve assets
relative to the skill folder).

## When to use it

Any work that touches what the operator sees:

- `noroute_src/dashboard/page.html`, `styles.css`, and the `dashboard/*.js` view modules
- any new HTML page, theme, accent, splash, modal/toast transition, or icon work
- reviewing/redesigning an existing view ("looks generic", "looks AI-made")

The dashboard is plain HTML/CSS/JS with no framework, so the skill applies directly: static
HTML/CSS plus the app/dashboard guidance in its SKILL.md (`app-frame`, real product UI, no
generic dashboard fragments).

## How to invoke

- ZCode: `/design-taste-frontend` (project skill; first use after install may need a new session).
- Any agent: read `.zcode/skills/design-taste-frontend/SKILL.md` and follow it.

Requirements: Node 22+ (repo runs Node 24) and Chrome, Edge, or Chromium for the screenshot gate.
No API keys; internet used only to search images.

## Core commands

From the skill directory (`node scripts/…`):

| Command | Purpose |
|---|---|
| `gate.mjs --start index.html` | begin a checked build; then `gate.mjs` re-checks in a real browser at 1440/768/390 and auto-fixes over up to 3 rounds |
| `gate.mjs --quick` | fast subset check |
| `gate.mjs --done` | final gate before declaring a build finished |
| `shoot.mjs --url <url/file> --out shot.png` | screenshot a page at `--w 1440 --h 900` |
| `start.mjs deal --page <kind>` | deal layout/typography/palette directions for a page |
| `photos.mjs search <query>` | license-safe stand-in photographs (CC0/PD/CC BY) |
| `copy-lint.mjs <file>` | lint copy for AI-slop tells (see `references/copy-tells.md`) |

## House rules that bind this repo

The skill's nine house rules (SKILL.md) win over anything else when doing UI work. In practice
here:

- Every visual renders — no empty grounds at 1440/1024/768/390 (the dashboard is a desktop app;
  still keep 1024 sane).
- One section per screen; equal left/right edges; hover micro-motion via the skill's motion
  layer, never hand-rolled tilt/carousels.
- Real product UI in `app-frame` for router views — actual account rows, usage charts, quota
  cards — never placeholder fragments on panels.
- No captions under images; license credits in one footer line.
- Copy: no AI-slop voice. Run `copy-lint.mjs` on any new UI copy; voice rules in
  `references/copy-voice.md`.

## References worth reading before UI work

- `references/layout-v4.md` — the layout bar (figma.com / x.ai standard)
- `references/gate.md` — what the gate checks and how the fix rounds work
- `references/copy.md` + `copy-voice.md` — documentation and UI copy voice (also applies to
  writing `noroute_docs/*.md` prose so docs don't read slop-generated)
- `references/motion.md` — the micro-interaction layer the dashboard should use
