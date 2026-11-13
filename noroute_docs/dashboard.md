# Dashboard

Dashboard shell is served by the same HTTP process. It uses HTML, CSS, and vanilla JavaScript; no framework or build step.

## Screens

- `/`: request overview, provider readiness, stats, request-volume chart, model bars, activity, health.
- `/map`: full service map — client, local gate, upstream lanes, and outcomes with a live event feed.
- `/providers`: provider cards and a modal to add a custom provider. Models are optional at creation; add them later on the provider's Models tab. The add form picks a wire format — OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages — and prefills the matching chat path (`/chat/completions`, `/responses`, `/messages`); typing a custom path keeps it when the format changes.
- `/providers/:id`: provider detail.
- `/usage`: persistent usage with Daily, Weekly, Monthly, and All time ranges, each showing totals, a bucket chart, and a model breakdown.
- `/combos`: combo list, the global vision routing rule, and an Aliases and rules card — model aliases plus conditional routing rules evaluated top to bottom with the first match winning. A rule can match a request header, an API key, a minimum context size, or tool presence (conditions are ANDed), and it carries an ordered fallback chain; a target that no longer resolves is marked `Unavailable`.
- `/settings`: theme, accent, connection details, request log, reset.
- `/api-keys`: multiple managed proxy keys, auto/custom token creation, persistent Show/Hide/Copy, edit/rotate, `/v1` protection toggle, expiry/request/token limits, an optional default model (used when a request omits `model`; clear it by emptying the field), and daily usage history.

## Provider detail tabs

### Accounts

Server-paginated account table with search by label/UID and filters: all, active, cooling, error, paused. Actions include check, pause/resume, delete, select/bulk update. Each account name carries its subscription tier badge — Free, Plus, Pro, Ultra, Team, Business, or Enterprise. The tier comes from the account's stored `plan`; an account whose tier has not been read yet shows no badge rather than a guess.

Clicking an account name opens a summary popup: Today, Last 7 days, Last 30 days, and Lifetime request/token counts, a 30-day token bar chart, and lifetime errors. The popup header repeats the account kind, tier, and masked credential. Windows come from `account_usage`, which is keyed by **UTC** day and counts successful requests only; lifetime totals come from the account row and include failures. The endpoint is `GET /api/providers/:id/accounts/:accountId/summary` and never returns a raw token.

Above the filters, **Account strategy** picks how requests spend the pool: `round-robin` (default, rotate per request), `sequential` (first healthy account until it fails), or `highest-quota` (most remaining quota from the last quota read). The Save button PATCHes only `accountStrategy`; an unsaved selection survives the detail page's background refresh.

Add account and Bulk add open modal forms. Input first calls preview endpoint. Preview shows masked values, the name each new row will receive (`cbcn_1`, `cbcn_2`, …), and statuses (`new`, `duplicate`, `duplicate_input`, `invalid`). Edits invalidate old preview. Confirm performs the existing import endpoint. OAuth logins follow the same scheme (`cx_1`, `cx_2`, … for Codex; `ag_1`, `ag_2`, … for Antigravity).

Codex and Antigravity open a chooser first: browser OAuth, or paste an existing token. Antigravity login uses Google OAuth with a fixed local callback on port 1456 and stores the bound Cloud Code project with the account; a failed start (missing `ANTIGRAVITY_CLIENT_ID`/`ANTIGRAVITY_CLIENT_SECRET`, or the port already in use) returns a message instead of opening a tab. Logging in again with an account that is already pooled refreshes that row (tokens, tier, project binding) instead of adding a second row. The panel shows the upstream deprecation warning: the Cloud Code gateway is undocumented and flagged deprecated (`RISK_NOTICE`), so Google can change or block it without notice.

### Models

A provider can exist with no models. Add them here, or in the edit form; the edit form refuses to clear a catalog that already has models, so an accidental empty save cannot wipe routing.

