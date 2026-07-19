# 📟 Foghorn

[![CI](https://github.com/peaceharborco/foghorn/actions/workflows/ci.yml/badge.svg)](https://github.com/peaceharborco/foghorn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A dead-man watchdog for your server, not another status page.** One
cron-triggered Cloudflare Worker, one source file, and one text message when
your box actually goes down — plus one more when it comes back. That's the
entire feature list, on purpose.

Every serverless uptime project we could find is a status page that also
monitors — dashboards, history charts, geo-checks, D1 migrations. All good
things. But when your server dies at 2am, a Discord ping doesn't wake you up.

A text does.

## How it works

Every minute, Cloudflare's cron fires the Worker. It fetches each URL you're
watching (cache-busted, so it always hits the origin). After `FAIL_THRESHOLD`
consecutive failures it sends **one** DOWN alert; on recovery, **one** UP alert.
Exactly one message per transition — a server that's down for six hours costs
you two texts, not 360.

State lives in Workers KV and is written **only when something changes**. A
healthy server does *zero* KV writes — which matters, because Cloudflare's free
tier allows 1,000 KV writes/day and a naive write-every-minute monitor burns
1,440. This one idles at 1,440 *reads*/day per URL against a 100,000/day read
quota. It runs free, forever, and never gets close to the limits.

And because it's a dead-man alarm, delivery is part of the state machine: if
every configured notifier fails to send (Twilio rejects, webhook 500s), the
transition is **not** committed — the Worker retries the alert on the next
cron run until one notifier actually delivers.

Two notifiers, use either or both:

- **Twilio SMS** — the reason this exists. Costs you a Twilio account and
  pennies per outage.
- **Generic webhook** — POSTs JSON carrying both `text` and `content` keys, so
  a Slack or Discord webhook URL works as-is, and anything else can read
  either field.

## Quick start

```bash
git clone https://github.com/peaceharborco/foghorn.git
cd foghorn
npm install

# your real config stays out of git (wrangler.jsonc is gitignored)
cp wrangler.jsonc.example wrangler.jsonc

# create the KV namespace, then paste its id into wrangler.jsonc
npx wrangler kv namespace create STATE

# edit wrangler.jsonc: CHECK_URLS, threshold, and your notifier(s)

# if using Twilio SMS:
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN

npx wrangler deploy
```

That's it. No servers to host, no containers, nothing watching the watcher —
the monitor lives on Cloudflare's edge, outside the blast radius of the thing
it's monitoring.

## Configuration

All plain vars in `wrangler.jsonc` (secrets via `wrangler secret put`):

| Var | Required | What it does |
|---|---|---|
| `CHECK_URLS` | yes | One or more URLs, comma-separated. Each gets its own failure streak and its own alerts. (`CHECK_URL` also accepted.) |
| `FAIL_THRESHOLD` | no | Consecutive failed checks before a DOWN alert. Default `2` — with a 1-minute cron, that's ~2 minutes of confirmed downtime before your phone buzzes. |
| `TWILIO_FROM` / `TWILIO_TO` | for SMS | Your Twilio number and where to text. Also needs the `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` secrets. |
| `WEBHOOK_URL` | for webhook | Any Slack/Discord-compatible webhook endpoint. |

A check counts as **up** on any 2xx/3xx response. A 4xx, a 5xx, a timeout
(10s), or a refused connection all count as **down** — if your homepage starts
throwing 500s, that's an outage, whatever the TCP handshake thinks.

## What this deliberately is not

No status page. No uptime history. No multi-region checks. No UI. If you want
those (they're legitimate wants), use [UptimeFlare](https://github.com/lyc8503/UptimeFlare)
or [Uptime Kuma](https://github.com/louislam/uptime-kuma) — they're good at it.

This project competes on the other axis: small enough to read over coffee,
simple enough to never touch again, and frugal enough to run free until the
heat death of the universe. Feature requests that grow it into a status page
will be lovingly declined.

## Development

```bash
npm test            # vitest suite
npm run typecheck   # tsc --noEmit
npm run dev         # wrangler dev --test-scheduled --remote
```

Trigger a test run of the scheduled handler locally:

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

## License

[MIT](LICENSE) © Peace Harbor Studios. Built because our server needed watching
and everything else wanted to be a product.
