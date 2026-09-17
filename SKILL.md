---
name: layout-shift-detector
description: Audit web pages for layout shifts and content flashes — containers that change dimensions or move as data loads in, and components that briefly show content before being replaced by another state (a "not found"/empty/error prompt), breaking the premium feel of a product. Uses the Claude in Chrome browser tools to watch every element's geometry and lifecycle from first paint and reports exactly which elements shifted or flashed, when, and by how much. Use this whenever the user mentions layout shifts, CLS, content jumping, flashing or flickering content, pages "popping" or "jank" during load, containers resizing as data arrives, skeleton/loading-state audits, or asks to check their app/site for visual stability — even if they don't use the terms "layout shift" or "flash".
---

# Layout Shift Detector

Find and report layout instability in a running web app: elements that move or change size after first paint, typically as API data, images, or fonts arrive — plus **content flashes**: components that briefly render real content and are then removed, hidden, or covered by another state (a "not found" prompt, an error card, an empty state). Flashes are just as jarring as shifts but often move nothing, so they need lifecycle tracking, not just geometry. The output is a findings report — precise selectors, before/after dimensions, text snippets of what flashed, and timing — so the developer can decide how to fix each one.

## Ground rules

- **Never start a dev server yourself.** The user runs their own dev servers. Always ask for the URL of the running instance (or production/staging URL) if one wasn't given.
- This skill measures; it does not fix. Report findings only — no fix recommendations — unless the user separately asks for fixes.
- Requires the Claude in Chrome tools (`mcp__claude-in-chrome__*`). Load them via ToolSearch in one call before starting: `navigate`, `javascript_tool`, `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `computer`.

## Why the method is what it is (read before measuring)

The obvious tool for this job — the Layout Instability API (`layout-shift` PerformanceObserver entries) — is unreliable in this environment, and it fails *silently*, reporting zero shifts in a way that looks like a clean page:

1. **Occluded windows record nothing.** Chrome only produces layout-shift entries when frames are composited. The user's Chrome window is frequently behind other windows or minimised while you work, so `document.visibilityState` is `"hidden"` and the API yields zero entries no matter how badly the page shifts.
2. **The isolated world never sees the entries.** The javascript tool executes in an isolated world; layout-shift entries are only delivered to observers in the page's main world.

Because both failure modes masquerade as "no shifts found", the primary method is one that has neither: **rect-diff polling in a same-origin iframe** (`scripts/measure-shifts.js`). `getBoundingClientRect` forces layout even in hidden tabs, works fine from the isolated world, and because the script creates the iframe itself, observation starts before the page's first paint. The polling loop runs on a MessageChannel, which — unlike `setTimeout` or `requestAnimationFrame` — is not throttled in hidden windows. This method produced consistent, complete results in testing under conditions where the CLS API produced nothing at all.

The trade-off: it yields a `pseudoImpact` ranking (area × distance, viewport-normalised) rather than a true CLS score. Element identities, pixel deltas, and orderings are exact; only the Core-Web-Vitals-comparable number is approximate. If the user specifically needs a real CLS score, see "Optional: true CLS score" below.

## Workflow

### 1. Establish scope

Ask the user (one question, with options) unless already clear from their message:

- **Specific pages** — they give you the URL(s)/routes to audit.
- **Auto-discover** — they give a base URL; you find internal routes yourself.

If auto-discovering: navigate to the base URL, run `scripts/discover-links.js` via the javascript tool, then show the discovered paths and let the user confirm or trim the list before auditing (audits cost real time — don't silently audit 40 pages). If running unattended, pick a representative subset (home plus the most data-driven-looking routes) and say so in the report.

Also worth asking when relevant: a specific viewport size (shifts differ between desktop and narrow widths; default is the current window size, which the script reads automatically).

### 2. Audit each page

Work in a tab you created (never hijack the user's active tab). Navigate once to any page of the target origin — the measuring iframe needs a same-origin host page. Then for each route:

1. **Pre-warm the route first.** Dev servers with on-demand compilation take up to ~14s on a route's first hit, which reads as "didn't render" and contaminates cold-load timing. Load each route once (a throwaway run or plain navigation) before the measured runs; cold-vs-warm remains a *finding*, but compilation lag must be controlled out before that finding means anything.
2. Read `scripts/measure-shifts.js`, set the `CONFIG.path` to the route, and run it via the javascript tool. It loads the route in a hidden same-origin iframe, polls every element's rect, lifecycle, and text from navigation start for `durationMs` (default 12s), and resolves to a JSON report with four finding types: `elements` (geometry changes, each classified into buckets — see below — with selector, rects, max deltas, `pseudoImpact`), `flashes` (content that appeared and was removed or hidden within `flashMaxMs`, with a text snippet of what flashed and its lifetime), `lateAppearances` (large elements arriving well after first paint — candidate covering states like "not found"/error prompts), and `textReflows` (text-holding elements whose text changed at the same moment they resized or their siblings moved — the skeleton-swapped-for-longer-text pattern, with before/after text).
3. **Validate the run before reading findings.** Every result carries `domNodeCount` and `title`. A real app page has hundreds-to-thousands of nodes; a low count (rule of thumb: < ~900 for a full app shell, calibrate against a known-good page) means the route half-rendered or hit an auth wall/error page — treat the run as *invalid* and re-run, never as clean. False-cleans are the most common failure mode of this kind of audit. The result also carries `requestCount`/`requests` from in-iframe fetch/XHR instrumentation — use these to correlate shifts with data arrival, and never conclude "no API calls" from `performance.getEntriesByType('resource')`, which hides cross-origin XHRs.
4. **Keep every tool call under ~40 seconds.** The browser tool bridge times out around 45s; batching several routes into one call silently kills the run and leaves orphaned iframes booting. One route per call, default `durationMs` well within budget.
5. **If the backend is localhost, strongly consider `networkDelayMs: 2000`.** Local APIs resolve in single-digit milliseconds and apps often cache data in memory, so loading states — the very thing that causes shifts for real users — never render. The delay shim reproduces them. When you use it, subtract it mentally from reported timings and say so in the report.
6. Run each route **twice**: once cold, once again immediately (warm). Apps frequently shift on cold load but not warm (caches, fonts); the difference is itself a finding. If a run's results look implausibly clean, re-run before believing it — and check `parentVisibility` in the output to know what conditions you measured under.
7. If the dev server hot-reloads (HMR) during your session, injected state on `window` is wiped without warning. If you build any multi-call harness, stash the source in `sessionStorage` and re-`eval` it when your handle comes back undefined, rather than assuming a prior call's setup survived.

Interpreting the output:

- **Buckets are the ground truth of what a user saw.** Every geometry change is classified: `appeared` (0×0 → painted; a `display:none` gate lifting — often under a loader the user is already watching), `disappeared` (painted → 0×0; a skeleton vacating), `displaced` (painted content actually moved — the only bucket that contributes to `pseudoImpact`), and `resized` (grew/shrank in place; its pushed neighbors score as `displaced`). An element whose changes are all `appeared`/`disappeared` did not shift anything — reveals and skeleton exits are normal loading behavior, not jank. This classification exists because raw geometry scoring ranked a preload-root collapse and full-width zero-height portals as "worst offenders" when nothing visibly moved.
- `dimensionChanged: true` marks elements whose own width/height changed — the "containers that resize as data loads" the user typically cares most about. Elements that only moved were pushed by something else; the resizing culprit normally appears above them in the same list.
- Elements with hundreds of shift samples are usually animations implemented with layout properties (top/left/width) rather than transforms — report these as their own category (continuous layout churn), separate from one-off load shifts.
- Zero-size or off-screen elements (portals, overlays) that move are noise; the script filters invisible ones, but flag and exclude anything with no visual footprint that slips through.
- A full-viewport pair like `#preload-root` collapsing to 0×0 while `#app` expands to full size is the app-boot skeleton swap — the buckets already keep it out of the scoring (`disappeared`/`appeared`); mention it once if the swap is visually mismatched, don't rank it.
- **`textReflows` answers "why did this shift?"** for the skeleton-text pattern: a small text-holding element whose text changed (`textBefore` → `textAfter`) at the same instant it resized or its siblings moved. This is the "skeleton reserved less space than the real text" finding — report it joined with the displacement it caused, quoting the before/after text so the developer can find the component instantly. Text changes that displaced nothing are already filtered out (a ticking counter in a fixed-width slot is fine).
- **`flashes` is the "briefly shows content, then switches state" pattern** the user finds most jarring for clients: a component renders real data, then a loading/"not found"/error state takes over and the content vanishes. The `textSnippet` tells you what the user glimpsed; `lifetimeMs` how briefly. Cross-reference with `lateAppearances`: a flash at ~1200ms plus a large late appearance at ~1250ms whose snippet reads "Not found" is one finding — a state-ordering bug (content rendered before the guard/loading state resolved), not two separate quirks. Report them together.
- `flashes` entries whose snippet is a spinner/skeleton (empty text, "Loading…") are normal loading states disappearing — that's healthy; exclude them. A flash matters when real content (names, numbers, table rows) was visible first.
- `lateAppearances` also legitimately contains the main content mounting late; only entries that *cover previously visible content* or represent an end state ("not found", error text) are findings. Judge by the snippet and rect overlap with earlier flashes.
- The full app boot swap will often register as one large `lateAppearance` — same rule as the preload swap: mention once, don't rank.
- SPA caveat: each iframe load is a full cold navigation of that route, which is exactly what you want for per-route attribution.
- Flash timing is sensitive to backend speed: with a localhost backend and no `networkDelayMs`, a flash may be a single 60ms blink or skipped entirely; with the delay shim it stretches to visible length. If the user reports flashing you can't reproduce, raise `networkDelayMs` and lower `pollMs` (e.g. 30) before concluding it's gone.
- If you extend the audit to interactions (clicking tabs, filters, navigation), remember real CLS discounts shifts within 500ms of user input (`hadRecentInput`). This harness has no such discount — a route transition measured this way scores enormously and means nothing. Separate interaction-triggered measurements from load measurements and only report interaction shifts that happen well after the input settled.

