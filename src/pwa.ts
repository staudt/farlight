/** Registers the service worker (offline play, installable). Production builds only. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  // Headless test runs (smoke) must see the network, not a cache.
  if (navigator.webdriver) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // Hand over what this visit already loaded so the next one works offline.
        const urls = [location.href, './favicon.svg', './manifest.webmanifest', './icon-192.png', ...performance.getEntriesByType('resource').map((e) => e.name)];
        reg.active?.postMessage({ type: 'precache', urls });
      })
      .catch(() => {
        /* offline support is optional */
      });
  });
}
