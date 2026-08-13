# 📯 Foghorn

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
quota. It runs free, forever, and never gets close to the limits. (Turning on
`SYNTHETIC_TEST_DAYS` adds two reads per run and two writes per interval — a
couple of dozen writes a year.)

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

# strongly recommended — the dead-man ping that catches foghorn's own death
npx wrangler secret put HEARTBEAT_URL

npx wrangler deploy
```

That's it. No servers to host, no containers — the monitor lives on
Cloudflare's edge, outside the blast radius of the thing it's monitoring, and
`HEARTBEAT_URL` puts one more pair of eyes outside *that*.

## Configuration

All plain vars in `wrangler.jsonc` (secrets via `wrangler secret put`):

| Var | Required | What it does |
|---|---|---|
| `CHECK_URLS` | yes | One or more URLs, comma-separated. Each gets its own failure streak and its own alerts. (`CHECK_URL` also accepted.) |
| `FAIL_THRESHOLD` | no | Consecutive failed checks before a DOWN alert. Default `2` — with a 1-minute cron, that's ~2 minutes of confirmed downtime before your phone buzzes. |
| `TWILIO_FROM` / `TWILIO_TO` | for SMS | Your Twilio number and where to text. Also needs the `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` secrets. |
| `WEBHOOK_URL` | for webhook | Any Slack/Discord-compatible webhook endpoint. |
| `HEARTBEAT_URL` | no (**secret**) | Dead-man ping URL from healthchecks.io or equivalent, pinged on each run that foghorn could actually page you (see below). This is what raises the alarm when *foghorn itself* dies. A capability URL — use `wrangler secret put`, not a var. |
| `SYNTHETIC_TEST_DAYS` | no | Text yourself every N **whole** days to prove the delivery path still works. Off unless set; enabling it sends one on the next cron. Costs one text per interval. |
| `DELIVERY_PING_URL` | no (**secret**) | A **second** dead-man check, watching the delivery test alone. Pinged when the test passes, `/fail` when it fails — so notifier rot pages you instead of only reaching a log. Set its period to the test interval, not a minute. |
| `EXPECT_TEXT` / `FORBID_TEXT` | no | Assert on the page body of a 2xx: page if the expected text is missing, or the forbidden text appears. Off unless set, and the body is not read otherwise. Applies to **every** URL in `CHECK_URLS` — see below before using it with more than one. |

A check counts as **up** on any 2xx/3xx response. A 4xx, a 5xx, a timeout
(10s), or a refused connection all count as **down** — if your homepage starts
throwing 500s, that's an outage, whatever the TCP handshake thinks. The alert
says which kind of dead it is: *unreachable* when nothing answered, *answered
HTTP 403* when the origin is up but refusing (a WAF rule, a challenge, or a
check URL that's simply wrong).

### Who watches the watchman

A dead-man alarm whose own death is silent isn't one. If the cron stops firing,
a deploy throws, or the account is suspended, foghorn goes quiet — which looks
exactly like a healthy server.

`HEARTBEAT_URL` closes that: each run pings a service outside Cloudflare, which
raises the alarm when the pings *stop*. It fires on DOWN runs too, deliberately
— gating it on the origin being up would mean a real outage silences the
heartbeat, and you'd get "foghorn is dead" alongside a correct DOWN alert, one
of them lying.

It goes quiet in exactly the cases where foghorn could not page you anyway:

- something other than a refused alert threw — a dead KV binding, a write
  quota exhausted, state that won't commit;
- no notifier is configured at all, so every alert is being dropped to a log;
- `CHECK_URLS` is empty, so foghorn is watching nothing.

An alert merely failing to send is *not* on that list, and neither is a failed
delivery test. Both happen while foghorn is alive and doing its job, and
withholding the ping for either produces a false "foghorn is dead" page on top
of a correct DOWN alert — two alarms, one of them lying.

All of which proves foghorn *ran*. It proves nothing about whether Twilio would
*deliver* — a rotated auth token leaves foghorn looking healthy right up until
the outage it fails to report. `SYNTHETIC_TEST_DAYS` is the answer: a periodic
text, plainly worded so it's never mistaken for an outage, and never sent while
a URL is down (a real DOWN alert proves the same thing, and SMS arrival order
isn't guaranteed).

A failed delivery test retries hourly until it lands, so one transient blip
can't hide notifier rot for a month — and with `DELIVERY_PING_URL` set it hits
that check's `/fail` endpoint, so the failure **pages you** instead of reaching
a log nobody reads. It deliberately does not touch the liveness heartbeat:
withholding that during an outage deadlocks, which is a mistake this codebase
made once already.

One limit worth knowing: **with several notifiers configured it proves at least
one path works, not all of them**, so a rotated Twilio token can hide behind a
working Slack webhook.

Pick a provider whose delivery path differs from your notifier's, or one Twilio
outage takes both alarms down at once.

### When the page lies

A server can answer `200` and still be broken — a plugin error handler or a
maintenance page returning a cheerful status with an error body. `EXPECT_TEXT`
and `FORBID_TEXT` catch exactly that, and nothing else: **a stale-but-healthy
cached page passes any content check you can write**, so this is not a defence
against caching. Off by default, because a homepage copy change will page you
at 3am if you forget it's on.

It **applies to every URL in `CHECK_URLS`**, so with more than one it will page
on any that lacks the text. That is deliberate: the alternative — going inert
on multiple URLs — meant adding a URL silently killed the assertion protecting
the original, and a quiet miss is worse than a loud false page.

The body is scanned as a stream with a sliding window sized to the search
string, decoded in small slices, so peak memory is bounded by that slice rather
than by the page: there is no size limit, and no limit for a match to hide past. If the body dies mid-scan
it pages rather than assuming the page was clean — an absence you cannot prove
is a miss.

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
