"use strict";

/* Shell local versionado. Los datos de negocio viven en IndexedDB,
   nunca en el cache del Service Worker. */

const CACHE_PREFIX = "sandwicheria-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v8`;
const LEGACY_CACHES = new Set(["sandwicheria-v3"]);
const SCOPE_URL = new URL("./", self.registration.scope).href;
const INDEX_URL = new URL("./index.html", self.registration.scope).href;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=6",
  "./app.js?v=6",
  "./manifest.json?v=6",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const requests = APP_SHELL.map((asset) => new Request(new URL(asset, self.registration.scope), {
      cache: "reload",
      credentials: "same-origin",
    }));
    await cache.addAll(requests);

    // La versión anterior no podía avisar que había una actualización.
    // Solo en esa migración activamos el nuevo worker automáticamente.
    const existingCaches = await caches.keys();
    if (existingCaches.some((name) => LEGACY_CACHES.has(name))) {
      await self.skipWaiting();
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) || LEGACY_CACHES.has(name))
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  event.respondWith(cacheFirstAsset(request));
});

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(INDEX_URL, response.clone());
    return response;
  } catch {
    return (
      (await cache.match(INDEX_URL)) ||
      (await cache.match(SCOPE_URL)) ||
      new Response("La aplicación no está disponible sin conexión.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return new Response("", { status: 504, statusText: "Offline" });
  }
}
