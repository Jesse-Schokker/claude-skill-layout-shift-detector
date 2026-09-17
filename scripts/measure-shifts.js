// Primary layout-shift + content-flash + text-reflow measurement — rect-diff
// and lifecycle polling in a same-origin iframe.
//
// Why this approach: it is the only method that proved bulletproof in practice.
// The Layout Instability API records NOTHING when the Chrome window is occluded
// (no composited frames) and its entries never reach the scripting tool's
// isolated world — both failure modes produce a silent, convincing "zero
// shifts" result. Rect polling has neither problem: getBoundingClientRect
// forces layout even in hidden tabs, works from the isolated world, and
// observes from the very first paint because we control the iframe's
// navigation start.
//
// Every rect change is CLASSIFIED, not just measured:
//   appeared    0×0 → painted   (a display:none gate lifting; not a shift)
//   disappeared painted → 0×0   (a skeleton vacating; not a shift)
//   displaced   painted element actually moved — THE ONLY BUCKET THAT SCORES
//   resized     grew/shrank in place without moving (its displaced neighbors
//               score; the resize itself is attribution, not displacement)
// Scoring raw geometry without buckets ranks reveals and skeleton exits as
// worst offenders when nothing visibly moved.
//
// The same loop tracks element LIFECYCLES (content flashes: real content
// briefly shown, then removed/hidden/covered by a "not found"/error state) and
// TEXT REFLOWS (short text-holding elements whose text changed — skeleton or
// placeholder swapped for longer real text — at the same moment they resized
// or their siblings moved; text changes that displace nothing are ignored).
//
// It also instruments the iframe's fetch/XHR: performance.getEntriesByType(
// 'resource') hides cross-origin XHRs, so resource timing CANNOT be used to
// conclude "no API calls" — the request log returned here is the truth, and
// it lets you correlate shifts to the exact data arrival.
//
// Usage: run via javascript_tool on any same-origin page of the target app
// (e.g. the base URL). Edit the CONFIG block, run, await the result. One call
// per route; keep each call's durationMs comfortably under the ~45s tool
// timeout (default 12s is safe).
(() => {
  const CONFIG = {
    path: '/',            // route to audit (same-origin path)
    durationMs: 12000,    // watch time after navigation starts; keep the whole
                          // call under ~40s — the tool bridge times out ~45s
    pollMs: 60,           // target sampling interval
    networkDelayMs: 0,    // artificially delay fetch/XHR responses inside the
                          // iframe (e.g. 2000) to reproduce loading states that
                          // resolve too fast against a localhost backend
    minDeltaPx: 2,        // ignore sub-pixel/jitter movements smaller than this
    maxElements: 4000,    // safety cap on elements tracked per snapshot
    width: null,          // iframe width; null = current viewport width
    height: null,         // iframe height; null = current viewport height
    // Flash detection:
    flashMaxMs: 2500,     // visible for less than this then gone = a flash
    flashMinArea: 1200,   // px² an element must reach to count as real content
    overlayAfterMs: 800,  // elements appearing later than this after first
                          // paint are checked as potential covering overlays
    overlayMinFrac: 0.15, // late element covering ≥ this fraction of the
                          // viewport is reported as a late appearance/overlay
    // Text-reflow detection (skeleton/placeholder swapped for longer text):
    textMaxLen: 240,      // only track text of elements up to this many chars
    textMaxChildren: 3,   // ...and with at most this many child elements
  };

  const W = CONFIG.width || innerWidth;
  const H = CONFIG.height || innerHeight;

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return '(non-element)';
    if (el.id) return `#${el.id}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`#${node.id}`); break; }
      const cls = [...node.classList].slice(0, 3).join('.');
      if (cls) part += `.${cls}`;
      const parent = node.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter(c => c.tagName === node.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };

  const snippet = (el) => {
    try {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return t.length > 100 ? t.slice(0, 100) + '…' : t;
    } catch (_) { return ''; }
  };

  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.style.cssText =
      `position:fixed;left:0;top:0;width:${W}px;height:${H}px;` +
      'visibility:hidden;pointer-events:none;z-index:-1;border:0;';
    document.documentElement.appendChild(frame);
    const t0 = performance.now();

    // Network instrumentation: ALWAYS count requests (resource timing hides
    // cross-origin XHRs — never infer "no API calls" from it); optionally also
    // delay responses. Re-patches across document swaps until load settles.
    const requestLog = [];
    const armNetwork = () => {
      const tryPatch = () => {
        try {
          const w = frame.contentWindow;
          if (w && !w.__lsdPatched && w.fetch) {
            w.__lsdPatched = true;
            const delay = CONFIG.networkDelayMs;
            const logReq = (url) => {
              if (requestLog.length < 200) requestLog.push({
                url: String(url).slice(0, 200),
                startMs: Math.round(performance.now() - t0),
              });
            };
            const origFetch = w.fetch.bind(w);
            w.fetch = (input, ...a) => {
              logReq(input && input.url ? input.url : input);
              const pr = origFetch(input, ...a);
              return delay
                ? pr.then(res => new w.Promise(r => w.setTimeout(() => r(res), delay)))
                : pr;
            };
            const origOpen = w.XMLHttpRequest.prototype.open;
            w.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
              logReq(url);
              return origOpen.call(this, method, url, ...rest);
            };
            if (delay) {
              const origDispatch = w.XMLHttpRequest.prototype.dispatchEvent;
              w.XMLHttpRequest.prototype.dispatchEvent = function (ev) {
                if (ev.type === 'load' || ev.type === 'loadend') {
                  w.setTimeout(() => origDispatch.call(this, ev), delay);
                  return true;
                }
                return origDispatch.call(this, ev);
              };
            }
          }
        } catch (_) { /* cross-doc transition; retry next tick */ }
      };
      const iv = setInterval(tryPatch, 5);
      setTimeout(() => clearInterval(iv), CONFIG.durationMs);
    };

    const prev = new Map();          // element -> last rect
    const meta = new Map();          // element -> lifecycle info
    const findings = new Map();      // element -> shift aggregate
    const textPrev = new Map();      // element -> last tracked text
    const textReflows = new Map();   // element -> text-reflow aggregate
    const flashes = [];              // short-lived visible content
    const lateAppearances = [];      // large elements appearing late (overlays)
    let samples = 0;
    let firstContentMs = null;       // when the iframe doc first had a body
    let domNodeCount = 0;            // render assertion — low count = invalid run
    let pageTitle = '';

    const snapshot = () => {
      const doc = frame.contentDocument;
      if (!doc || !doc.body) return;
      const now = Math.round(performance.now() - t0);
      if (firstContentMs === null) firstContentMs = now;
      pageTitle = doc.title || pageTitle;
      const els = doc.querySelectorAll('*');
      domNodeCount = els.length;
      const n = Math.min(els.length, CONFIG.maxElements);
      const moved = [];
      const pendingText = [];
      const currentSet = new Set();
      for (let i = 0; i < n; i++) {
        const el = els[i];
        currentSet.add(el);
        const b = el.getBoundingClientRect();
        const r = { x: b.x, y: b.y, w: b.width, h: b.height };
        const p = prev.get(el);
        prev.set(el, r);
        const area = r.w * r.h;
        let m = meta.get(el);
        if (!m) {
          m = { firstSeenMs: now, maxArea: 0, maxRect: null, everVisible: false, gone: false };
          meta.set(el, m);
          // Late large appearance = candidate covering overlay / swapped-in state.
          if (now - firstContentMs >= CONFIG.overlayAfterMs &&
              area >= CONFIG.overlayMinFrac * W * H &&
              lateAppearances.length < 20) {
            const parentLate = el.parentElement && meta.get(el.parentElement) &&
              meta.get(el.parentElement).firstSeenMs === now; // collapse subtrees
            if (!parentLate) {
              lateAppearances.push({
                selector: cssPath(el),
                appearedMs: now,
                rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) },
                viewportFraction: Math.round(area / (W * H) * 100) / 100,
                textSnippet: snippet(el),
              });
            }
          }
        }
        if (area > m.maxArea) { m.maxArea = area; m.maxRect = r; }
        if (area >= CONFIG.flashMinArea) m.everVisible = true;
        // Visible -> zero-area counts as a disappearance (display:none etc.).
        if (m.everVisible && !m.gone && area === 0) markGone(el, m, now, 'hidden');
        // Text tracking for small text-holding elements.
        const tag = el.tagName;
        if (el.childElementCount <= CONFIG.textMaxChildren &&
            tag !== 'SCRIPT' && tag !== 'STYLE' &&
            area < 0.3 * W * H) {
          const t = (el.textContent || '').slice(0, CONFIG.textMaxLen);
          const tp = textPrev.get(el);
          textPrev.set(el, t);
          if (tp !== undefined && tp !== t) pendingText.push({ el, before: tp, after: t, p, r, now });
        }
        if (!p) continue; // first sighting (mount) is not a shift of itself
        const dx = r.x - p.x, dy = r.y - p.y, dw = r.w - p.w, dh = r.h - p.h;
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh)) < CONFIG.minDeltaPx) continue;
        if (p.w * p.h === 0 && r.w * r.h === 0) continue; // never painted (area-based:
        // catches zero-height full-width portals the old w&&h check let through)
        // Classify. Only 'displaced' represents content a user saw move.
        const wasPainted = p.w * p.h > 0;
        const nowPainted = r.w * r.h > 0;
        const didMove = Math.abs(dx) >= CONFIG.minDeltaPx || Math.abs(dy) >= CONFIG.minDeltaPx;
        let bucket;
        if (!wasPainted && nowPainted) bucket = 'appeared';
        else if (wasPainted && !nowPainted) bucket = 'disappeared';
        else if (didMove) bucket = 'displaced';
        else bucket = 'resized';
        moved.push({ el, p, r, dx, dy, dw, dh, now, bucket });
      }
      // Removal sweep: elements we've tracked that are no longer in the doc.
      for (const [el, m] of meta) {
        if (!m.gone && !currentSet.has(el) && !el.isConnected) markGone(el, m, now, 'removed');
      }
      // Collapse children that merely rode along with an ancestor: keep an
      // element only if no ancestor changed by (approximately) the same
      // deltas in this sample. This applies to identical resizes too — when a
      // whole chain grows by the same amount, the outermost container is the
      // real finding; reporting every wrapper in the chain is noise.
      const movedSet = new Set(moved.map(m => m.el));
      const byEl = new Map(moved.map(m => [m.el, m]));
      for (const m of moved) {
        {
          let anc = m.el.parentElement, absorbed = false;
          while (anc) {
            if (movedSet.has(anc)) {
              const am = byEl.get(anc);
              if (am && Math.abs(am.dx - m.dx) < 2 && Math.abs(am.dy - m.dy) < 2
                     && Math.abs(am.dw - m.dw) < 2 && Math.abs(am.dh - m.dh) < 2) { absorbed = true; break; }
            }
            anc = anc.parentElement;
          }
          if (absorbed) continue;
        }
        const resized = Math.abs(m.dw) >= CONFIG.minDeltaPx || Math.abs(m.dh) >= CONFIG.minDeltaPx;
        let agg = findings.get(m.el);
        if (!agg) {
          agg = {
            selector: cssPath(m.el),
            shiftCount: 0,
            buckets: { appeared: 0, disappeared: 0, displaced: 0, resized: 0 },
            firstShiftMs: m.now, lastShiftMs: m.now,
            initialRect: { x: Math.round(m.p.x), y: Math.round(m.p.y), w: Math.round(m.p.w), h: Math.round(m.p.h) },
            finalRect: null,
            dimensionChanged: false,
            maxDelta: { x: 0, y: 0, w: 0, h: 0 },
            pseudoImpact: 0,
          };
          findings.set(m.el, agg);
        }
        agg.shiftCount++;
        agg.buckets[m.bucket]++;
        agg.lastShiftMs = m.now;
        agg.finalRect = { x: Math.round(m.r.x), y: Math.round(m.r.y), w: Math.round(m.r.w), h: Math.round(m.r.h) };
        if (resized) agg.dimensionChanged = true;
        agg.maxDelta.x = Math.max(agg.maxDelta.x, Math.round(Math.abs(m.dx)));
        agg.maxDelta.y = Math.max(agg.maxDelta.y, Math.round(Math.abs(m.dy)));
        agg.maxDelta.w = Math.max(agg.maxDelta.w, Math.round(Math.abs(m.dw)));
        agg.maxDelta.h = Math.max(agg.maxDelta.h, Math.round(Math.abs(m.dh)));
        // Only genuine displacement scores. Reveals (appeared), skeleton exits
        // (disappeared), and in-place resizes do not — an in-place resize's
        // pushed neighbors land in 'displaced' and score there.
        if (m.bucket === 'displaced') {
          const area = Math.max(m.p.w * m.p.h, m.r.w * m.r.h) / (W * H);
          const dist = Math.hypot(m.dx, m.dy) + Math.hypot(m.dw, m.dh);
          agg.pseudoImpact += Math.min(area, 1) * (dist / Math.hypot(W, H));
        }
      }
      // Text reflows: a text change matters only when it coincided with the
      // element resizing or a sibling moving — that's the "skeleton text
      // swapped in and pushed the neighbors" pattern. A ticking counter in a
      // fixed-size slot changes text but displaces nothing: ignored.
      for (const pt of pendingText) {
        const own = byEl.get(pt.el);
        const ownResized = own && (Math.abs(own.dw) >= CONFIG.minDeltaPx || Math.abs(own.dh) >= CONFIG.minDeltaPx);
        const sibMoved = moved.some(m => m.el !== pt.el && m.el.parentElement === pt.el.parentElement);
        if (!ownResized && !sibMoved) continue;
        let agg = textReflows.get(pt.el);
        if (!agg) {
          if (textReflows.size >= 40) continue;
          agg = {
            selector: cssPath(pt.el),
            textBefore: pt.before.replace(/\s+/g, ' ').trim().slice(0, 100),
            textAfter: '',
            changeCount: 0,
            firstMs: pt.now, lastMs: pt.now,
            rectBefore: pt.p ? { w: Math.round(pt.p.w), h: Math.round(pt.p.h) } : null,
            rectAfter: null,
            resizedItself: false,
            displacedSiblings: false,
          };
          textReflows.set(pt.el, agg);
        }
        agg.changeCount++;
        agg.lastMs = pt.now;
        agg.textAfter = pt.after.replace(/\s+/g, ' ').trim().slice(0, 100);
        agg.rectAfter = { w: Math.round(pt.r.w), h: Math.round(pt.r.h) };
        if (ownResized) agg.resizedItself = true;
        if (sibMoved) agg.displacedSiblings = true;
      }
      samples++;
    };

    // A tracked, once-visible element vanished. If it lived only briefly, that
    // is a content flash — the "shows real content, then a 'not found'/empty
    // state replaces it" pattern. Collapse subtrees: if an ancestor is already
    // recorded as gone in this same sweep, the child rode along.
    function markGone(el, m, now, how) {
      m.gone = true;
      m.goneAt = now;
      const lifetime = now - m.firstSeenMs;
      if (!m.everVisible || lifetime > CONFIG.flashMaxMs) return;
      let anc = el.parentElement;
      while (anc) {
        const am = meta.get(anc);
        if (am && am.gone && Math.abs(am.goneAt - now) <= 1) return; // absorbed
        anc = anc.parentElement;
      }
      if (flashes.length >= 30) return;
      const r = m.maxRect || { x: 0, y: 0, w: 0, h: 0 };
      flashes.push({
        selector: cssPath(el),
        how,                        // 'removed' from DOM or 'hidden' (zero-size)
        appearedMs: m.firstSeenMs,
        disappearedMs: now,
        lifetimeMs: lifetime,
        maxRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) },
        textSnippet: snippet(el),   // works after removal: subtree is retained
      });
    }

    // MessageChannel loop: unlike setTimeout/rAF, it is NOT throttled in
    // hidden/occluded windows, which is precisely when we need it.
    const chan = new MessageChannel();
    let lastSample = 0;
    let done = false;
    chan.port1.onmessage = () => {
      if (done) return;
      const t = performance.now() - t0;
      if (t >= CONFIG.durationMs) {
        done = true;
        finish();
        return;
      }
      if (t - lastSample >= CONFIG.pollMs) { lastSample = t; try { snapshot(); } catch (_) {} }
      chan.port2.postMessage(0);
    };

    const finish = () => {
      const elements = [...findings.values()]
        .sort((a, b) => b.pseudoImpact - a.pseudoImpact)
        .map(a => ({ ...a, pseudoImpact: Math.round(a.pseudoImpact * 10000) / 10000 }));
      frame.remove();
      resolve({
        method: 'iframe rect-diff + lifecycle + text polling',
        path: CONFIG.path,
        viewport: { w: W, h: H },
        durationMs: CONFIG.durationMs,
        samples,
        networkDelayMs: CONFIG.networkDelayMs,
        parentVisibility: document.visibilityState,
        // Render assertion — ALWAYS check these before trusting the findings.
        // A low domNodeCount (e.g. < 900 for a real app) means the route did
        // not render: treat the run as INVALID, not as clean.
        domNodeCount,
        title: pageTitle,
        requestCount: requestLog.length,
        requests: requestLog.slice(0, 60),
        note: 'pseudoImpact approximates CLS impact (area × distance, viewport-normalised, displaced bucket only) but is not a Core Web Vitals score',
        elements,
        flashes,
        lateAppearances,
        textReflows: [...textReflows.values()],
      });
    };

    frame.addEventListener('error', () => { done = true; frame.remove(); reject(new Error('iframe failed to load ' + CONFIG.path)); });
    armNetwork();
    frame.src = CONFIG.path;
    chan.port2.postMessage(0);
  });
})();
