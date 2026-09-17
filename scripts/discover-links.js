// Route discovery — run via javascript_tool on the app's base URL.
// Collects unique same-origin paths from anchors so the user can pick which
// pages to audit. Returns at most 40 paths, shallowest first.
(() => {
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    try {
      const u = new URL(a.href, location.href);
      if (u.origin !== location.origin) continue;
      const path = u.pathname + u.search;
      if (path.match(/\.(png|jpg|svg|pdf|zip|css|js)$/i)) continue;
      seen.add(path);
    } catch (_) { /* ignore malformed hrefs */ }
  }
  return [...seen]
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, 40);
})();
