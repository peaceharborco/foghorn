# Foghorn hardening: make the dead-man alarm harder to fool

**Status:** design, rev 1 — not reviewed, not implemented
**Repo:** `foghorn` (Cloudflare Worker, cron-triggered)
**Origin:** scoped out of `swatter`'s
`docs/superpowers/specs/2026-08-12-outage-corroboration-design.md` §5, after two
adversarial reviews cut half of what was originally proposed there.

## §0. What foghorn is, and what it actually does today

One file, 198 lines, one cron trigger a minute. Its whole purpose: **text the
operator when the server is down.** Not a status page. The hardening below must
not turn it into one.

Grounded in `src/index.ts` as it stands:

- `scheduled` is the ONLY export. There is no `fetch` handler, so nothing can ask
  foghorn anything (`:40-55`).
- `CHECK_URLS` accepts a comma-separated list and is currently one value —
  `https://cds1.peaceharborhosting.com`, the server hostname (`wrangler.jsonc`).
- `isReachable` GETs the URL with `?_cb=<epoch>`, 10s timeout, and treats
  **2xx/3xx as up, everything else — including every 4xx — as down** (`:125-138`).
- State is `{status, fails}` under `state:<url>` (`:33-36`, `:103-105`). **No
  timestamps of any kind are stored.**
- Alerts fire once per transition, and `notify` throws only when *every*
  configured notifier fails, so the state write is skipped and the alert retries
  next minute (`:140-162`). That is the best-designed part of the file and this
  spec does not touch it.
- The README claims a healthy server costs **zero** KV writes. True only when
  fully healthy: a sub-threshold failure streak writes on the way up and again on
  recovery (`:84`, `:66-69`).

## §1. What "hardening" means here

An alarm has exactly two ways to fail, and they are not equally bad:

- **False page** — it cries wolf. Costs trust, and trust is what makes the
  operator get up at 3am for the real one.
- **Missed page** — it stays quiet while the server is down. Unrecoverable.

Everything below is ranked by how much of the second it removes. Where they
conflict, the missed page wins.

## §2. The changes

### §2.1 The watchdog can die silently — this is the biggest hole

**Nothing watches foghorn.** If the cron trigger is removed, the Worker fails to
deploy, the account is suspended, KV or Twilio credentials rot, or a code change
throws before the first `fetch`, the result is indistinguishable from a healthy
server: **silence**. A dead-man alarm whose own death is silent is not a dead-man
alarm.

This is the one gap where "I don't like weak sauce" actually bites, and it costs
almost nothing to close. Two candidates, not mutually exclusive:

1. **Outbound heartbeat.** After a successful check cycle, ping a third-party
   dead-man service (healthchecks.io and equivalents have free tiers) that texts
   or emails when the ping *stops*. The alarm on the alarm lives outside
   Cloudflare, so a Cloudflare-wide failure is covered too. One extra subrequest
   a minute; cheap. Introduces a third-party dependency whose own silence is
   again unwatched, but the chain has to end somewhere.
2. **The origin notices the silence.** cds1 already runs swatter with a nightly
   digest. Foghorn's probes land in `/etc/apache2/logs/access_log` (**not** the
   per-vhost domlogs — see §3), so swatter can cheaply assert "foghorn probed me
   at least N times in the last hour" and surface its absence in the digest. This
   detects a dead foghorn without a third party — but only once a night, and not
   at all if the origin is itself down (in which case foghorn should have paged,
   which is the case we cannot verify this way).

**Recommendation:** do (1) as the real fix and (2) as the cheap nightly
cross-check. They fail in different directions, which is the point.

### §2.2 The edge can serve a page over a dead origin

`isReachable` cache-busts with a query parameter, which defeats ordinary caching
but **not** Cloudflare Always Online, `stale-if-error`, or a custom "serve stale
on 5xx" rule. In those modes the edge answers 200 from its own copy while the
origin is unreachable, and foghorn reports UP. This is the failure the original
proposal tried to fix with a content assertion, which does not fix it at all: a
stale-but-healthy cached page passes any content check you write.

