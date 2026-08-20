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
watching (cache-busted, so it always hits the origin). A probe that fails in
transit is retried once inside the same run, so a blip that clears within a
second never starts a streak. After `FAIL_THRESHOLD` consecutive failed checks
it sends **one** DOWN alert; on recovery, **one** UP alert. Exactly one message
per transition — a server that's down for six hours costs you two texts, not
360.

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
| `FAIL_THRESHOLD` | no | Consecutive failed **checks** before a DOWN alert, counted at the cron interval. A check is one probe, plus a second attempt when the first failed in transit. Default `2`; on a 1-minute cron that is two consecutive failed minutes. See below for what that does and does not buy. |
| `TWILIO_FROM` / `TWILIO_TO` | for SMS | Your Twilio number and where to text. Also needs the `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` secrets. |
| `WEBHOOK_URL` | for webhook | Any Slack/Discord-compatible webhook endpoint. |
| `HEARTBEAT_URL` | no (**secret**) | Dead-man ping URL from healthchecks.io or equivalent, pinged on each run that foghorn could actually page you (see below). This is what raises the alarm when *foghorn itself* dies. A capability URL — use `wrangler secret put`, not a var. |
| `SYNTHETIC_TEST_DAYS` | no | Text yourself every N **whole** days to prove the delivery path still works. Off unless set; enabling it sends one on the next cron. Costs one text per interval. |
| `DELIVERY_PING_URL` | no (**secret**) | A **second** dead-man check, watching the delivery test alone. Pinged when the test passes, `/fail` when it fails — so notifier rot pages you instead of only reaching a log. Set its period to the test interval, not a minute. |
| `EXPECT_TEXT` / `FORBID_TEXT` | no | Assert on the page body of a 2xx: page if the expected text is missing, or the forbidden text appears. Off unless set, and the body is not read otherwise. Applies to **every** URL in `CHECK_URLS` — see below before using it with more than one. |

A probe counts as **up** on any 2xx/3xx response. A 4xx, a 5xx, a timeout
(10s each), or a refused connection all count as **down** — if your homepage starts
throwing 500s, that's an outage, whatever the TCP handshake thinks. The alert
says which kind of dead it is: *unreachable* when nothing answered, *answered
HTTP 403* when the origin is up but refusing (a WAF rule, a challenge, or a
check URL that's simply wrong).

What gets retried is a probe where the origin **never finished answering** — a
timeout, a refused connection, a DNS failure, or — when a content assertion is
switched on, since the body is not read otherwise — a body that stopped
arriving before it could be checked. A page that arrived in full is telling you
something real, so a 500,
or a whole page genuinely missing its `EXPECT_TEXT`, is not retried; that would
only delay a true page. The retry costs one extra request, and only on a minute
that already failed; healthy runs are unchanged.

Two consequences worth knowing. Detection of a **hard** outage is unchanged —
still `FAIL_THRESHOLD` failed minutes — but a failure *in transit* now means a
failed **pair**, so an origin that answers roughly one probe in two (a flapping
load balancer, a box that is overloaded rather than dead) stays quiet longer
than it used to. An origin that answers `500` is unaffected: that is a
definitive answer, it is never retried, and one of them still fails the minute
outright. The retry buys fewer false pages at the price of being slower to page
a *degraded* origin.

And a minute in which every URL fails *in transit* now costs two probes per URL
— a minute of 4xx or 5xx still costs one, since those are never retried.
Against the free tier's 50-subrequests-per-invocation budget the worst
case is two probes per URL, one notifier call per URL crossing the threshold
per notifier configured, plus the heartbeat ping. With a single notifier that is
**3N + 1**, which first exceeds 50 at seventeen URLs; with both Twilio and a
webhook it is **4N + 1**, which exceeds it at thirteen. Stay a few short of
whichever applies. (The delivery test is not in that count: it only runs on a
completely clean run, so it never coincides with an outage.) Past the cliff a
broad outage exhausts the budget part-way through the run: the probes fit, the
notifier calls queued behind them do not. The heartbeat ping is issued last, so
it is the one that gets dropped — reporting foghorn dead on top of a correct
DOWN alert.

### What `FAIL_THRESHOLD` actually buys

It is `N` consecutive failed **checks, at the cron interval** — not `N` seconds,
and not `N` requests. On the default 1-minute cron, `2` means two consecutive
minutes in which the check failed.

How many requests that took depends on *how* it failed. An origin answering
`500` costs one request per minute, because a definitive answer is never
retried. A path failing in transit costs two, because the retry has to fail as
well. So `2` is somewhere between two and four failed requests, across two cron
ticks either way.

That distinction is the whole reason this project has a
`docs/handoff-2026-08-17-false-down-probe-blips.md`. `2` used to mean two single
probes, and the README used to sell it as "~2 minutes of confirmed downtime" —
wording that quietly assumed probe failures are rare **and independent**.
Measured over 6,550 probes against a healthy origin they were neither rare
enough nor evenly spread. For most of that window the base rate was about one
miss a day; on the day of the false page there were 17, arriving in clusters
(five inside 25 minutes, four inside 21, five inside 22). Under clustering,
"two in a row" stops being a remote coincidence, and foghorn texted that a
server was down when it never was.

The retry is what makes `2` honest again for that class, because there it is the
*pair* that has to fail. Raise it to `3` if you are running a longer cron interval — the retry's
protection is per-check, so a 5-minute cron gets far fewer of them — or if you
know the path to your origin is noisy. Every step costs one more cron interval
of detection latency on a real outage, which is the only thing you are buying
with it.

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

### Reading the log — did it actually page?

Every alert that leaves the building writes one line, so the paging history is
queryable instead of inferred. Filter your Workers logs for:

```
Foghorn: paged
```

You get one line per DOWN, one per UP, and one per synthetic delivery test:

```
Foghorn: paged DOWN for example.com after 2 failed checks.
Foghorn: paged UP for example.com.
Foghorn: paged the scheduled delivery test.
```

This exists because foghorn used to log only when a send **failed**. A delivered
page left no trace of its own, so "did it page, and when?" could not be answered
from the Worker at all — you had to infer it from how long each run took, or go
read the watched server's own access log, which foghorn usually cannot reach.

Three things worth knowing before you trust it:

- **It means "a notifier accepted this", not "the phone rang".** With Twilio
  *and* a webhook configured, either one succeeding is enough to write the line.
  A rotated Twilio token leaves the line standing while only the webhook fired —
  the adjacent `Twilio send failed` error is what tells them apart.
- **No notifier configured writes no line.** `notify()` reports whether anything
  accepted the alert, and that is the only gate; the existing
  `no notifier configured — dropped alert` error already covers that case, and
  claiming a page there would be a lie.
- **Only the host is logged**, never the path or query, so a check URL carrying
  a token or credentials cannot end up in retained logs. (This does not sanitise
  the SMS, which is length-clamped but not stripped — the log is the copy that
  persists and stays queryable.)

The line rides `console.warn`, the same level as the rescued-probe line, so one
filter shows the whole story of a bad night: which minutes were saved by the
retry, and which actually woke you.

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
before it can prove what it was looking for, the probe fails rather than
assuming the page was clean — an absence you cannot prove is a miss. Only an
absence, though: a needle that already appeared in the part which did arrive is
proof either way. `EXPECT_TEXT` found, with no `FORBID_TEXT` set, passes; a
`FORBID_TEXT` needle found fails outright, whether or not the rest arrived.

The unprovable case counts as **transport**, not as a wrong page, because the
origin never finished answering: it is retried once like any other, and a body
that truncates on both attempts is what reaches the streak.

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