- Fetch from provider.
- Add/remove custom models.
- Test one model.
- Test all models.
- Test all + disable errors.
- Disabling a model hides it from `/v1/models` without deleting it; a Codex catalog refresh keeps the choice.

Model test requires active account. Answer to the fixed diagnostic prompt appears in a bottom-right closeable toast. Answer is escaped and bounded.

### Quota

- Relayed traffic card: local process counters.
- Upstream quota card: per-account quota for one active account — CodeBuddy billing meter, Codex WHAM windows, or Antigravity's shared Cloud Code weekly/5h pools.

These are different metrics and must not be conflated.

### Usage

Per-provider slice of the persistent usage history: Daily, Weekly, Monthly, and All time. Shows requests, tokens in/out, success rate, estimated cost, the bucket chart, and a model breakdown for that provider only. The tab loads on activation (a background detail refresh does not refetch it), and the chart follows the chart type selected on `/usage`. Buckets use the server's local timezone, matching `/usage`; the endpoint is `GET /api/providers/:id/usage?range=day|week|month|all`.

## Vision routing

The Combos page also carries one global rule for image requests. When it is on, a chat request whose **newest message** brings an image part is forced onto the configured chain, whatever model or combo the client asked for; when it is off, the request keeps its requested or default model. Newest-message detection covers a fresh user turn and a tool result that just returned a screenshot. Clients resend the whole conversation, so an image that is only replayed — from an earlier turn, or from an earlier step of the same tool loop — does not pin later calls to the vision chain; those continue on the requested model. Detection covers `image_url` (Chat Completions), `input_image` (Responses), and `image` (Anthropic Messages) parts inside a content array. Returning to the requested model strips those replayed image parts (replacing each with a text placeholder) because some upstreams refuse any image input, including history.

The rule is stored in the SQLite `meta` table under `vision_routing` and edited through `GET/PATCH /api/vision-routing`; a PATCH merges, so omitted fields keep their value. Entries are validated through the normal model resolver and stored canonically as `prefix/model`, with duplicates rejected. The server refuses to enable a rule with no targets.

Two strategies: Order tries the chain top to bottom every request; Round robin rotates the first target by one per image request and resets on save. Routing reuses combo semantics: one credential attempt per target, fallback only for target-shaped failures, nothing written to the response before a target succeeds, and a total failure names the attempted targets with `error.vision = true`.

A saved target that no longer resolves is skipped at request time and marked `Unavailable` in the card; if every target is gone, the request keeps the model it asked for. Removing the last model in the UI also switches the rule off, mirroring the server guard.

## Aliases and routing rules

The same page hosts a second card. Aliases rename a target for clients: a request for the alias name is served by the target, and the request log traces it as `alias` with the asked name preserved. An alias target may be a model or a combo.

Routing rules reroute a request when it matches. Each rule has a name, an on/off state, one or more conditions, and an ordered fallback chain. Conditions are ANDed, at least one is required, and an enabled rule needs at least one model:

- a request header whose value contains the configured text (case-insensitive);
- the managed API key that authenticated the request;
- a minimum estimated context size, counted from the message content and tool definitions;
- whether the request carries tools.

Rules run top to bottom and the first match wins. A match replaces the request's model with the rule's chain, using combo semantics; the request log traces it as `rule` and names the rule. Aliases apply first, so a rule sees the rewritten model. Precedence overall is vision routing, then the key's default model (only when the client sent no model), then alias, then the first matching rule, then combo, then a single model.

Settings live in the `meta` table under `routing_rules` and are edited through `GET/PATCH /api/routing-rules`. The GET also returns the model catalog, the combo names, and `{id,name}` for each managed key so the card can fill its pickers. Limits are 50 aliases, 20 rules, 20 models per chain, 120 characters per alias name, and 60 per rule name. A chain target that no longer resolves is skipped at request time, and a rule whose whole chain is gone leaves the request on the model it asked for.

## Request log

