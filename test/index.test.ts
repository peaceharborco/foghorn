import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

type FetchCall = { url: string; init?: RequestInit };

interface FakeKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  writes: number;
}

function fakeKV(): FakeKV {
  const store = new Map<string, string>();
  const kv = {
    writes: 0,
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      kv.writes++;
      store.set(key, value);
    },
  };
  return kv;
}

/**
 * Stubs global fetch. `down` is a set of check URLs that should fail;
 * everything else (Twilio, webhooks, healthy checks) returns 200.
 * `failure` is how a down URL fails: an HTTP status, or "throw" for the
 * no-response case (DNS failure, connection refused, timeout).
 */
function stubFetch(
  down: Set<string> = new Set(),
  failure: number | "throw" = 500,
  healthyBody = "ok",
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const d of down) {
      if (!u.startsWith(d)) continue;
      if (failure === "throw") throw new TypeError("fetch failed");
      return new Response("err", { status: failure });
    }
    return new Response(healthyBody, { status: 200 });
  });
  return calls;
}

/**
 * Stubs fetch so the first `n` probes of `url` fail and every later one
 * succeeds — the shape of the blip that produced the false page. Everything
 * else (Twilio, webhooks, pings) returns 200.
 */
function stubFlakyProbe(
  url: string,
  n: number,
  failure: number | "throw" = "throw",
): FetchCall[] {
  const calls: FetchCall[] = [];
  let failed = 0;
  vi.stubGlobal("fetch", async (u: string | URL, init?: RequestInit) => {
    const s = String(u);
    calls.push({ url: s, init });
    if (s.startsWith(url) && failed < n) {
      failed++;
      if (failure === "throw") throw new TypeError("fetch failed");
      return new Response("err", { status: failure });
    }
    return new Response("ok", { status: 200 });
  });
  return calls;
}

/** A 200 whose body starts arriving and then dies mid-stream. */
function brokenStream(): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("partial"));
        c.error(new Error("stream died"));
      },
    }),
    { status: 200 },
  );
}

/**
 * Stubs fetch so the first probe of `url` answers 200 with a body that dies
 * mid-stream, and every later one answers 200 with `body`.
 */
function stubBrokenThenWhole(url: string, body: string): FetchCall[] {
  const calls: FetchCall[] = [];
  let first = true;
  vi.stubGlobal("fetch", async (u: string | URL, init?: RequestInit) => {
    const s = String(u);
    calls.push({ url: s, init });
    if (s.startsWith(url) && first) {
      first = false;
      return brokenStream();
    }
    return new Response(body, { status: 200 });
  });
  return calls;
}

/** Probe requests only — Twilio, webhook and dead-man pings filtered out. */
const probeCalls = (calls: FetchCall[], url = "https://a.example") =>
  calls.filter((c) => c.url.startsWith(url));

function env(kv: FakeKV, overrides: Record<string, unknown> = {}) {
  return {
    STATE: kv,
    CHECK_URLS: "https://a.example",
    FAIL_THRESHOLD: "2",
    TWILIO_FROM: "+15555550100",
    TWILIO_TO: "+15555550101",
    TWILIO_ACCOUNT_SID: "AC_test",
    TWILIO_AUTH_TOKEN: "tok_test",
    ...overrides,
  } as never;
}

async function run(e: never) {
  await worker.scheduled({} as never, e, {} as never);
}

const smsCalls = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.includes("api.twilio.com"));
/** The Body field alone — not the whole form, so lengths are measurable. */
const smsBody = (c: FetchCall) =>
  new URLSearchParams(String(c.init?.body ?? "")).get("Body") ?? "";

/**
 * Collapses the retry backoff. Production waits RETRY_BACKOFF_MS between the
 * two probe attempts; on real timers that would add seconds to every
 * transport-failure test in this file and buy no coverage.
 */
