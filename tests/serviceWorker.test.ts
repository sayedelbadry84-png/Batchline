// BL-CR-P1-03, external-review validation (2026-09-10): the service
// worker's caching rules, exercised as real code.
//
// public/sw.js is plain JavaScript that registers listeners on `self`, so
// it can be run inside a node:vm context with a stubbed CacheStorage and
// fetch, and its handlers driven directly. No database and no browser —
// which matters, because the defect this covers (a shared plant tablet
// serving one user's rendered screen to the next) is not something the
// repo's PostgreSQL suites can reach at all.
//
// What is deliberately NOT claimed here: this is not a browser test. It
// proves the worker's own logic — what it precaches, what it stores, what
// it serves when the network fails, what it drops on sign-out. The
// end-to-end scenario (sign in as A, sign out, sign in as B, go offline)
// still needs a real browser and is listed as an open gap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "public", "sw.js"), "utf8");

type Listener = (event: Record<string, unknown>) => void;

// A CacheStorage stand-in that records every write, so a test can assert
// that a response was NOT stored — the whole point of the fix.
function fakeCaches() {
  const buckets = new Map<string, Map<string, unknown>>();
  const puts: string[] = [];
  const deletedBuckets: string[] = [];
  const api = {
    buckets,
    puts,
    deletedBuckets,
    async open(name: string) {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const bucket = buckets.get(name)!;
      return {
        async put(request: { url: string } | string, response: unknown) {
          const url = typeof request === "string" ? request : request.url;
          puts.push(url);
          bucket.set(url, response);
        },
        async addAll(urls: string[]) {
          for (const url of urls) bucket.set(new URL(url, "https://batchline.test").href, `precached:${url}`);
        },
        async keys() {
          return [...bucket.keys()].map((url) => ({ url }));
        },
        async delete(request: { url: string }) {
          return bucket.delete(request.url);
        },
      };
    },
    async keys() {
      return [...buckets.keys()];
    },
    async delete(name: string) {
      deletedBuckets.push(name);
      return buckets.delete(name);
    },
    async match(request: { url: string } | string) {
      const url = new URL(typeof request === "string" ? request : request.url, "https://batchline.test").href;
      for (const bucket of buckets.values()) if (bucket.has(url)) return bucket.get(url);
      return undefined;
    },
  };
  return api;
}

function loadWorker(networkFetch: (request: unknown) => Promise<unknown>) {
  const listeners = new Map<string, Listener>();
  const caches = fakeCaches();
  const self = {
    location: { origin: "https://batchline.test" },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [], openWindow: () => {} },
    registration: { showNotification: () => {} },
    caches,
    fetch: networkFetch,
    URL,
    Promise,
    console,
  };
  const context = vm.createContext({ ...self, self, caches, fetch: networkFetch });
  vm.runInContext(source, context);
  return { listeners, caches };
}

function navigationRequest(pathname: string) {
  return { method: "GET", mode: "navigate", url: `https://batchline.test${pathname}` };
}

// The worker calls response.clone() before storing — a real Response
// would; this is the smallest stand-in that behaves the same way.
function fakeResponse(body: string) {
  return { body, clone: () => ({ body: `${body}:clone` }) };
}

test("the precached shell contains no authenticated page", async () => {
  const { listeners, caches } = loadWorker(async () => fakeResponse("network"));
  const waits: Promise<unknown>[] = [];
  listeners.get("install")!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);

  const cached = [...caches.buckets.values()].flatMap((b) => [...b.keys()]);
  for (const authenticated of ["/operator", "/driver", "/pump-crew"]) {
    assert.ok(
      !cached.some((url) => new URL(url).pathname === authenticated),
      `${authenticated} is a per-user server-rendered page and must never be precached into a shared, identity-blind cache`,
    );
  }
  assert.ok(cached.some((url) => new URL(url).pathname === "/offline"), "the data-free offline shell is what must be precached instead");
});

test("a successful authenticated navigation is served from the network and never stored", async () => {
  const { listeners, caches } = loadWorker(async () => fakeResponse("operator-screen-for-user-a"));
  let served: unknown;
  listeners.get("fetch")!({
    request: navigationRequest("/operator"),
    respondWith: (r: unknown) => {
      served = r;
    },
  });
  const response = (await served) as { body: string };

  assert.equal(response.body, "operator-screen-for-user-a", "the live page is what the user gets while online");
  assert.deepEqual(caches.puts, [], "and not one byte of it may be written to CacheStorage — that cache is shared by every user of the device");
});

test("a failed navigation falls back to the data-free offline shell, not to someone's cached screen", async () => {
  const { listeners, caches } = loadWorker(async () => {
    throw new Error("offline");
  });
  const waits: Promise<unknown>[] = [];
  listeners.get("install")!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);

  let served: unknown;
  listeners.get("fetch")!({
    request: navigationRequest("/driver"),
    respondWith: (r: unknown) => {
      served = r;
    },
  });

  assert.equal(await served, "precached:/offline", "an offline driver gets the shell that holds no records at all");
  assert.deepEqual(caches.puts, [], "a failed navigation stores nothing either");
});

test("content-hashed build assets are still cached, since they are identical for every user", async () => {
  const { listeners, caches } = loadWorker(async () => fakeResponse("chunk"));
  let served: unknown;
  listeners.get("fetch")!({
    request: { method: "GET", mode: "no-cors", url: "https://batchline.test/_next/static/chunks/main-abc123.js" },
    respondWith: (r: unknown) => {
      served = r;
    },
  });
  await served;
  assert.deepEqual(caches.puts, ["https://batchline.test/_next/static/chunks/main-abc123.js"], "static assets are what make an offline load work at all");
});

test("activation evicts the previous cache generation, which is where authenticated HTML accumulated", async () => {
  const { listeners, caches } = loadWorker(async () => fakeResponse("network"));
  await (await caches.open("batchline-shell-v1")).put({ url: "https://batchline.test/operator" }, "user-a-screen");

  const waits: Promise<unknown>[] = [];
  listeners.get("activate")!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);

  assert.ok(caches.deletedBuckets.includes("batchline-shell-v1"), "every device that already has the old bucket must lose it on upgrade");
});

test("signing out drops runtime entries but keeps the public shell", async () => {
  const { listeners, caches } = loadWorker(async () => fakeResponse("network"));
  const waits: Promise<unknown>[] = [];
  listeners.get("install")!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);

  // Whatever a future change might start caching at runtime.
  const current = await caches.open("batchline-shell-v2");
  await current.put({ url: "https://batchline.test/some/runtime/entry" }, "runtime");
  await current.put({ url: "https://batchline.test/_next/static/chunks/main-abc123.js" }, "chunk");

  const signOutWaits: Promise<unknown>[] = [];
  listeners.get("message")!({
    data: { type: "BATCHLINE_SIGNED_OUT" },
    waitUntil: (p: Promise<unknown>) => signOutWaits.push(p),
  });
  await Promise.all(signOutWaits);

  const remaining = [...caches.buckets.get("batchline-shell-v2")!.keys()].map((url) => new URL(url).pathname);
  assert.ok(!remaining.includes("/some/runtime/entry"), "anything cached under a session must go when that session ends");
  assert.ok(remaining.includes("/offline"), "the public offline shell stays — it is what makes the next offline load work");
  assert.ok(remaining.includes("/_next/static/chunks/main-abc123.js"), "and so do the content-hashed assets, which belong to no user");
});
