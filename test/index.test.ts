import { afterEach, describe, expect, it, vi } from "vitest";
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
    return new Response("ok", { status: 200 });
  });
  return calls;
}

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
      const body = await downAlertBody(403, url);
      expect(outsideGsm7(body)).toEqual([]);
      expect(body.length).toBeLessThanOrEqual(160);
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