const backoffDelays: number[] = [];
beforeEach(() => {
  backoffDelays.length = 0;
  vi.stubGlobal("setTimeout", (fn: () => void, ms?: number) => {
    backoffDelays.push(ms ?? 0);
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DAY_MS = 86_400_000;
/** Pins Date.now() — the synthetic send's interval is measured against it. */
const atTime = (ms: number) => vi.spyOn(Date, "now").mockReturnValue(ms);

/** Drives a URL to the DOWN threshold and returns the one alert body sent. */
async function downAlertBody(
  failure: number | "throw",
  url = "https://a.example",
): Promise<string> {
  const kv = fakeKV();
  const calls = stubFetch(new Set([url]), failure);
  const e = env(kv, { CHECK_URLS: url });
  await run(e);
  await run(e);
  const sms = smsCalls(calls);
  expect(sms).toHaveLength(1);
  return smsBody(sms[0]);
}

/**
 * Drives a URL whose body ALWAYS truncates to the DOWN threshold and returns
 * the one alert body. The single-alert assertion inside is itself the
 * fail-closed guard: an unprovable page must never be rescued into an UP.
 */
async function truncatedAlertBody(
  overrides: Record<string, unknown>,
  url = "https://a.example",
): Promise<string> {
  const kv = fakeKV();
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (u: string | URL, init?: RequestInit) => {
    const s = String(u);
    calls.push({ url: s, init });
    return s.startsWith(url) ? brokenStream() : new Response("ok", { status: 200 });
  });
  const e = env(kv, { CHECK_URLS: url, ...overrides });
  await run(e);
  await run(e);
  const sms = smsCalls(calls);
  expect(sms).toHaveLength(1);
  return smsBody(sms[0]);
}

/** Drives a URL down and back up, returning the recovery alert body. */
async function upAlertBody(url = "https://a.example"): Promise<string> {
  const kv = fakeKV();
  stubFetch(new Set([url]));
  const e = env(kv, { CHECK_URLS: url });
  await run(e);
  await run(e);
  const calls = stubFetch();
  await run(e);
  const sms = smsCalls(calls);
  expect(sms).toHaveLength(1);
  return smsBody(sms[0]);
}

describe("single URL, Twilio notifier", () => {
  it("does zero KV writes and sends nothing while healthy", async () => {
    const kv = fakeKV();
    const calls = stubFetch();
    await run(env(kv));
    await run(env(kv));
    expect(kv.writes).toBe(0);
    expect(smsCalls(calls)).toHaveLength(0);
  });

  it("does not alert below the failure threshold", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]));
    await run(env(kv));
    expect(smsCalls(calls)).toHaveLength(0);
  });

  it("sends exactly one DOWN SMS once the threshold is reached", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]));
    await run(env(kv));
    await run(env(kv));
    const sms = smsCalls(calls);
    expect(sms).toHaveLength(1);
    expect(smsBody(sms[0])).toContain("DOWN");
    expect(smsBody(sms[0])).toContain("a.example");
  });

  it("stays silent and write-free while still down after alerting", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]));
    await run(env(kv));
    await run(env(kv));
    const writesAfterAlert = kv.writes;
    const smsAfterAlert = smsCalls(calls).length;
    await run(env(kv));
    await run(env(kv));
    expect(kv.writes).toBe(writesAfterAlert);
    expect(smsCalls(calls)).toHaveLength(smsAfterAlert);
  });

  it("sends exactly one UP SMS on recovery", async () => {
    const kv = fakeKV();
    const downCalls = stubFetch(new Set(["https://a.example"]));
    await run(env(kv));
    await run(env(kv));
    expect(smsCalls(downCalls)).toHaveLength(1);
    const upCalls = stubFetch();
    await run(env(kv));
    const sms = smsCalls(upCalls);
    expect(sms).toHaveLength(1);
    expect(smsBody(sms[0])).toContain("UP");
    // and back to steady-state: no further writes or texts
    await run(env(kv));
    expect(smsCalls(upCalls)).toHaveLength(1);
  });

  it("resets a partial failure streak without alerting", async () => {
    const kv = fakeKV();
    stubFetch(new Set(["https://a.example"]));
    await run(env(kv));
    const recovered = stubFetch();
    await run(env(kv));
    expect(smsCalls(recovered)).toHaveLength(0);
    // streak must be truly reset: two more fails needed for an alert
    const downAgain = stubFetch(new Set(["https://a.example"]));
    await run(env(kv));
    expect(smsCalls(downAgain)).toHaveLength(0);
    await run(env(kv));
    expect(smsCalls(downAgain)).toHaveLength(1);
  });

  it("defaults FAIL_THRESHOLD to 2 when unset", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]));
    const e = env(kv, { FAIL_THRESHOLD: undefined });
    await run(e);
    expect(smsCalls(calls)).toHaveLength(0);
    await run(e);
    expect(smsCalls(calls)).toHaveLength(1);
  });

  it("supports legacy CHECK_URL when CHECK_URLS is unset", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://legacy.example"]));
    const e = env(kv, { CHECK_URLS: undefined, CHECK_URL: "https://legacy.example" });
    await run(e);
    await run(e);
    const sms = smsCalls(calls);
    expect(sms).toHaveLength(1);
    expect(smsBody(sms[0])).toContain("legacy.example");
  });
});

describe("multiple URLs", () => {
  const multi = { CHECK_URLS: "https://a.example, https://b.example" };

  it("checks every URL each run", async () => {
    const kv = fakeKV();
    const calls = stubFetch();
    await run(env(kv, multi));
    expect(calls.some((c) => c.url.startsWith("https://a.example"))).toBe(true);
    expect(calls.some((c) => c.url.startsWith("https://b.example"))).toBe(true);
  });

  it("tracks independent streaks and alerts only for the down URL", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]));
    await run(env(kv, multi));
    await run(env(kv, multi));
    const sms = smsCalls(calls);
    expect(sms).toHaveLength(1);
    expect(smsBody(sms[0])).toContain("a.example");
    expect(smsBody(sms[0])).not.toContain("b.example");
  });

  it("recovers each URL independently", async () => {
    const kv = fakeKV();
    stubFetch(new Set(["https://a.example", "https://b.example"]));
    await run(env(kv, multi));
    await run(env(kv, multi));
    // only a recovers
    const calls = stubFetch(new Set(["https://b.example"]));
    await run(env(kv, multi));
    const sms = smsCalls(calls);
    expect(sms).toHaveLength(1);
    expect(smsBody(sms[0])).toContain("a.example");
    expect(smsBody(sms[0])).toContain("UP");
  });
});

describe("probe identity", () => {
  it("sends a User-Agent identifying foghorn and where to complain", async () => {
    const kv = fakeKV();
    const calls = stubFetch();
    await run(env(kv));
    const probe = calls.find((c) => c.url.startsWith("https://a.example"));
    expect(probe).toBeDefined();
    const ua = new Headers(probe!.init?.headers).get("user-agent");
    expect(ua).toMatch(/^Foghorn\/\d+\.\d+ \(\+https:\/\/\S+\)$/);
  });
});

describe("cache busting", () => {
  it("keeps the buster where fetch will send it, even with a fragment", async () => {
    // Appending to a URL carrying a "#" put `_cb` inside the fragment, which
    // fetch strips before sending — so the probe could be answered from cache,
    // which is the one thing the buster exists to prevent.
    const kv = fakeKV();
    const calls = stubFetch();
    await run(env(kv, { CHECK_URLS: "https://a.example/#/app" }));
    const probe = calls[0].url;
    expect(probe).toMatch(/[?&]_cb=\d+/);
    expect(probe.indexOf("_cb")).toBeLessThan(probe.indexOf("#"));
  });
});

describe("probing the origin, not the edge", () => {
  const probeInit = async () => {
    const kv = fakeKV();
    const calls = stubFetch();
    await run(env(kv));
    return calls[0].init;
  };

  it("bypasses Cloudflare's cache", async () => {
    // A Worker subrequest reads through a Cloudflare cache even for a
    // DNS-only hostname, because the name still belongs to a Cloudflare zone.
    // The `_cb` buster makes a HIT unlikely; this makes it impossible.
    expect((await probeInit())?.cache).toBe("no-store");
  });

  it("does not follow redirects", async () => {
    // `follow` is the default, and this zone's apex 301s at the edge to a
    // proxied property that already serves cf-cache-status: REVALIDATED.
    // Following it would turn "cds1 answered a redirect" into "some other
    // host's cached page said 200" — a healthy reading of a dead box.
    expect((await probeInit())?.redirect).toBe("manual");
  });

  // Not following is not the same as failing: a 3xx means the origin answered,
  // which is the whole question foghorn asks. This is also the QUIETER half of
  // the trade — `follow` used to score the redirect target, so a 3xx pointing
  // at a corpse would have paged and now does not. Deliberate, documented in
  // spec §6, and a no-op on the deployed URL, which answers 200.
  it.each([301, 302, 303, 307, 308])("counts a %i from the origin as up", async (status) => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]), status);
    await run(env(kv));
    await run(env(kv));
    expect(smsCalls(calls)).toHaveLength(0);
    expect(kv.writes).toBe(0);
  });

  it("still pages when the first hop itself fails", async () => {
    // The guard on the trade: `manual` must not make a genuinely unreachable
    // origin quieter. Only the redirect-target check was given up.
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]), "throw");
    await run(env(kv));
    await run(env(kv));
    expect(smsCalls(calls)).toHaveLength(1);
    expect(smsBody(smsCalls(calls)[0])).toContain("unreachable");
  });
});