Settings > Request log lists the last 200 chat requests from memory. Each row is redacted by construction: time, status, route, provider, served model, token counts, and latency. Prompts, tool arguments, headers, keys, and credentials are never stored. The buffer clears on restart or with Clear, so it is a live troubleshooting aid; `/usage` remains the durable history.

The Route column answers "why did my request change model" without reading upstream bills:

- `direct` — the requested model served the request; normal resolution.
- `combo` — a combo was expanded, and the served model is the real model that answered, not the combo name.
- `vision` — the global vision rule forced the request onto its chain because the newest message carried an image.
- `alias` — a model alias renamed the target before routing; the trace shows both names.
- `rule` — a routing rule matched the request and replaced its chain; the trace names the rule.

A request that sends no `model` at all is served by the API key's default model when one is set, and is traced as `direct`.

Under the served model, `asked <name>` appears when routing remapped the request, and `tried a → b` appears when a chain walked past failed targets before one answered. An `image` chip marks a request whose newest message carried an image, including when the vision rule is off. Long chains stay on one line and ellipsize; hovering reveals the full chain. Failed requests keep the same trace, so a 502 still shows what the client asked for and which targets were tried.

## Daily budgets

Settings > Daily budgets is a full-width card with an on/off switch and two groups, API keys and providers. Each row shows the day's tokens and estimated spend plus optional token and cost caps; the meta line names the current day and says limits reset at local midnight.

- Typing a limit and leaving the field saves that row; clearing both fields removes the cap. The same PATCH replaces the scope's whole limit, so both fields are sent together and a blank one clears that dimension.
- A row with a cap shows a percentage of the tighter dimension; the numbers come from the same counters the request gate reads, so the card and the 429 agree.
- An unscoped row simply counts nothing, and a capped key's requests fail with 429 while a capped provider is skipped by chains. Alerts use the webhook configured in the same page.
- The card stays useful with budgets off: configured limits are still listed with today's counters, so an operator can see what would apply before re-enabling.

## Scheduled upkeep

Settings > Scheduled upkeep re-reads expiring tokens, quota, and the model catalog in the background while the server runs. The card has an on/off switch, an interval field (5–1440 minutes, default 15), a clock line (`Scheduler active · last pass Nm ago`), one row per task with its own cadence and an `OK` / `Failed` / `Due` chip, and **Run all now**.

- The interval button applies the typed value immediately; changing it rebuilds a running timer without restarting the server.
- **Run all now** POSTs every task ID and works even with the scheduler disabled, so credentials can be verified on demand. The note reports `N tasks finished in X ms` or the failing tasks.
- Rows show the last summary and how long it took; nothing about tokens, prompts, or responses is stored.

## Appearance and motion

Themes: Light (paper), Dark (charcoal at night), Black (terminal). Accents: Blue (default), Amber, Rose, plus neutral Ink, Graphite, Slate. The colour lands on buttons, focus rings, bars, chart fills, and the active nav mark; the shell itself stays black, dark grey, and white. Values are stored in browser localStorage keys `norouter.theme` and `norouter.accent`, applied before first paint. Older coloured accent names are folded onto the closest current hue before use. Type is Host Grotesk for UI and JetBrains Mono for code/numbers, bundled locally under `/assets/fonts/` so the console never depends on a webfont CDN.

Splash, route transitions, modal transitions, and model-test toast transitions are short and non-layout-affecting. `prefers-reduced-motion: reduce` disables nonessential animation.

Route changes crossfade: the outgoing page is pinned out of the flow (`position: absolute` inside the relative `.main`, `pointer-events: none`) while the incoming page fades and rises into place. Hiding the old page before showing the new one left an empty frame, which read as a flash. With reduced motion the swap is immediate and no pseudo page is animated.

## Layout stability

Routes differ in height, so the browser scrollbar appears on some pages and not others. `html { scrollbar-gutter: stable }` reserves that space once for every route, keeping the content width identical when switching pages or when a modal locks body scroll. Engines without `scrollbar-gutter` fall back to `overflow-y: scroll`. Measured at 1200×620: `.main` stays 1069.84px wide and left-aligned at 98.58px across dashboard, usage, settings, providers, and the locked-scroll modal state.

