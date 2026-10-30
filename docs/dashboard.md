# Dashboard

Dashboard shell is served by the same HTTP process. It uses HTML, CSS, and vanilla JavaScript; no framework or build step.

## Screens

- `/`: request overview, provider readiness, stats, requests sparkline, model bars, activity, health.
- `/providers`: provider cards and custom provider form.
- `/providers/:id`: provider detail.
- `/usage`: persistent usage with Daily, Weekly, Monthly, and All time ranges, each showing totals, a bucket chart, and a model breakdown.
- `/settings`: theme, accent, connection details, reset.
- `/api-keys`: multiple managed proxy keys, auto/custom token creation, persistent Show/Hide/Copy, edit/rotate, `/v1` protection toggle, expiry/request/token limits, and daily usage history.

## Provider detail tabs

### Accounts

Server-paginated account table with search by label/UID and filters: all, active, cooling, error, paused. Actions include check, pause/resume, delete, select/bulk update.

Above the filters, **Account strategy** picks how requests spend the pool: `round-robin` (default, rotate per request), `sequential` (first healthy account until it fails), or `highest-quota` (most remaining quota from the last quota read). The Save button PATCHes only `accountStrategy`; an unsaved selection survives the detail page's background refresh.

Add account and Bulk add open modal forms. Input first calls preview endpoint. Preview shows masked values and statuses (`new`, `duplicate`, `duplicate_input`, `invalid`). Edits invalidate old preview. Confirm performs the existing import endpoint.

### Models

- Fetch from provider.
- Add/remove custom models.
- Test one model.
- Test all models.
- Test all + disable errors.

Model test requires active account. Answer to the fixed diagnostic prompt appears in a bottom-right closeable toast. Answer is escaped and bounded.

### Quota

- Relayed traffic card: local process counters.
- Upstream quota card: CodeBuddy billing meter for one active account.

These are different metrics and must not be conflated.

## Appearance and motion

Themes: Light, Dark, Black. Accents: Violet, Blue, Teal, Amber, Rose. Values are stored in browser localStorage keys `norouter.theme` and `norouter.accent`, applied before first paint.

Splash, route transitions, modal transitions, and model-test toast transitions are short and non-layout-affecting. `prefers-reduced-motion: reduce` disables nonessential animation.

Route changes crossfade: the outgoing page is pinned out of the flow (`position: absolute` inside the relative `.main`, `pointer-events: none`) while the incoming page fades and rises into place. Hiding the old page before showing the new one left an empty frame, which read as a flash. With reduced motion the swap is immediate and no pseudo page is animated.

## Layout stability

Routes differ in height, so the browser scrollbar appears on some pages and not others. `html { scrollbar-gutter: stable }` reserves that space once for every route, keeping the content width identical when switching pages or when a modal locks body scroll. Engines without `scrollbar-gutter` fall back to `overflow-y: scroll`. Measured at 1200×620: `.main` stays 1069.84px wide and left-aligned at 98.58px across dashboard, usage, settings, providers, and the locked-scroll modal state.

## Polling

- Dashboard refreshes `/api/status` every two seconds while the document is visible.
- `/usage` also refreshes `/api/usage?range=<active range>` on the same tick.
- Provider detail refreshes provider snapshot and account data as needed.
- Account rows are never rendered as a full 1,000-row DOM list.

## Usage page

Ranges are Daily (24 hourly buckets), Weekly (Monday-first, 7 daily buckets), Monthly (calendar month, daily buckets), and All time (monthly buckets from the oldest saved row). Buckets follow the server machine's local timezone; the page shows the active timezone name. Totals, chart, and model rows all come from `/api/usage`, which reads SQLite, so the numbers survive a restart.

The page polls `/api/usage` every two seconds while the document is visible, so new traffic appears without a manual reload. A `live · <age>` chip reports the last successful poll and switches to `offline — retrying` when the request fails. Unchanged reports skip re-rendering so the chart does not flicker.

## UI security

Provider account tokens are never returned to the dashboard. Managed proxy API keys are returned by the local API-key API for persistent Show/Hide/Copy; the browser is part of the local operator trust boundary.

All destructive dashboard actions use a custom confirmation modal with Cancel/Confirm, keyboard Escape, backdrop close, and focus restoration. Browser `confirm`, `alert`, and `prompt` are not used. Native file picker remains for account `.json`/text import; semantic controls, native date/time inputs, and OS scrollbars remain native unless a concrete UI requirement needs replacement.