describe("transient probe failures", () => {
  // The false page of 2026-08-17: two probes failed in transit on consecutive
  // minutes and FAIL_THRESHOLD=2 read that as confirmed downtime. A probe now
  // gets one retry, so a single blip never reaches the streak at all.
  it("retries a probe that failed in transit rather than counting it", async () => {
    const kv = fakeKV();
    const calls = stubFlakyProbe("https://a.example", 1);
    await run(env(kv));
    expect(probeCalls(calls)).toHaveLength(2);
    expect(smsCalls(calls)).toHaveLength(0);
    expect(kv.writes).toBe(0);
  });

  // Re-measuring this fix otherwise means reading the watched host's own
  // access log, which foghorn usually cannot. One line per rescue makes the
  // blip rate countable from Workers observability alone.
  it("logs a rescued probe so blips stay countable without the origin log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = fakeKV();
    stubFlakyProbe("https://a.example", 1);
    await run(env(kv));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("a.example");
  });

  it("stays quiet on a healthy probe", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = fakeKV();
    stubFetch();
    await run(env(kv));
    expect(warn).not.toHaveBeenCalled();
  });

  // The delay is collapsed above so the suite stays fast, but the value the
  // production code ASKS for is still pinned here — otherwise raising the
  // backoff would leave every test green while the run quietly outgrew its
  // cron minute. It does NOT pin the number of attempts: this fixture succeeds
  // on the retry, so a further attempt would never run. The probe counts in
  // the tests below are what hold that.
  it("waits a full second before retrying", async () => {
    const kv = fakeKV();
    stubFlakyProbe("https://a.example", 1);
    await run(env(kv));
    expect(backoffDelays).toEqual([1000]);
  });

  it("costs one request on a healthy run", async () => {
    const kv = fakeKV();
    const calls = stubFetch();
    await run(env(kv));
    expect(probeCalls(calls)).toHaveLength(1);
  });

  it("gives the retry its own cache-buster", async () => {
    const kv = fakeKV();
    let t = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (t += 1000));
    const calls = stubFlakyProbe("https://a.example", 1);
    await run(env(kv));
    const busters = probeCalls(calls).map((c) => new URL(c.url).searchParams.get("_cb"));
    expect(busters).toHaveLength(2);
    expect(busters[0]).not.toBeNull();
    expect(busters[1]).not.toBe(busters[0]);
  });

  // The doc's first constraint: the pair must resolve to ONE outcome. Two
  // increments would put a single blip halfway to a page on its own.
  it("counts a failed pair as one failure and one KV write", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]), "throw");
    await run(env(kv));
    expect(probeCalls(calls)).toHaveLength(2);
    expect(kv.writes).toBe(1);
    expect(JSON.parse((await kv.get("state:https://a.example"))!).fails).toBe(1);
    expect(smsCalls(calls)).toHaveLength(0);
  });

  // The false page itself: one failed probe on each of two consecutive
  // minutes used to be a confirmed outage at FAIL_THRESHOLD=2.
  it("no longer pages for a single blip on consecutive runs", async () => {
    const kv = fakeKV();
    const e = env(kv);
    const first = stubFlakyProbe("https://a.example", 1);
    await run(e);
    const second = stubFlakyProbe("https://a.example", 1);
    await run(e);
    expect(smsCalls(first)).toHaveLength(0);
    expect(smsCalls(second)).toHaveLength(0);
    expect(kv.writes).toBe(0);
  });

  // ...and the guard on it: raising the bar must not mute a real outage.
  it("still pages when every attempt fails on consecutive runs", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]), "throw");
    const e = env(kv);
    await run(e);
    await run(e);
    expect(smsCalls(calls)).toHaveLength(1);
    expect(probeCalls(calls)).toHaveLength(4);
  });

  // A status is the origin telling you something real. Retrying it only
  // delays a true page.
  it.each([403, 500, 503])("does not retry a definitive HTTP %i", async (status) => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]), status);
    await run(env(kv));
    expect(probeCalls(calls)).toHaveLength(1);
  });

  it("does not retry a page that answered with the wrong content", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(), 500, "maintenance mode");
    await run(env(kv, { FORBID_TEXT: "maintenance" }));
    expect(probeCalls(calls)).toHaveLength(1);
  });

  // Ordering, not wall clock: this proves the ping is still reached after a
  // retried pair, which is the constraint a retry could break by construction.
  // It does NOT measure the 36s budget — the backoff is collapsed here and the
  // stubbed fetch ignores AbortSignal, so the budget stays arithmetic.
  it("still reaches the heartbeat on a run where both attempts failed", async () => {
    const HB = "https://hc.example/beat";
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]), "throw");
    await run(env(kv, { HEARTBEAT_URL: HB }));
    expect(probeCalls(calls)).toHaveLength(2);
    expect(calls.filter((c) => c.url.startsWith(HB))).toHaveLength(1);
  });

  // A body that dies mid-stream is the transport failing, not the origin
  // answering — it reaches the caller wearing a content label only because
  // that is where the scan noticed. The other two content verdicts are the
  // page genuinely being wrong, and those are not retried.
  it("retries a page whose body died mid-scan under FORBID_TEXT", async () => {
    const kv = fakeKV();
    const calls = stubBrokenThenWhole("https://a.example", "ok");
    await run(env(kv, { FORBID_TEXT: "maintenance" }));
    expect(probeCalls(calls)).toHaveLength(2);
    expect(smsCalls(calls)).toHaveLength(0);
    expect(kv.writes).toBe(0);
  });

  // The same physical event as the test above — a 200 whose body stops
  // arriving — and it must be classified the same way. It was not: the
  // missing-expected-text verdict is reached first, which called a broken
  // stream a definitive wrong page and skipped the retry.
  it("retries a page whose body died mid-scan under EXPECT_TEXT", async () => {
    const kv = fakeKV();
    const calls = stubBrokenThenWhole("https://a.example", "welcome home");
    await run(env(kv, { EXPECT_TEXT: "welcome" }));
    expect(probeCalls(calls)).toHaveLength(2);
    expect(smsCalls(calls)).toHaveLength(0);
    expect(kv.writes).toBe(0);
  });

  // ...but a page that arrived in full and genuinely lacks the text is the
  // origin answering, and must NOT be retried.
  it("does not retry a whole page that is missing the expected text", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(), 500, "nothing useful here");
    await run(env(kv, { EXPECT_TEXT: "welcome" }));
    expect(probeCalls(calls)).toHaveLength(1);
  });

  // Fail-closed, both sides: if every attempt truncates, the retry must not
  // launder an unprovable page into an UP. Two runs, four probes, one page.
  it.each([
    ["EXPECT_TEXT", { EXPECT_TEXT: "welcome" }],
    ["FORBID_TEXT", { FORBID_TEXT: "maintenance" }],
  ])("still pages when the body truncates on every attempt under %s", async (_n, cfg) => {
    const kv = fakeKV();
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", async (u: string | URL, init?: RequestInit) => {
      const s = String(u);
      calls.push({ url: s, init });
      return s.startsWith("https://a.example")
        ? brokenStream()
        : new Response("ok", { status: 200 });
    });
    const e = env(kv, cfg);
    await run(e);
    await run(e);
    expect(probeCalls(calls)).toHaveLength(4);
    expect(smsCalls(calls)).toHaveLength(1);
  });
});

