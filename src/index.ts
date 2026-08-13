/**
 * Foghorn — Cloudflare Worker (cron-triggered)
 *
 * Every minute, checks whether each configured URL is reachable from outside.
 * After FAIL_THRESHOLD consecutive failed checks it sends one alert; on
 * recovery it sends one more. Exactly one alert per transition — no spam.
 *
 * State lives in KV and is written ONLY when it changes, so a healthy
 * server costs zero KV writes (Cloudflare's free KV write quota is tight).
 *
 * Config (wrangler.jsonc vars):
 *   CHECK_URLS      one or more URLs, comma-separated (CHECK_URL also accepted)
 *   FAIL_THRESHOLD  consecutive failures before a DOWN alert (default 2)
 *   TWILIO_FROM / TWILIO_TO   SMS notifier (needs the two secrets below)
 *   WEBHOOK_URL     generic webhook notifier — payload carries both "text"
 *                   and "content", so Slack and Discord URLs work as-is
 *   SYNTHETIC_TEST_DAYS  text yourself every N whole days to prove the
 *                   notifier path still delivers. Off unless set.
 * Secrets (wrangler secret put): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 *   HEARTBEAT_URL   dead-man ping (healthchecks.io and equivalents). Pinged on
 *                   each run where foghorn could actually page someone, so a
 *                   third party raises the alarm when FOGHORN dies. A
 *                   capability URL — secret, not var.
 * Binding: STATE (KV namespace)
 */

interface Env {
  STATE: KVNamespace;
  CHECK_URLS?: string;
  CHECK_URL?: string;
  FAIL_THRESHOLD?: string;
  TWILIO_FROM?: string;
  TWILIO_TO?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  WEBHOOK_URL?: string;
  HEARTBEAT_URL?: string;
  SYNTHETIC_TEST_DAYS?: string;
}

/**
 * Thrown when every notifier refused an alert. Distinct from any other error
 * so the heartbeat can tell "the alert did not get out" (delivery, which the
 * synthetic send covers) from "foghorn itself is broken" (machinery).
 */
class NotifyError extends Error {}

interface State {
  status: "up" | "down";
  fails: number;
}

/**
 * Outcome of one probe. `status` is absent when nothing answered at all —
 * DNS failure, connection refused, timeout — which is a different message to
 * the operator than a server that answered and said no.
 */
interface Probe {
  ok: boolean;
  status?: number;
}

/**
 * Delivery-test bookkeeping. `ok` is the last PROVEN delivery, `attempt` the
 * last try. `attempt > ok` means "retry slowly" — NOT "delivery is known
 * broken". The two keys are read independently and KV serves stale or missing
 * values for up to ~60s (negative lookups are cached too), so a healthy path
 * can read as `attempt > ok` for a while. It only ever costs a delayed
 * re-proof or a surplus text, never a missed origin page.
 *
 * It deliberately does NOT gate the heartbeat, however tempting that looks:
 * the test is skipped whenever a URL is down, so withholding the ping on
 * `attempt > ok` deadlocks — nothing can clear the flag, and the dead-man
 * service pages "foghorn is dead" for a whole outage while foghorn is
 * correctly firing DOWN. No heartbeat condition may read this struct.
 */
interface Synthetic {
  ok: number;
  attempt: number;
}

const CHECK_TIMEOUT_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
// Waiting on fetch is not CPU time, so an unbounded notifier call can sit for
// the whole 15-minute cron wall clock and eat the heartbeat ping with it.
const NOTIFY_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;
// How soon to re-attempt a delivery test that failed. Not every minute (that
// is Twilio spam and a KV write storm), not a full interval (that would let
// one transient blip hide notifier rot until the next outage).
const SYNTHETIC_RETRY_MS = 3_600_000;
// Two keys, not one record. Workers KV allows 1 write per key per second and
// throws 429 beyond it, and a delivery test writes twice in one invocation —
// once before sending, once after. Split across keys, each is written at most
// once per run. (A pre-release build used a single `synthetic:last` JSON blob;
// it was never enabled in production, so there is nothing to migrate.)
const SYNTHETIC_OK_KEY = "synthetic:ok";
const SYNTHETIC_ATTEMPT_KEY = "synthetic:attempt";
// Alert bodies must stay inside one 160-character GSM-7 segment; clamping the
// host is what keeps that true for a name longer than the current one.
const MAX_HOST_IN_SMS = 40;
const SYNTHETIC_MESSAGE =
  "Foghorn: scheduled delivery test, NOT an outage. " +
  "Getting this means SMS alerts can still reach you.";