## Polling

- Dashboard refreshes `/api/status` every two seconds while the document is visible.
- `/usage` also refreshes `/api/usage?range=<active range>` on the same tick.
- Provider detail refreshes provider snapshot and account data as needed.
- Account rows are never rendered as a full 1,000-row DOM list.
- The service map holds one `EventSource` to `/api/live` open only while the `/map` page is visible; hiding the tab or leaving `/map` closes it.

## Service map

The full board on `/map` shows the client, the local gate's three identity pills (auth, route, relay), upstream lanes, the chat/tool/token outcomes, and a 12-event feed (time, phase, provider·model, latency or tokens). The dashboard itself no longer carries a compact copy.

- Lanes come from ready providers in the `/api/status` snapshot — eight on the full page. Health dots follow `credential` and quota; retries and errors use the warning/error tokens, never a second accent.
- Counters (requests, errors, last latency, tokens) are per browser session and reset on reload. The feed is the only history: nothing extra is persisted or fetched.
- Every configured wire draws as a solid line as soon as its topology is known, including before the first status poll for the client→gate path. A wire switches to a moving dash only while a request is in flight; after the request ends it keeps the motion for the two-second linger, then settles back to a static line. No request means no motion.
- Particles are spawned only by real `start`/`route`/`finish` events.
- All colours come from the theme tokens, so switching theme or accent in Settings recolours the map without a reload. Reduced motion drops particles and pulses but keeps the text and counters updating.
- Without `EventSource` the map falls back to a `polling only` chip and stays on `/api/status`; it never fabricates events.

## Request volume

The dashboard chart draws one slot per bucket, using the same fixed bucket set as `/usage`: hourly for Daily, daily for Weekly and Monthly, monthly for All time, in the server's local timezone. An empty bucket stays on the axis as a short tick, so gaps are visible instead of compressed.

- Bar height compares total requests — successes plus failures — not tokens.
- Failures cap the top of a bar in the error colour; a single failure reads as a sliver rather than recolouring the whole column.
- Buckets that have not elapsed yet are dimmer, and the remaining part of the window is shaded behind the bars with a dashed "now" edge. "Now" is computed in the report timezone, so a browser running in another zone still sees the correct upcoming region.
- Slots share the width equally and bars are capped and centred inside their slot, so a 7-day or All-time window fills the axis instead of huddling at the left edge.
- The header chip names the granularity, the foot prints the first, middle, and last bucket, and the summary line states successes, failures when present, and the peak bucket.
- The chart carries `role="img"` with the summary as its label; the text line below is the readable path for screen readers and for anyone who does not hover.

## Usage page

Ranges are Daily (24 hourly buckets), Weekly (Monday-first, 7 daily buckets), Monthly (calendar month, daily buckets), and All time (monthly buckets from the oldest saved row). Buckets follow the server machine's local timezone; the page shows the active timezone name. Totals, chart, and model rows all come from `/api/usage`, which reads SQLite, so the numbers survive a restart.

The page polls `/api/usage` every two seconds while the document is visible, so new traffic appears without a manual reload. A `live · <age>` chip reports the last successful poll and switches to `offline — retrying` when the request fails. Unchanged reports skip re-rendering so the chart does not flicker.

## UI security

Provider account tokens are never returned to the dashboard. Managed proxy API keys are returned by the local API-key API for persistent Show/Hide/Copy; the browser is part of the local operator trust boundary.

All destructive dashboard actions use a custom confirmation modal with Cancel/Confirm, keyboard Escape, backdrop close, and focus restoration. Browser `confirm`, `alert`, and `prompt` are not used. Native file picker remains for account `.json`/text import; semantic controls, native date/time inputs, and OS scrollbars remain native unless a concrete UI requirement needs replacement.