describe("DOWN alert wording", () => {
  // Regression guard, not new behaviour: rev 1 of the hardening design wanted
  // 4xx to read as UP and that was rejected — a WAF 403 to everyone is an
  // outage. Only the wording changes.
  it("still pages DOWN for a 4xx", async () => {
    expect(await downAlertBody(403)).toContain("DOWN");
  });

  it("says the origin answered, not that it was unreachable, on a 4xx", async () => {
    const body = await downAlertBody(403);
    expect(body).toContain("403");
    expect(body).not.toContain("unreachable");
  });

  it("names the status on a 5xx", async () => {
    expect(await downAlertBody(503)).toContain("503");
  });

  it("says unreachable when the probe gets no response at all", async () => {
    expect(await downAlertBody("throw")).toContain("unreachable");
  });

  // A body that stopped arriving is the connection failing, not the page being
  // wrong. Sending an operator to inspect the content at 3am when the content
  // was never delivered points them at the wrong system.
  it("says the body did not finish arriving, not that the content is wrong", async () => {
    const body = await truncatedAlertBody({ EXPECT_TEXT: "welcome" });
    expect(body).toContain("did not finish arriving");
    expect(body).not.toContain("content is wrong");
  });
});

describe("SMS encoding", () => {
  // One character outside GSM-7 flips the whole message to UCS-2, cutting the
  // segment from 160 characters to 70. An em dash alone split the 403 alert
  // into three segments, and multi-segment SMS can arrive out of order or be
  // truncated in transit — poor properties for a dead-man alarm.
  const GSM7 =
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const outsideGsm7 = (body: string) => [...body].filter((c) => !GSM7.includes(c));

  // The deployed CHECK_URL: the alert has to fit with the real hostname in it,
  // which is 18 characters longer than the a.example used elsewhere.
  const prod = "https://cds1.peaceharborhosting.com";

  async function syntheticBody(): Promise<string> {
    atTime(1_700_000_000_000);
    const kv = fakeKV();
    const calls = stubFetch();
    await run(env(kv, { CHECK_URLS: prod, SYNTHETIC_TEST_DAYS: "30" }));
    const sms = smsCalls(calls);
    expect(sms).toHaveLength(1);
    return smsBody(sms[0]);
  }

  it("fits every alert in a single GSM-7 segment", async () => {
    const bodies = [
      await downAlertBody("throw", prod),
      await downAlertBody(403, prod),
      await downAlertBody(503, prod),
      await upAlertBody(prod),
      await syntheticBody(),
      await truncatedAlertBody({ EXPECT_TEXT: "welcome" }, prod),
      await truncatedAlertBody({ FORBID_TEXT: "maintenance" }, prod),
    ];
    for (const body of bodies) {
      expect(outsideGsm7(body)).toEqual([]);
      expect(body.length).toBeLessThanOrEqual(160);
    }
  });

  it("still fits when the hostname is long", async () => {
    // `origin.cds1.peaceharborhosting.com` is the grey-cloud name step 6 of the
    // spec plans to add; the pre-clamp wording put a 40-char host at 170.
    const long = "https://origin.cds1.peaceharborhosting.com";
    const longer = "https://a-very-long-customer-subdomain.example.co.uk";
    for (const url of [long, longer]) {
      // Both the longest wording (the truncated-body arm) and the 403, since
      // `smsHost` clamps to 43 characters and the arms differ in length.
      const bodies = [
        await downAlertBody(403, url),
        await truncatedAlertBody({ EXPECT_TEXT: "welcome" }, url),
      ];
      for (const body of bodies) {
        expect(outsideGsm7(body)).toEqual([]);
        expect(body.length).toBeLessThanOrEqual(160);
      }
    }
  });
});