// Workers `fetch` sends no User-Agent unless one is set, so foghorn's probes
// otherwise land in the origin logs as empty-UA cache-busted requests every
// 60 seconds — the exact shape of an abusive scanner. Identify ourselves.
const USER_AGENT = "Foghorn/1.0 (+https://github.com/peaceharborco/foghorn)";

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const urls = parseUrls(env.CHECK_URLS ?? env.CHECK_URL ?? "");
    if (urls.length === 0) {
      console.error("Foghorn: no CHECK_URLS configured");
      return;
    }
    const threshold = Math.max(1, parseInt(env.FAIL_THRESHOLD ?? "2", 10) || 2);
    // Each URL is isolated: one URL's failed alert delivery must not stop the
    // others from being checked. Surface the first failure so the cron run
    // still reports an error in observability.
    const results = await Promise.allSettled(urls.map((url) => checkOne(env, url, threshold)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    // Anything other than a clean "it answered": a check that returned false,
    // or one that threw because its alert could not be delivered. A rejected
    // check leaves the URL just as down as a returned one.
    const allWell = results.every((r) => r.status === "fulfilled" && r.value);

    const days = syntheticDays(env);
    const synthetic = days === null ? null : await loadSynthetic(env);

    // Ping BEFORE rethrowing, and on DOWN runs: gating the heartbeat on the
    // origin being up means a real outage stops it and the dead-man service
    // pages "foghorn is dead" while foghorn is correctly firing DOWN.
    //
    // It stays quiet in three cases, all of them "foghorn cannot page anyone":
    // something other than a refused alert threw (a dead STATE binding), no
    // notifier is configured at all, or CHECK_URLS is empty (returned above).
    //
    // A failed DELIVERY TEST is deliberately NOT on that list, though it is
    // tempting. Withholding the ping there deadlocks: the test is skipped
    // during an outage, so nothing can clear the flag, and the dead-man service
    // pages "foghorn is dead" for the whole outage while foghorn is correctly
    // firing DOWN — the exact dual-alarm lie this contract forbids.
    //
    // Ping before the delivery test, never after: notifier calls reach a third
    // party, and one hanging in front of the ping is indistinguishable from
    // foghorn being dead.
    if (failed.every((r) => r.reason instanceof NotifyError) && hasNotifier(env)) {
      await heartbeat(env);
    }
    if (days !== null && synthetic !== null) await runSyntheticTest(env, days, synthetic, allWell);
    if (failed.length > 0) throw failed[0].reason;
  },
};

/** Whether any alert could actually leave the building. */
function hasNotifier(env: Env): boolean {
  const twilio = Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM && env.TWILIO_TO,
  );
  return twilio || Boolean(env.WEBHOOK_URL);
}

/** Logs the name only: error messages can carry the URL, and one of ours is a secret. */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown error";
}

/** Resolves to whether the URL answered, so the caller can hold the delivery test. */
async function checkOne(env: Env, url: string, threshold: number): Promise<boolean> {
  const host = hostOf(url);
  const prev = await loadState(env, url);
  const probe = await checkReachable(url);

  if (probe.ok) {
    if (prev.status === "down") {
      await notify(env, `Foghorn: ${smsHost(host)} is back UP.`);
      await saveState(env, url, { status: "up", fails: 0 });
    } else if (prev.fails !== 0) {
      // a partial failure streak recovered before reaching the threshold
      await saveState(env, url, { status: "up", fails: 0 });
    }
    // healthy and was already healthy → no state change, no KV write
    return true;
  }

  // check failed
  if (prev.status === "down") {
    // already alerted and still down → nothing changes, no write, no spam
    return false;
  }
  const fails = prev.fails + 1;
  if (fails >= threshold) {
    await notify(env, downMessage(host, probe, fails));
    await saveState(env, url, { status: "down", fails });
  } else {
    await saveState(env, url, { status: "up", fails });
  }
  return false;
}