Two fixes, cheapest first:

1. **Assert on `CF-Cache-Status`.** Any proxied response carries it. If it comes
   back `HIT`, `STALE`, `UPDATING`, `REVALIDATED` or `EXPIRED`, the response
   proves nothing about the origin and the check should not count as UP. This is
   a few lines, needs no zone configuration, and directly detects the masking
   case. **Decide deliberately** whether an edge-served response counts as a
   failure (louder, risks paging when the origin is fine but the edge is caching)
   or as "no information" (quieter, but a persistently cached path would then
   never produce a verdict at all — that is a missed page, so prefer failure with
   a distinct message).
2. **Probe the origin directly.** Cloudflare's `cf.resolveOverride` sends the
   request to a chosen origin while keeping the hostname and TLS intact — this is
   the correct mechanism, **not** a `Host:` header against a raw IP, which fails
   certificate validation. **Open question that must be settled before building:**
   `resolveOverride` is documented as working for hostnames within the same zone
   as the Worker, and foghorn today is deployed with a cron trigger and no route.
   Verify whether it applies to this deployment shape at all; if it does not, the
   fallback is a dedicated origin-only hostname (a DNS-only "grey cloud" record
   such as `origin.cds1.…`) that foghorn checks alongside the proxied one. That
   fallback is simpler, needs no Worker-side tricks, and makes "edge up / origin
   dead" trivially visible as two independent check results.

**Interaction with origin-lock, which must be checked before deploying:** cds1
DROPs :443 from non-Cloudflare addresses. Worker egress is Cloudflare, so a
direct probe is expected to pass the lock — but a DNS-only hostname resolves to
the raw origin IP and a probe to it is exactly what origin-lock exists to count.
Confirm against `swatter origin-lock status` and the `cf_origin4` ipset before
enabling, or foghorn will page continuously about a server that is fine.

### §2.3 Foghorn does not identify itself

Workers `fetch` sends no `User-Agent` unless one is set (verify at implementation
time). Its probes therefore appear in the origin logs as **empty-UA requests
every 60 seconds, cache-busted** — which is, almost exactly, the shape of an
abusive scanner. Swatter's own corroboration lookup now classifies an absent user
agent as a bot signal, and swatter's abuse plane treats empty-UA cache-busted
floods as a `request_flood` pattern.

Set a real UA: `Foghorn/1.0 (+https://github.com/peaceharborco/foghorn)`. One
line, and it makes every downstream log forensic easier. **This should land
first** — it is free and it de-risks §2.4.

### §2.4 Every 4xx currently reads as "the server is down"

`resp.status >= 200 && resp.status < 400` (`:134`) means a 404, a 403 from a WAF
rule, or a 429 rate-limit pages the operator with "appears DOWN". A server
returning 404 is emphatically **not** down — it answered.

This is a false-page source and it is aggravated by anything that starts blocking
the Worker (a new WAF rule, a bot-fight setting, swatter itself if the check URL
is ever pointed somewhere it ingests). Options:

- Treat 4xx as **up** (the server answered) — least surprising, but then a
  misconfigured check URL fails silently forever, which is a missed page.
- Treat 4xx as up **for reachability** but alert once, distinctly, on a persistent
  4xx: *"foghorn's check URL returns 404 — the alarm may not be watching what you
  think."* This keeps the dead-man property while removing the false page.

**Recommendation:** the second. The distinction the current code misses is
"unreachable" versus "reachable and unhappy", and only the first is an outage.

### §2.5 A read-only state endpoint

So swatter's digest can cite foghorn ("foghorn saw the origin as UP throughout
this window") rather than guessing. A `fetch` handler returning per-URL
`{status, since, last_transition}`, gated by a bearer token held as a Worker
secret and compared in constant time.

