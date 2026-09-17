// OPTIONAL true-CLS supplement — use measure-shifts.js as the primary method.
//
// This reads the Layout Instability API (buffered layout-shift entries since
// navigation start). It yields a real Core Web Vitals CLS score, but ONLY
// works under two conditions, both of which commonly fail:
//   1. The Chrome window must be VISIBLE (not occluded/minimised) — Chrome
//      records layout-shift entries only when frames are composited. Check
//      `document.visibilityState === 'visible'` first; a hidden window
//      silently yields zero entries (a false "no shifts" result).
//   2. The observer must run in the page's MAIN world. The javascript_tool
//      executes in an isolated world that never receives layout-shift
//      entries — inject this file's contents via a <script> element whose
//      textContent stores the resolved report on a DOM attribute or
//      window.postMessage, then read it from the tool side.
// If either condition can't be met, skip this and rely on measure-shifts.js.
(() => {
  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return '(text/removed node)';
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
        const siblings = [...parent.children].filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };

  const r = (rect) => ({
    x: Math.round(rect.x), y: Math.round(rect.y),
    w: Math.round(rect.width), h: Math.round(rect.height),
  });

  return new Promise((resolve) => {
    const entries = [];
    let observer;
    try {
      observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
      observer.observe({ type: 'layout-shift', buffered: true });
    } catch (e) {
      resolve({ error: 'layout-shift API unavailable in this browser: ' + e.message });
      return;
    }

    // Buffered entries are delivered asynchronously; a short wait collects them.
    setTimeout(() => {
      entries.push(...observer.takeRecords());
      observer.disconnect();

      const byElement = new Map();
      let totalScore = 0;
      let inputExcludedScore = 0;

      for (const entry of entries) {
        if (entry.hadRecentInput) { inputExcludedScore += entry.value; continue; }
        totalScore += entry.value;
        for (const src of entry.sources || []) {
          const sel = cssPath(src.node);
          const prev = r(src.previousRect);
          const curr = r(src.currentRect);
          let agg = byElement.get(sel);
          if (!agg) {
            agg = {
              selector: sel,
              shiftCount: 0,
              totalShiftValue: 0,
              firstShiftMs: Math.round(entry.startTime),
              lastShiftMs: Math.round(entry.startTime),
              initialRect: prev,
              finalRect: curr,
              dimensionChanged: false,
              maxDelta: { w: 0, h: 0 },
            };
            byElement.set(sel, agg);
          }
          agg.shiftCount += 1;
          agg.totalShiftValue += entry.value;
          agg.lastShiftMs = Math.round(entry.startTime);
          agg.finalRect = curr;
          const dw = Math.abs(curr.w - prev.w);
          const dh = Math.abs(curr.h - prev.h);
          if (dw > 0 || dh > 0) agg.dimensionChanged = true;
          agg.maxDelta.w = Math.max(agg.maxDelta.w, dw);
          agg.maxDelta.h = Math.max(agg.maxDelta.h, dh);
        }
      }

      const elements = [...byElement.values()].sort(
        (a, b) => b.totalShiftValue - a.totalShiftValue
      );

      resolve({
        url: location.href,
        viewport: { w: innerWidth, h: innerHeight },
        cumulativeLayoutShift: Math.round(totalScore * 10000) / 10000,
        inputExcludedShift: Math.round(inputExcludedScore * 10000) / 10000,
        shiftEventCount: entries.length,
        msSinceNavigation: Math.round(performance.now()),
        elements,
      });
    }, 300);
  });
})();