describe("synthetic delivery test", () => {
  const T0 = 1_700_000_000_000;
  const enabled = { SYNTHETIC_TEST_DAYS: "30" };
  const synthetic = (calls: FetchCall[]) =>
    smsCalls(calls).filter((c) => /delivery test/i.test(smsBody(c)));

  it("stays off unless SYNTHETIC_TEST_DAYS is set", async () => {
    atTime(T0);
    const kv = fakeKV();
    const calls = stubFetch();
    await run(env(kv));
    expect(smsCalls(calls)).toHaveLength(0);
    expect(kv.writes).toBe(0);
  });

  it("sends once on the first run after being enabled", async () => {
    // Immediate proof the delivery path works, rather than a 30-day wait.
    atTime(T0);
    const kv = fakeKV();
    const calls = stubFetch();
    await run(env(kv, enabled));
    expect(synthetic(calls)).toHaveLength(1);
  });

  it("says plainly that it is not an outage", async () => {
    atTime(T0);
    const kv = fakeKV();
    const calls = stubFetch();
    await run(env(kv, enabled));
    const body = smsBody(synthetic(calls)[0]);
    expect(body).toMatch(/not an outage/i);
    expect(body).not.toContain("DOWN");
  });

  it("stays quiet until the interval elapses", async () => {
    const kv = fakeKV();
    const calls = stubFetch();
    atTime(T0);
    await run(env(kv, enabled));
    atTime(T0 + 29 * DAY_MS);
    await run(env(kv, enabled));
    expect(synthetic(calls)).toHaveLength(1);
  });

  it("sends again once the interval elapses", async () => {
    const kv = fakeKV();
    const calls = stubFetch();
    atTime(T0);
    await run(env(kv, enabled));
    atTime(T0 + 30 * DAY_MS);
    await run(env(kv, enabled));
    expect(synthetic(calls)).toHaveLength(2);
  });

  it("costs two KV writes per interval, not one per run", async () => {
    // Two: the attempt stamp before sending, then the success stamp after.
    // That ordering is what stops a text a minute when writes are failing.
    // Two per 30 days is ~24 a year against a 1,000/day cap; a write per run
    // would be 1,440/day and would take the whole state machine down with it.
    const kv = fakeKV();
    stubFetch();
    atTime(T0);
    await run(env(kv, enabled));
    expect(kv.writes).toBe(2);
    atTime(T0 + 60_000);
    await run(env(kv, enabled));
    await run(env(kv, enabled));
    expect(kv.writes).toBe(2);
  });

  it("does not retry every minute when the test send fails", async () => {
    // Delivery is broken, which is the finding. Retrying it 1,440 times a day
    // proves nothing new and burns invocations.
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://api.twilio.com"]));
    atTime(T0);
    await expect(run(env(kv, enabled))).resolves.toBeUndefined();
    atTime(T0 + 60_000);
    await run(env(kv, enabled));
    expect(synthetic(calls)).toHaveLength(1);
  });

  it("does not stop the origin check from alerting", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]));
    atTime(T0);
    await run(env(kv, enabled));
    await run(env(kv, enabled));
    expect(smsCalls(calls).filter((c) => smsBody(c).includes("DOWN"))).toHaveLength(1);
  });
});

describe("heartbeat", () => {
  const HB = "https://hc.example/ping/abc123";
  const pings = (calls: FetchCall[]) => calls.filter((c) => c.url.startsWith(HB));
  const hbEnv = (kv: FakeKV, overrides: Record<string, unknown> = {}) =>
    env(kv, { HEARTBEAT_URL: HB, ...overrides });

  it("pings after a healthy run", async () => {
    const kv = fakeKV();
    const calls = stubFetch();
    await run(hbEnv(kv));
    expect(pings(calls)).toHaveLength(1);
  });

  it("pings on a DOWN run too", async () => {
    // Gating the ping on the origin being up would make a real outage stop the
    // heartbeat, so the dead-man service pages "foghorn is dead" while foghorn
    // is correctly firing DOWN. Two alarms, one of them lying.
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]));
    await run(hbEnv(kv));
    await run(hbEnv(kv));
    expect(smsCalls(calls)).toHaveLength(1);
    expect(pings(calls)).toHaveLength(2);
  });

  it("still pings when every notifier failed", async () => {
    // Delivery is a separate concern from whether foghorn ran; the synthetic
    // send is what proves the delivery path.
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example", "https://api.twilio.com"]));
    await run(hbEnv(kv)).catch(() => {});
    await run(hbEnv(kv)).catch(() => {});
    expect(pings(calls)).toHaveLength(2);
  });

  it("does not ping when no URL is configured", async () => {
    // Otherwise foghorn heartbeats healthily while watching nothing.
    const kv = fakeKV();
    const calls = stubFetch();
    await run(hbEnv(kv, { CHECK_URLS: undefined, CHECK_URL: undefined }));
    expect(pings(calls)).toHaveLength(0);
  });

  it("does not ping when the state store is broken", async () => {
    // A dead KV binding means foghorn cannot track state at all. Its silence
    // should page someone rather than read as health.
    const broken = {
      writes: 0,
      async get() {
        throw new TypeError("STATE binding missing");
      },
      async put() {
        throw new TypeError("STATE binding missing");
      },
    } as unknown as FakeKV;
    const calls = stubFetch();
    await run(hbEnv(broken)).catch(() => {});
    expect(pings(calls)).toHaveLength(0);
  });

  it("does not ping when HEARTBEAT_URL is unset", async () => {
    const kv = fakeKV();
    const calls = stubFetch();
    await run(env(kv));
    // Assert on everything that left the building, not just the absence of a
    // URL that was never configured — the latter passes with no heartbeat at all.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("a.example");
  });

  it("swallows a failing ping instead of breaking the run", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set([HB]));
    await expect(run(hbEnv(kv))).resolves.toBeUndefined();
    expect(pings(calls)).toHaveLength(1);
  });

  it("does not mask a real failure behind a failing ping", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set([HB, "https://a.example", "https://api.twilio.com"]));
    await expect(run(hbEnv(kv))).resolves.toBeUndefined(); // below threshold
    await expect(run(hbEnv(kv))).rejects.toThrow(/notifier/);
    // and the ping really was attempted — otherwise this passes with no
    // heartbeat at all, on the old plain-Error throw.
    expect(pings(calls).length).toBeGreaterThan(0);
  });

  it("identifies itself on the ping", async () => {
    const kv = fakeKV();
    const calls = stubFetch();
    await run(hbEnv(kv));
    const ua = new Headers(pings(calls)[0].init?.headers).get("user-agent");
    expect(ua).toMatch(/^Foghorn\//);
  });
});