Two things the original proposal understated:

- **This is a schema change, not just a handler.** The stored state is
  `{status, fails}` with no timestamps (`:33-36`), so `since` cannot be
  reconstructed from what exists — it has to start being written, and old entries
  will have no history.
- **It is a new public HTTP surface** on a Worker that currently has none, in a
  repo whose README explicitly declines status-page features. Keep it to the
  minimum: one path, token required, no listing of URLs the caller did not name,
  no error detail, and a rate limit. If it cannot be kept that small, drop it —
  the digest can live without it.

### §2.6 Content assertion — narrow, and not what it was sold as

`EXPECT_TEXT` / `FORBID_TEXT` per URL. Worth having for exactly one case: an
origin that answers **200 with an error body** (WordPress's "There has been a
critical error on this website" is usually a 500, but plugin error handlers and
maintenance pages routinely return 200). It does **not** address edge caching —
§2.2 does — and a homepage copy change will cause a false page, so it must be
opt-in per URL and default off.

## §3. Explicitly NOT doing: watching customer sites on the SMS path

The original §5 proposed pointing `CHECK_URLS` at three or four customer vhosts.
Cut, for two reasons:

1. **It changes the product.** One flaky tenant pages the operator at 3am about
   someone else's WordPress, and the false-page rate scales with the least
   reliable customer. "The box is dead" and "a site is sad" are different alarms
   and want different channels.
2. **It reopens a closed constraint in another repo.** swatter's `TODO.md` and the
   2026-08-04 handoff closed the `monitoring.cidr` gate-D precondition as
   *correctly empty*, on the explicit condition that foghorn is never pointed at a
   customer vhost — because its ~1,440/day cache-busted probes would then land in
   `DOMLOGS_GLOB` and read as a `request_flood`. Pointing it at customer sites
   silently reopens a gate-D item.

If per-site checking is ever wanted, it belongs on a **separate quieter channel**
(webhook or the nightly digest), never the dead-man SMS.

## §4. Cost and limits

Cloudflare free tier: 1,000 KV writes/day, 100,000 reads/day, and the Worker is
already at ~1,440 reads/day per URL. Adding a heartbeat is one subrequest per
minute. Writing a timestamp on every transition does not change the write
profile meaningfully — transitions are rare. **The thing to avoid is writing
state on every run**, which §2.5's `since` field could tempt: store it only when
the status actually changes.

## §5. Sequencing

1. §2.3 user agent. One line, no behaviour change, de-risks everything after.
2. §2.4 4xx handling, with the distinct "check URL is wrong" alert.
3. §2.1 heartbeat — the largest real gain.
4. §2.2 `CF-Cache-Status` assertion, then the origin-probe question settled by
   experiment before any code.
5. §2.5 state endpoint, only if it stays minimal.
6. §2.6 content assertion, opt-in, default off.

Each step is independently testable against the existing vitest suite
(`test/index.test.ts`, 279 lines) and independently deployable. **Per the swatter
repo's rule, and because the same failure mode applies here: `/grok` this design
before implementing it, and again over the diff before `wrangler deploy`.**
Deploys are operator-run.

## §6. Known limitations, recorded so nobody rediscovers them

- **A single Cloudflare region checking a single URL is one vantage point.** A
  regional routing failure between Cloudflare and the origin reads as an outage;
  a failure that spares that path reads as healthy. Multi-region checking is
  outside what a cron Worker does well.
- **A minute of granularity means up to a minute of blindness**, plus
  `FAIL_THRESHOLD` minutes before the first page. Deliberate: the threshold is
  what keeps a single blip from paging.
- **Nothing here detects a slow server**, only an unreachable one. A 9-second
  response passes the 10s timeout and reports UP.
- **The alarm chain ends somewhere.** A heartbeat service watches foghorn; nothing
  watches the heartbeat service.
