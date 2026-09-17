# layout-shift-detector

A Claude skill that audits running web apps for the loading-phase jank that cheapens an otherwise polished product:

- **Layout shifts** — containers that move or change dimensions as data loads in, pushing neighboring content around.
- **Content flashes** — components that briefly render real content before being replaced by another state (a "not found" prompt, an error card, an empty state).
- **Text reflows** — skeletons or placeholders swapped for text that takes up more space than was reserved, displacing siblings.

## How it works

The skill drives Chrome through the Claude in Chrome extension and measures with rect-diff and lifecycle polling in a hidden same-origin iframe (`scripts/measure-shifts.js`), sampled on an unthrottled MessageChannel loop from before first paint. The Layout Instability API is deliberately not the primary method: it silently records nothing when the browser window is occluded, and its entries never reach the extension's isolated world — both failure modes look identical to a clean page.

Every geometry change is classified (`appeared` / `disappeared` / `displaced` / `resized`) and only genuine displacement is scored, so reveals and skeleton exits don't rank as jank. Each run returns a render assertion (DOM node count, title) so half-rendered routes are treated as invalid instead of clean, plus an in-iframe fetch/XHR request log to correlate shifts with the exact data arrival. An optional network-delay shim reproduces loading states that resolve too fast against a localhost backend.

## Files

- `SKILL.md` — the skill definition and audit workflow
- `scripts/measure-shifts.js` — the measurement harness (shifts, flashes, text reflows, request log)
- `scripts/discover-links.js` — same-origin route discovery for whole-app audits
- `scripts/collect-shifts.js` — optional true-CLS supplement (only valid with a visible window, main-world injection)

## Usage

Install the skill in Claude (Cowork or Claude Code), point it at a running instance of your app, and ask for a layout shift audit. It never starts a dev server itself — you provide the URL.