describe("delivery-path failure is not silent", () => {
  const T0 = 1_700_000_000_000;
  const HB = "https://hc.example/ping/abc123";
  const HOUR = 3_600_000;
  const pings = (calls: FetchCall[]) => calls.filter((c) => c.url.startsWith(HB));
  const synthetic = (calls: FetchCall[]) =>
    smsCalls(calls).filter((c) => /delivery test/i.test(smsBody(c)));
  const live = { HEARTBEAT_URL: HB, SYNTHETIC_TEST_DAYS: "30" };

  it("does not burn the whole interval on one failed send", async () => {
    // Stamping before sending meant a transient Twilio blip blinded the
    // delivery test for 30 days while the heartbeat kept reporting healthy.
    const kv = fakeKV();
    atTime(T0);
    stubFetch(new Set(["https://api.twilio.com"]));
    await run(env(kv, live));
    const recovered = stubFetch();
    atTime(T0 + HOUR);
    await run(env(kv, live));
    expect(synthetic(recovered)).toHaveLength(1);
  });

  it("does not retry the failed send every minute", async () => {
    const kv = fakeKV();
    atTime(T0);
    const calls = stubFetch(new Set(["https://api.twilio.com"]));
    await run(env(kv, live));
    atTime(T0 + 60_000);
    await run(env(kv, live));
    atTime(T0 + 120_000);
    await run(env(kv, live));
    expect(synthetic(calls)).toHaveLength(1);
  });

  it("keeps pinging through an outage even after a delivery test failed", async () => {
    // A failed delivery test must NOT withhold the heartbeat. Coupling them
    // deadlocks: the test is skipped while a URL is down, so nothing can clear
    // the broken flag, and the dead-man service pages "foghorn is dead" for the
    // whole outage while foghorn is correctly firing DOWN.
    const kv = fakeKV();
    atTime(T0);
    stubFetch(new Set(["https://api.twilio.com"]));
    await run(env(kv, live)); // delivery test fails, marking delivery broken
    const outage = stubFetch(new Set(["https://a.example"]));
    atTime(T0 + 60_000);
    await run(env(kv, live));
    atTime(T0 + 120_000);
    await run(env(kv, live));
    expect(smsCalls(outage).some((c) => smsBody(c).includes("DOWN"))).toBe(true);
    expect(pings(outage)).toHaveLength(2);
  });

  it("does not text at all when it cannot record the attempt", async () => {
    // If the stamp cannot be written, sending would repeat every single minute
    // for as long as KV is unwell. Better to send nothing than to spam.
    const kv = fakeKV();
    const noWrites = {
      writes: 0,
      get: (k: string) => kv.get(k),
      put: async () => {
        throw new TypeError("KV write quota exceeded");
      },
    } as unknown as FakeKV;
    atTime(T0);
    const calls = stubFetch();
    await run(env(noWrites, live)).catch(() => {});
    expect(synthetic(calls)).toHaveLength(0);
  });

  it("does not text once per minute for as long as KV write fails", async () => {
    // The measured failure was five texts in five runs: nothing could record
    // the attempt, so every run looked due. Exhausting the KV write quota is
    // exactly when this fires, and it is not a rare state to be in.
    const kv = fakeKV();
    const noWrites = {
      writes: 0,
      get: (k: string) => kv.get(k),
      put: async () => {
        throw new TypeError("KV write quota exceeded");
      },
    } as unknown as FakeKV;
    const calls = stubFetch();
    for (let i = 0; i < 5; i++) {
      atTime(T0 + i * 60_000);
      await run(env(noWrites, live)).catch(() => {});
    }
    expect(synthetic(calls)).toHaveLength(0);
  });

  it("writes each KV key at most once per run", async () => {
    // Workers KV rate-limits to 1 write per key per second and throws 429
    // beyond it. Two writes to one key inside a single invocation is over the
    // published limit on the HAPPY path — a Twilio round trip is well under a
    // second — not some quota edge case.
    const kv = fakeKV();
    const written: string[] = [];
    const tracking = {
      writes: 0,
      get: (k: string) => kv.get(k),
      put: async (k: string, v: string) => {
        written.push(k);
        return kv.put(k, v);
      },
    } as unknown as FakeKV;
    atTime(T0);
    stubFetch();
    await run(env(tracking, live));
    expect(written.length).toBeGreaterThan(0);
    expect(new Set(written).size).toBe(written.length);
  });

  it("advances even when a repeat write to one key would be rate limited", async () => {
    // Same-key rewrite inside a run throws 429 in production. If that is how
    // success gets recorded, `ok` never advances and the test resends forever.
    const kv = fakeKV();
    let seen: string[] = [];
    const rateLimited = {
      writes: 0,
      get: (k: string) => kv.get(k),
      put: async (k: string, v: string) => {
        if (seen.includes(k)) throw new Error("KV PUT failed: 429 Too Many Requests");
        seen.push(k);
        return kv.put(k, v);
      },
    } as unknown as FakeKV;
    const calls = stubFetch();
    atTime(T0);
    seen = [];
    await run(env(rateLimited, live));
    expect(synthetic(calls)).toHaveLength(1);
    // An hour later it must NOT fire again: delivery was proven at T0.
    atTime(T0 + HOUR + 60_000);
    seen = [];
    await run(env(rateLimited, live));
    expect(synthetic(calls)).toHaveLength(1);
  });

  it("does not text a delivery test when a check threw", async () => {
    // `anyDown` only sees checks that returned. A check that REJECTED (its
    // alert could not be delivered) leaves the URL just as down.
    const kv = fakeKV();
    atTime(T0);
    const calls = stubFetch(new Set(["https://a.example", "https://api.twilio.com"]));
    await run(env(kv, live)).catch(() => {});
    await run(env(kv, live)).catch(() => {});
    expect(synthetic(calls)).toHaveLength(0);
  });

  it("never reports healthy when no notifier is configured at all", async () => {
    // notify() logs and returns without throwing when nothing is configured,
    // so every alert is dropped while the heartbeat pings green.
    const kv = fakeKV();
    atTime(T0);
    const calls = stubFetch();
    await run(
      env(kv, {
        HEARTBEAT_URL: HB,
        TWILIO_FROM: undefined,
        TWILIO_TO: undefined,
        TWILIO_ACCOUNT_SID: undefined,
        TWILIO_AUTH_TOKEN: undefined,
      }),
    );
    expect(pings(calls)).toHaveLength(0);
  });

  it("does not text a delivery test while a URL is down", async () => {
    // SMS arrival order is not guaranteed, so "NOT an outage" could land
    // ahead of the DOWN alert it shares a minute with.
    const kv = fakeKV();
    atTime(T0);
    const calls = stubFetch(new Set(["https://a.example"]));
    await run(env(kv, live));
    await run(env(kv, live));
    expect(synthetic(calls)).toHaveLength(0);
  });

  it("rejects a fractional interval that would write KV every run", async () => {
    // 0.0007 days is ~60s: 1,440 writes/day against a 1,000/day cap, after
    // which saveState throws and the origin state machine cannot commit.
    const kv = fakeKV();
    atTime(T0);
    const calls = stubFetch();
    const e = env(kv, { SYNTHETIC_TEST_DAYS: "0.0007" });
    await run(e);
    atTime(T0 + 60_000);
    await run(e);
    expect(synthetic(calls)).toHaveLength(0);
    expect(kv.writes).toBe(0);
  });

  it("puts a timeout on notifier requests", async () => {
    // Cron wall clock is 15 minutes and waiting on fetch is not CPU time, so
    // an unbounded Twilio call can eat the invocation and the heartbeat ping.
    const kv = fakeKV();
    atTime(T0);
    const calls = stubFetch(new Set(["https://a.example"]));
    await run(env(kv, { WEBHOOK_URL: "https://hooks.example/x" }));
    await run(env(kv, { WEBHOOK_URL: "https://hooks.example/x" }));
    const outbound = calls.filter(
      (c) => c.url.includes("api.twilio.com") || c.url.startsWith("https://hooks.example"),
    );
    expect(outbound.length).toBeGreaterThan(0);
    for (const c of outbound) expect(c.init?.signal).toBeDefined();
  });
});