function parseUrls(raw: string): string[] {
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function stateKey(url: string): string {
  return `state:${url}`;
}

async function loadState(env: Env, url: string): Promise<State> {
  const raw = await env.STATE.get(stateKey(url));
  if (!raw) return { status: "up", fails: 0 };
  try {
    const s = JSON.parse(raw) as Partial<State>;
    return {
      status: s.status === "down" ? "down" : "up",
      fails: Number.isInteger(s.fails) && (s.fails as number) >= 0 ? (s.fails as number) : 0,
    };
  } catch {
    return { status: "up", fails: 0 };
  }
}

async function saveState(env: Env, url: string, state: State): Promise<void> {
  await env.STATE.put(stateKey(url), JSON.stringify(state));
}

async function checkReachable(url: string): Promise<Probe> {
  // Cache-bust so the check always hits the origin, never a cached subrequest.
  // Via searchParams, not concatenation: appending to a URL carrying a
  // fragment puts `_cb` after the "#", where fetch strips it and the request
  // can be answered from cache — exactly what the buster exists to prevent.
  let target: string;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("_cb", String(Date.now()));
    target = parsed.toString();
  } catch {
    return { ok: false };
  }
  try {
    const resp = await fetch(target, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      // A Worker subrequest reads through a Cloudflare cache even for a
      // DNS-only hostname, because the name still belongs to a Cloudflare
      // zone. `_cb` makes a HIT unlikely; this makes it impossible.
      // (Default since compatibility_date 2024-11-11; an unsupported value
      // throws rather than being ignored, so this cannot fail silently.)
      cache: "no-store",
      // `follow` scores the FINAL response; `manual` scores the FIRST HOP, and
      // a 3xx counts as up because the origin answered. That is the question
      // foghorn asks — but it IS quieter than `follow` for "origin is up and
      // pointing at a corpse": a 3xx to a dead target, or a redirect loop, now
      // reads up where following would have paged. Deliberate, and a no-op on
      // the deployed URL (cds1 answers 200, not a redirect). See spec §6 for
      // the full matrix; if a checked host starts redirecting, add its target
      // as its own CHECK_URLS entry rather than restoring `follow`.
      redirect: "manual",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    // 2xx/3xx = the server responded; 4xx/5xx or a thrown error = down
    return { ok: resp.status >= 200 && resp.status < 400, status: resp.status };
  } catch {
    return { ok: false };
  }
}

/**
 * A 4xx still counts as DOWN — an origin refusing everyone is an outage as far
 * as customers are concerned, and treating it as UP would trade a missed page
 * for fewer false ones. Only the wording distinguishes the cases, so the first
 * sentence the operator reads at 3am says which kind of dead it is.
 *
 * Alert text stays inside the GSM-7 alphabet (no em dashes, no smart quotes):
 * one character outside it flips the SMS to UCS-2 and cuts the segment from
 * 160 characters to 70, splitting the alert into parts that can arrive out of
 * order. Keep it plain ASCII and under 160 characters with the real hostname.
 */
/**
 * Clamp from the left: the registrable domain is the identifying part, and
 * `hostOf` falls back to the entire raw URL when parsing fails. A clamped name
 * is marked so it cannot be misread as a different real host.
 */
function smsHost(host: string): string {
  return host.length <= MAX_HOST_IN_SMS ? host : "..." + host.slice(-MAX_HOST_IN_SMS);
}

function downMessage(rawHost: string, probe: Probe, fails: number): string {
  const host = smsHost(rawHost);
  const tail = `${fails} consecutive fails.`;
  if (probe.status === undefined) {
    return `Foghorn: ${host} appears DOWN - unreachable, ${tail}`;
  }
  if (probe.status >= 400 && probe.status < 500) {
    return (
      `Foghorn: ${host} appears DOWN - answered HTTP ${probe.status}, ` +
      `up but refusing (WAF/challenge/bad URL), ${tail}`
    );
  }
  return `Foghorn: ${host} appears DOWN - answered HTTP ${probe.status}, ${tail}`;
}

/**
 * Delivers the alert through every configured notifier. Throws when ALL of
 * them fail, so the caller skips the state write and the alert is retried on
 * the next cron run — a dead-man alarm must never mark an alert delivered
 * when nobody heard it.
 */
async function notify(env: Env, body: string): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM && env.TWILIO_TO) {
    tasks.push(sendSms(env, body));
  }
  if (env.WEBHOOK_URL) {
    tasks.push(sendWebhook(env.WEBHOOK_URL, body));
  }
  if (tasks.length === 0) {
    console.error(`Foghorn: no notifier configured — dropped alert: ${body}`);
    return;
  }
  const results = await Promise.allSettled(tasks);
  if (results.every((r) => r.status === "rejected")) {
    throw new NotifyError(`Foghorn: every notifier failed — alert will retry next run: ${body}`);
  }
}

