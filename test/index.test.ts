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
 */
function stubFetch(down: Set<string> = new Set()): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const d of down) {
      if (u.startsWith(d)) return new Response("err", { status: 500 });
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
const smsBody = (c: FetchCall) =>
  decodeURIComponent(String(c.init?.body ?? "").replace(/\+/g, " "));

afterEach(() => {
  vi.unstubAllGlobals();
});

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