describe("content assertion", () => {
  const bodyText = "Welcome to the server";
  const twice = async (e: never) => {
    await run(e);
    await run(e);
  };

  it("is off unless configured — the body is never even read", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(), 500, "There has been a critical error");
    await twice(env(kv));
    expect(smsCalls(calls)).toHaveLength(0);
  });

  it("stays up when EXPECT_TEXT is present", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(), 500, bodyText);
    await twice(env(kv, { EXPECT_TEXT: "Welcome" }));
    expect(smsCalls(calls)).toHaveLength(0);
  });

  it("pages when EXPECT_TEXT is missing from a 200", async () => {
    // The one case this earns its place: an origin answering 200 with an error
    // body. A plugin error handler or a maintenance page does exactly that.
    const kv = fakeKV();
    const calls = stubFetch(new Set(), 500, "There has been a critical error");
    await twice(env(kv, { EXPECT_TEXT: "Welcome" }));
    const sms = smsCalls(calls);
    expect(sms).toHaveLength(1);
    expect(smsBody(sms[0])).toContain("DOWN");
    expect(smsBody(sms[0])).toContain("200");
  });

  it("pages when FORBID_TEXT appears in a 200", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(), 500, "There has been a critical error");
    await twice(env(kv, { FORBID_TEXT: "critical error" }));
    expect(smsCalls(calls)).toHaveLength(1);
  });

  it("says the content is wrong, not that the server was unreachable", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(), 500, "nope");
    await twice(env(kv, { EXPECT_TEXT: "Welcome" }));
    const body = smsBody(smsCalls(calls)[0]);
    expect(body).not.toContain("unreachable");
    expect(body).toMatch(/content|body|page/i);
  });

  it("finds a match anywhere in the body, however large", async () => {
    // There is no read cap to hide past: the scan is a sliding window bounded
    // by the needle, not a buffer bounded by an arbitrary size.
    const kv = fakeKV();
    const huge = "A".repeat(300_000) + "NEEDLE";
    const calls = stubFetch(new Set(), 500, huge);
    await twice(env(kv, { FORBID_TEXT: "NEEDLE" }));
    expect(smsCalls(calls)).toHaveLength(1);
  });

  it("finds a match straddling a chunk boundary", async () => {
    // The whole reason for the carry-over window.
    const kv = fakeKV();
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (!u.startsWith("https://a.example")) return new Response("ok", { status: 200 });
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode("aaaaaaNEE"));
            c.enqueue(enc.encode("DLEbbbbbb"));
            c.close();
          },
        }),
        { status: 200 },
      );
    });
    await twice(env(kv, { FORBID_TEXT: "NEEDLE" }));
    expect(smsCalls(calls)).toHaveLength(1);
  });

  it("pages when the body dies mid-scan and cannot prove absence", async () => {
    // An unprovable absence is a miss, and a miss outranks a false page.
    const kv = fakeKV();
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (!u.startsWith("https://a.example")) return new Response("ok", { status: 200 });
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode("harmless prefix"));
            c.error(new Error("connection reset mid-body"));
          },
        }),
        { status: 200 },
      );
    });
    await twice(env(kv, { FORBID_TEXT: "critical error" }));
    expect(smsCalls(calls)).toHaveLength(1);
  });

  it("applies to every watched URL", async () => {
    // Spec §2.6 wanted this per URL and it is not. Going inert on more than
    // one URL was tried and reverted: it meant adding a URL silently killed
    // the assertion protecting the original. A loud false page beats that.
    const kv = fakeKV();
    const calls = stubFetch(new Set(), 500, "nothing matching here");
    const e = env(kv, {
      CHECK_URLS: "https://a.example, https://b.example",
      EXPECT_TEXT: "Welcome",
    });
    await twice(e);
    expect(smsCalls(calls).length).toBeGreaterThan(0);
  });

  it("recovers when the content comes back", async () => {
    const kv = fakeKV();
    stubFetch(new Set(), 500, "nope");
    await twice(env(kv, { EXPECT_TEXT: "Welcome" }));
    const recovered = stubFetch(new Set(), 500, bodyText);
    await run(env(kv, { EXPECT_TEXT: "Welcome" }));
    const sms = smsCalls(recovered);
    expect(sms).toHaveLength(1);
    expect(smsBody(sms[0])).toContain("UP");
  });
});