### 3. Report findings

One report for the whole run. Structure:

```
# Layout shift audit — <app name or base URL> — <date>

## Method note
<viewport, poll duration, networkDelayMs if used, cold vs warm, any caveats>

## Summary
<one line per page: route, shifting-element count, worst offender>

## App-wide findings
<elements that shift on every/most pages — sidebars, headers, indicators — listed once>

## <route>
domNodeCount <n> · <r> requests · run valid

| Element | What the user saw | Resized itself? | Size before → after | Max move | When (ms) |
|---|---|---|---|---|---|
| <selector> | content below pushed down 193px | yes | 1470×470 → 1470×663 | +193px ↓ | ~4100 |

### Text reflows
| Element | Text before → after | Size before → after | Effect | When (ms) |
|---|---|---|---|---|
| <selector> | "" → "srv-eu-01 — Frankfurt, 24 players" | 120×20 → 260×20 | pushed 3 siblings right | ~2100 |

### Content flashes
| Element | What was glimpsed | Visible for | Replaced by | When (ms) |
|---|---|---|---|---|
| <selector> | "srv-eu-01 · 24 players online…" | 340ms | "Server not found" prompt covering the card | ~1210 |
```

**The "What the user saw" column is mandatory for every finding.** Describe the actual visible effect in user terms: "content below moved 78px down", "sidebar items slid under the cursor", or — if you can't fill it in because nothing visibly moved ("this is a reveal under the loader") — that finding doesn't belong in the table. Writing this column is the self-check that catches misclassified non-shifts before the user reads them.

