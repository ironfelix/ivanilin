/* Офлайн-оболочка. Стратегия network-first: онлайн всегда свежая версия,
   офлайн — последняя удачно загруженная. Данные лежат в localStorage
   и через кэш не проходят. */

const CACHE = 'pult-shell-v3';
const SHELL = ['./', './index.html', './assets/app.css', './assets/app.js', './assets/store.js', './assets/parse.js', './assets/markdown.js', './manifest.webmanifest'];
// кэшируем только файлы оболочки: iframe пайплайна, мост Майка и прочее
// не должны оседать в кэше и раздувать его
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.location).pathname));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!SHELL_PATHS.has(url.pathname) && req.mode !== 'navigate') return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (SHELL_PATHS.has(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      // офлайн: свой файл — из кэша; переход по адресу — оболочка;
      // подменять недостающий ассет на index.html нельзя (это не JS)
      .catch(async () =>
        (await caches.match(req)) ||
        (req.mode === 'navigate' ? caches.match('./index.html') : Promise.reject(new Error('offline'))))
  );
});