describe("delivery alarm", () => {
  const T0 = 1_700_000_000_000;
  const HB = "https://hc.example/ping/abc123";
  const DELIVERY = "https://hc.example/ping/delivery456";
  const HOUR = 3_600_000;
  const live = {
    HEARTBEAT_URL: HB,
    DELIVERY_PING_URL: DELIVERY,
    SYNTHETIC_TEST_DAYS: "30",
  };
  const okPings = (c: FetchCall[]) => c.filter((x) => x.url === DELIVERY);
  const failPings = (c: FetchCall[]) => c.filter((x) => x.url === DELIVERY + "/fail");

  it("reports success to its own check, separate from the liveness one", async () => {
    // A second check, so a delivery failure does not flap the "is foghorn
    // alive" signal down and up every hour until it is ignored.
    const kv = fakeKV();
    atTime(T0);
    const calls = stubFetch();
    await run(env(kv, live));
    expect(okPings(calls)).toHaveLength(1);
    expect(failPings(calls)).toHaveLength(0);
  });

  it("raises the alarm when the delivery test fails", async () => {
    // This is the whole point: notifier rot stops being a log line nobody
    // reads and becomes a page over a channel that still works.
    const kv = fakeKV();
    atTime(T0);
    const calls = stubFetch(new Set(["https://api.twilio.com"]));
    await run(env(kv, live));
    expect(failPings(calls)).toHaveLength(1);
    expect(okPings(calls)).toHaveLength(0);
  });

  it("clears the alarm when delivery recovers", async () => {
    const kv = fakeKV();
    atTime(T0);
    stubFetch(new Set(["https://api.twilio.com"]));
    await run(env(kv, live));
    const recovered = stubFetch();
    atTime(T0 + HOUR);
    await run(env(kv, live));
    expect(okPings(recovered)).toHaveLength(1);
  });

  it("stays silent on runs where no delivery test was due", async () => {
    // The delivery check's period is the test interval, not a minute. Pinging
    // it every run would make it meaningless.
    const kv = fakeKV();
    atTime(T0);
    stubFetch();
    await run(env(kv, live));
    atTime(T0 + 60_000);
    const later = stubFetch();
    await run(env(kv, live));
    expect(okPings(later)).toHaveLength(0);
    expect(failPings(later)).toHaveLength(0);
  });

  it("does nothing when DELIVERY_PING_URL is unset", async () => {
    const kv = fakeKV();
    atTime(T0);
    const calls = stubFetch();
    await run(env(kv, { HEARTBEAT_URL: HB, SYNTHETIC_TEST_DAYS: "30" }));
    expect(calls.filter((c) => c.url.includes("delivery"))).toHaveLength(0);
  });

  it("does not break the run when the alarm ping itself fails", async () => {
    const kv = fakeKV();
    atTime(T0);
    stubFetch(new Set([DELIVERY]));
    await expect(run(env(kv, live))).resolves.toBeUndefined();
  });

  it("still sends the liveness heartbeat on the same run", async () => {
    // Guards the regression class that has bitten this project twice: a
    // coupling that only appears once the new secret is set would otherwise
    // pass the whole suite, because the heartbeat tests never set it.
    const kv = fakeKV();
    atTime(T0);
    const calls = stubFetch();
    await run(env(kv, live));
    expect(calls.filter((c) => c.url === HB)).toHaveLength(1);
    expect(okPings(calls)).toHaveLength(1);
  });

  it("keeps the heartbeat alive when the delivery test fails", async () => {
    const kv = fakeKV();
    atTime(T0);
    const calls = stubFetch(new Set(["https://api.twilio.com"]));
    await run(env(kv, live));
    expect(calls.filter((c) => c.url === HB)).toHaveLength(1);
    expect(failPings(calls)).toHaveLength(1);
  });
});

describe("notifiers", () => {
  it("POSTs Slack/Discord-compatible JSON to WEBHOOK_URL on a transition", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]));
    const e = env(kv, {
      TWILIO_FROM: undefined,
      TWILIO_TO: undefined,
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      WEBHOOK_URL: "https://hooks.example/T/B/x",
    });
    await run(e);
    await run(e);
    const hooks = calls.filter((c) => c.url === "https://hooks.example/T/B/x");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].init?.method).toBe("POST");
    const payload = JSON.parse(String(hooks[0].init?.body));
    expect(payload.text).toContain("DOWN");
    expect(payload.content).toContain("DOWN");
    expect(smsCalls(calls)).toHaveLength(0);
  });

  it("retries the DOWN alert next run when every notifier fails", async () => {
    const kv = fakeKV();
    // origin down AND Twilio erroring — delivery fails, state must not commit
    const failing = stubFetch(new Set(["https://a.example", "https://api.twilio.com"]));
    await run(env(kv)).catch(() => {});
    await run(env(kv)).catch(() => {});
    expect(smsCalls(failing)).toHaveLength(1);
    // Twilio recovers; origin still down → alert retried and delivered
    const recovered = stubFetch(new Set(["https://a.example"]));
    await run(env(kv));
    expect(smsCalls(recovered)).toHaveLength(1);
    // delivered → committed → no further texts
    await run(env(kv));
    expect(smsCalls(recovered)).toHaveLength(1);
  });

  it("retries the UP alert next run when every notifier fails", async () => {
    const kv = fakeKV();
    stubFetch(new Set(["https://a.example"]));
    await run(env(kv));
    await run(env(kv));
    // origin recovers but Twilio errors → UP not committed
    const failing = stubFetch(new Set(["https://api.twilio.com"]));
    await run(env(kv)).catch(() => {});
    expect(smsCalls(failing)).toHaveLength(1);
    // Twilio recovers → UP retried, then steady-state silence
    const recovered = stubFetch();
    await run(env(kv));
    expect(smsCalls(recovered)).toHaveLength(1);
    expect(smsBody(recovered[recovered.length - 1])).toContain("UP");
    await run(env(kv));
    expect(smsCalls(recovered)).toHaveLength(1);
  });

  it("commits state when at least one notifier delivers", async () => {
    const kv = fakeKV();
    // webhook erroring, Twilio fine → partial delivery counts as delivered
    const calls = stubFetch(new Set(["https://a.example", "https://hooks.example"]));
    const e = env(kv, { WEBHOOK_URL: "https://hooks.example/T/B/x" });
    await run(e);
    await run(e);
    expect(smsCalls(calls)).toHaveLength(1);
    // committed → still-down runs stay silent
    await run(e);
    expect(smsCalls(calls)).toHaveLength(1);
  });

  it("fires both notifiers when both are configured", async () => {
    const kv = fakeKV();
    const calls = stubFetch(new Set(["https://a.example"]));
    const e = env(kv, { WEBHOOK_URL: "https://hooks.example/T/B/x" });
    await run(e);
    await run(e);
    expect(smsCalls(calls)).toHaveLength(1);
    expect(calls.filter((c) => c.url === "https://hooks.example/T/B/x")).toHaveLength(1);
  });
});
