/* Register the shell cache on any page that wants it.
 *
 * A service worker is unavailable outside a secure context (HTTPS or
 * localhost), and registering blindly would throw on a LAN address. Failure is
 * silent and harmless: every page works without the cache, because the cache
 * is a convenience, never a source of truth.
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {
      /* The app is fully usable without the cache. */
    });
  });
})();
