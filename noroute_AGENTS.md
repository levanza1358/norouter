# Agent instructions

## Project

- Node.js 22.5+ ESM for built-in `node:sqlite`. No dependencies, bundler, or build step.
- HTTP server uses native `node:http`; persistence uses native `node:sqlite`.
- Dashboard is vanilla HTML, CSS, and JavaScript.

## Commands

```bat
npm test
npm start
npm run dev
norouter start
```

`norouter start` is the CLI wrapper around `src/server.js`; `npm start` remains the
canonical direct entry point.

Run `npm test` after backend, routing, provider, database, or shared-library changes. For dashboard changes, verify the affected route and assets through the running server too.

## Boundaries

- `src/server.js`: HTTP server and top-level routing.
- `src/routes/`: HTTP request handling and response shape.
- `src/providers/index.js`: provider registry and provider CRUD boundary.
- `src/lib/db.js`: SQLite schema, connection, and persistence boundary.
- `src/lib/stats.js`: in-memory usage/activity state.
- `src/dashboard/page.html`, `styles.css`, `app.js`: dashboard markup, presentation, and browser behavior.
- `test/`: hermetic smoke coverage and upstream stubs.

Keep changes in the module that owns the behavior. Avoid moving state or adding abstractions without a concrete need.

## Safety

- APIKey saved in database with plain text so it can show and hide
- Do not edit `.env`, local database/WAL/SHM files, generated screenshots, or runtime state.
- Use `test/stub-upstream.js` instead of real credentials or upstream traffic.
- Preserve the no-dependency constraint unless the task explicitly approves changing it.
- Validate input at HTTP and persistence boundaries. Preserve existing error and SSE behavior.
- Use custom accessible confirmation modals for destructive or irreversible dashboard actions. Do not use `confirm`, `alert`, or `prompt`; native file picker remains allowed for account `.json`/text import. Keep semantic controls, native date/time inputs, and OS scrollbars unless a concrete UI requirement needs replacement.
- **No native UI chrome.** Dropdowns, scrollbars, toggles, and confirmation dialogs must use the dashboard's custom components. The only allowed native dialog is the OS file picker. A native `<select>` may stay in the DOM as the value holder, but it must be enhanced with `data-custom-select` so the visible control is `.cselect`.
  - Still pending migration (replace when the view is touched): native date/time inputs (API key expiry) and table checkboxes. Do not add new native controls beyond these.
  - New scroll containers inherit the global custom scrollbar; do not add per-element `::-webkit-scrollbar` styling except to hide a bar intentionally (for example `.rail-nav`).

## Skill routing

Read the relevant skill before editing, then follow `verify-change` before finishing:

- Every change: `.agents/skills/verify-change/SKILL.md`
- Dashboard/UI/browser behavior: `ui-polish` and `browser-check`
- Routes, providers, database, HTTP, or SSE: `backend-safe-change` and `api-contract`
- Credentials, provider URLs, exposure, or security-sensitive behavior: `security-audit`
- Release, commit, or distribution preparation: `release-check`

These files are required project guidance, not optional reference notes.

## Change discipline

1. Inspect the existing path and its tests before editing.
2. Read the skill files selected above before editing.
3. Make the smallest diff that satisfies the request.
4. Preserve public routes, response shapes, and backward compatibility unless explicitly changed.
5. Add or update one focused smoke check for non-trivial behavior.
6. Run the relevant checks. Report failures honestly; do not claim unrun checks passed.
