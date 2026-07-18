/**
 * down-detector — Cloudflare Worker (cron-triggered)
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
 * Secrets (wrangler secret put): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
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
}

interface State {
  status: "up" | "down";
  fails: number;
}

const CHECK_TIMEOUT_MS = 10_000;

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const urls = parseUrls(env.CHECK_URLS ?? env.CHECK_URL ?? "");
    if (urls.length === 0) {
      console.error("down-detector: no CHECK_URLS configured");
      return;
    }
    const threshold = Math.max(1, parseInt(env.FAIL_THRESHOLD ?? "2", 10) || 2);
    // Each URL is isolated: one URL's failed alert delivery must not stop the
    // others from being checked. Surface the first failure so the cron run
    // still reports an error in observability.
    const results = await Promise.allSettled(urls.map((url) => checkOne(env, url, threshold)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  },
};

async function checkOne(env: Env, url: string, threshold: number): Promise<void> {
  const host = hostOf(url);
  const prev = await loadState(env, url);
  const ok = await isReachable(url);

  if (ok) {
    if (prev.status === "down") {
      await notify(env, `down-detector: ${host} is back UP.`);
      await saveState(env, url, { status: "up", fails: 0 });
    } else if (prev.fails !== 0) {
      // a partial failure streak recovered before reaching the threshold
      await saveState(env, url, { status: "up", fails: 0 });
    }
    // healthy and was already healthy → no state change, no KV write
    return;
  }

  // check failed
  if (prev.status === "down") {
    // already alerted and still down → nothing changes, no write, no spam
    return;
  }
  const fails = prev.fails + 1;
  if (fails >= threshold) {
    await notify(env, `down-detector: ${host} appears DOWN — ${fails} consecutive failed checks.`);
    await saveState(env, url, { status: "down", fails });
  } else {
    await saveState(env, url, { status: "up", fails });
  }
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

async function isReachable(url: string): Promise<boolean> {
  // Cache-bust so the check always hits the origin, never a cached subrequest.
  const probe = url + (url.includes("?") ? "&" : "?") + "_cb=" + Date.now();
  try {
    const resp = await fetch(probe, {
      method: "GET",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    // 2xx/3xx = the server responded; 4xx/5xx or a thrown error = down
    return resp.status >= 200 && resp.status < 400;
  } catch {
    return false;
  }
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
    console.error(`down-detector: no notifier configured — dropped alert: ${body}`);
    return;
  }
  const results = await Promise.allSettled(tasks);
  if (results.every((r) => r.status === "rejected")) {
    throw new Error(`down-detector: every notifier failed — alert will retry next run: ${body}`);
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
  });
  if (!resp.ok) {
    console.error(`down-detector: Twilio send failed — HTTP ${resp.status}: ${await resp.text()}`);
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
  });
  if (!resp.ok) {
    console.error(`down-detector: webhook send failed — HTTP ${resp.status}: ${await resp.text()}`);
    throw new Error(`webhook send failed — HTTP ${resp.status}`);
  }
}