/**
 * Periodically texts the operator on purpose, to prove the delivery path still
 * works. The heartbeat proves foghorn RAN; nothing else proves Twilio would
 * DELIVER. If the auth token is rotated or the account lapses, foghorn stays
 * "healthy" and the first you learn of it is a missed outage.
 *
 * Off unless SYNTHETIC_TEST_DAYS is set to a positive number, because it costs
 * the operator a text. Enabling it sends one immediately, so you find out then
 * and there rather than in 30 days.
 *
 * Never throws: it runs alongside the origin checks and must not stop them, or
 * mask the failure the caller is about to rethrow.
 */
function syntheticDays(env: Env): number | null {
  const raw = env.SYNTHETIC_TEST_DAYS;
  if (raw === undefined || raw.trim() === "") return null;
  const days = Number(raw);
  // Whole days only. A fractional interval (0.0007 is about a minute) writes
  // KV on nearly every run, blows the 1,000/day free cap, and once writes
  // start failing `saveState` throws and no transition can ever commit.
  // Say so rather than silently disabling: an operator who set this believes
  // the delivery path is being tested.
  if (!Number.isInteger(days) || days < 1) {
    console.error(
      `Foghorn: ignoring SYNTHETIC_TEST_DAYS="${raw}" — want a whole number of days >= 1. ` +
        `The delivery path is NOT being tested.`,
    );
    return null;
  }
  return days;
}