Order elements worst-first (by `pseudoImpact`). Pull repeating offenders out of the per-page tables into "App-wide findings" — a sidebar that shifts on all six pages is one finding, not six. Where a `textReflow`, a shift, and a request timestamp line up, report them as one story: "at ~2100ms `/v1/instance/all` resolves, the name cell's text goes from skeleton-empty to 'srv-eu-01 — Frankfurt', the cell grows 140px, and the row's action buttons displace right". After each table, add a short prose note tying the shifts to the triggering request from the `requests` log, but do not prescribe fixes.

Deliver the report as a markdown file via SendUserFile (or inline if it's a single small page), along with the raw JSON per page.

## Optional: true CLS score

Only worth attempting when the user explicitly wants a Core-Web-Vitals-comparable number AND the Chrome window is actually visible on screen (`document.visibilityState === 'visible'` — check it, don't assume). Use `scripts/collect-shifts.js`, which reads buffered layout-shift entries — but it must be injected into the page's **main world** via a `<script>` element (the javascript tool's isolated world never receives the entries); have it post its result to a DOM attribute or message you can read from the tool side. If visibility can't be guaranteed, skip this entirely — a CLS of 0 measured in a hidden window is misinformation, not data.

## Edge cases

- **Page requires login**: ask the user to log in in their browser first; the iframe shares the profile's session cookies.
- **Same-origin restriction**: the iframe technique requires the host tab to be on the same origin as the audited route. For auditing multiple origins, navigate the host tab to each origin in turn.
- **Frame-busting apps** (X-Frame-Options/CSP `frame-ancestors` on same-origin, rare): fall back to auditing in the host tab directly — navigate to the route and immediately run a rect-diff poller against the top document; you lose the pre-first-paint start but keep everything else.
- **Very heavy DOMs**: the script caps tracking at 4000 elements per snapshot; if a page exceeds that, raise the cap or scope the poller to the main content container, and note it.