async function loadSynthetic(env: Env): Promise<Synthetic> {
  try {
    const [okRaw, attemptRaw] = await Promise.all([
      env.STATE.get(SYNTHETIC_OK_KEY),
      env.STATE.get(SYNTHETIC_ATTEMPT_KEY),
    ]);
    const num = (v: string | null) => {
      const n = v === null ? 0 : Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    return { ok: num(okRaw), attempt: num(attemptRaw) };
  } catch {
    return { ok: 0, attempt: 0 };
  }
}

/**
 * Texts the operator on purpose, periodically, to prove the delivery path
 * still works. The heartbeat proves foghorn RAN; only this proves Twilio would
 * DELIVER — if the auth token is rotated, nothing else notices until the first
 * outage foghorn fails to report.
 *
 * Records success and attempts separately, so a failure neither burns the
 * interval nor passes for proof: it retries hourly until it lands.
 *
 * KNOWN GAP: a failure is loud in the logs but pages nobody. Wiring it to the
 * heartbeat looked like the answer and is not — see the deadlock described at
 * the call site. The real fix is the dead-man provider's own failure endpoint,
 * which needs a provider chosen first.
 *
 * KNOWN GAP: with several notifiers configured, `notify()` succeeds if ANY of
 * them delivers, so this proves at least one path works, not that all do. A
 * rotated Twilio token hides behind a working Slack webhook.
 */
async function runSyntheticTest(
  env: Env,
  days: number,
  prev: Synthetic,
  allWell: boolean,
): Promise<void> {
  // Only on a completely clean run: SMS arrival order is not guaranteed, so
  // "NOT an outage" could land ahead of the DOWN alert it shares a minute with.
  if (!allWell || !hasNotifier(env)) return;

  const now = Date.now();
  // Future stamps (clock skew) would otherwise disable this forever.
  const ok = prev.ok > now ? 0 : prev.ok;
  const attempt = prev.attempt > now ? 0 : prev.attempt;
  if (now - ok < days * DAY_MS) return;
  if (attempt > ok && now - attempt < SYNTHETIC_RETRY_MS) return;

  // Record the ATTEMPT before sending, and send nothing if that write fails.
  // An unrecorded attempt looks due again the next minute, which is a text a
  // minute for as long as KV writes are failing — and an exhausted write quota
  // is exactly when that happens. Only `ok` waits for proven delivery, so a
  // failed send still costs the interval nothing.
  try {
    await env.STATE.put(SYNTHETIC_ATTEMPT_KEY, String(now));
  } catch (err) {
    console.error(
      `Foghorn: skipping the delivery test — cannot record the attempt (${errName(err)}).`,
    );
    return;
  }

  try {
    await notify(env, SYNTHETIC_MESSAGE);
  } catch (err) {
    console.error(
      `Foghorn: SYNTHETIC DELIVERY TEST FAILED (${errName(err)}) — ` +
        `alerts may not be reaching anyone. Retrying hourly until it lands.`,
    );
    return;
  }

  try {
    await env.STATE.put(SYNTHETIC_OK_KEY, String(now));
  } catch (err) {
    // Delivered, but the success could not be recorded, so `attempt > ok`
    // stands and this retries hourly rather than every minute. One surplus
    // text an hour at worst. Using a separate key avoids the per-key 1-write-
    // per-second cap, but NOT the 1,000 writes/day account limit — exhaust
    // that and every key fails, including the origin's own state writes.
    console.error(
      `Foghorn: delivery test succeeded but recording it failed (${errName(err)}).`,
    );
  }
}

/**
 * Pings a third-party dead-man service so something OUTSIDE Cloudflare notices
 * when foghorn stops running — a cron silently skipped, a deploy that throws,
 * an account suspension. Nothing else pages when the alarm itself dies.
 *
 * Never throws. It runs after `Promise.allSettled`, so it cannot skip a state
 * write the way a throw inside `checkOne` would — but a throw here would mask
 * the real failure the caller is about to rethrow, and would fail an otherwise
 * healthy run over a third party being unreachable.
 */
async function heartbeat(env: Env): Promise<void> {
  if (!env.HEARTBEAT_URL) return;
  try {
    const resp = await fetch(env.HEARTBEAT_URL, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.error(`Foghorn: heartbeat ping failed — HTTP ${resp.status}`);
    }
  } catch (err) {
    // Name only: HEARTBEAT_URL is a capability — anyone holding it can forge a
    // heartbeat — and fetch errors can carry the URL into observability logs.
    console.error(`Foghorn: heartbeat ping failed — ${errName(err)}`);
  }
}

async function sendSms(env: Env, body: string): Promise<void> {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({
    From: env.TWILIO_FROM!,
    To: env.TWILIO_TO!,
    Body: body,
  });
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  });
  if (!resp.ok) {
    console.error(`Foghorn: Twilio send failed — HTTP ${resp.status}: ${await resp.text()}`);
    throw new Error(`Twilio send failed — HTTP ${resp.status}`);
  }
}

async function sendWebhook(url: string, body: string): Promise<void> {
  // "text" satisfies Slack-style webhooks, "content" satisfies Discord-style;
  // generic consumers can read either.
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: body, content: body }),
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  });
  if (!resp.ok) {
    console.error(`Foghorn: webhook send failed — HTTP ${resp.status}: ${await resp.text()}`);
    throw new Error(`webhook send failed — HTTP ${resp.status}`);
  }
}
