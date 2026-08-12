# Adversarial review — foghorn hardening design, rev 1

Four passes: **grok-4.6** and **grok-4.5**, each under a correctness lens (A) and
a safety/failure-mode lens (B). All four verdicts: **EXECUTE-WITH-FIXES**. The
convergence was unusually tight — every pass independently found the same three
core defects — and several were errors in claims *I* made about code I had just
written.

Rev 1 is superseded by rev 2.

## Blockers

### 1. The `CF-Cache-Status` value list was factually wrong `[all four]`

Rev 1 §2.2 said a response is uninformative about the origin if the header reads
`HIT`, `STALE`, `UPDATING`, `REVALIDATED` or `EXPIRED`. Two of those are the
opposite:

| Value | Origin contacted? |
|---|---|
| `HIT` | No — no information |
| `STALE` | No — **this is the dead-origin case** |
| `UPDATING` | Background revalidation; origin may be fine |
| `REVALIDATED` | **Yes** (304 from origin) |
| `EXPIRED` | **Yes** (fresh body from origin) |
| `DYNAMIC` / `MISS` / `BYPASS` | Yes |

Shipping the list as written would page on ordinary cache revalidation. Rev 1
also claimed "any proxied response carries it" — uncached HTML is `DYNAMIC`, and
WAF blocks or redirects can log `NONE`/`UNKNOWN`, so the header is not a reliable
"did we reach the origin" bit. And the fail mode for a missing or unexpected value
was never specified, which is the question that decides whether the check fails
open or closed.

Also missed: `isReachable` already appends a unique `?_cb=` (`src/index.ts:127`)
and default cache keys include the query string, so `HIT`/`STALE` are already
unlikely — the residual mask is **Always Online** or a Cache-Everything /
ignore-query rule. Two documented levers rev 1 never mentioned:
`fetch(..., { cache: "no-store" })` and `redirect: "manual"` (default `follow`
can turn a 302 onto an Always-Online property into a final 200).

### 2. The heartbeat contract was one sentence, and every reading of it is broken `[all four]`

Rev 1 §2.1 said only "after a successful check cycle, ping a dead-man service."
It never defined *successful*, so:

- Gate the ping on the origin being **up**, and a real outage stops the heartbeat
  → the third party pages "foghorn is dead" while Twilio is correctly firing DOWN.
- Place it after `Promise.allSettled` where `notify()` rethrows
  (`src/index.ts:51-53`, `:159-161`), and a Twilio outage also stops the heartbeat
  → same false diagnosis.
- Let the ping throw, and it becomes a new way to skip the `saveState` the design
  promised not to touch (`:64-65`, `:81-82`).

The empty-`CHECK_URLS` path returns without throwing (`:43-46`), so a naive
implementation would heartbeat happily **while watching nothing**.

### 3. A public `fetch` handler on the Free plan can silence the cron `[4.6-a, 4.6-b]`

Rev 1 §4 budgeted KV quota but not the Free plan's **100,000 Worker
invocations/day**. Adding a `fetch` handler publishes a `*.workers.dev` URL;
unauthenticated 401s still consume invocations, so anyone who finds it can burn
the daily cap, hit Error 1027, and **stop the scheduled runs** — precisely the
silent death §2.1 exists to detect. In-Worker rate limiting does not help (the
invocation already counted), and cross-isolate limiting needs KV writes, which
fight the write budget. Dropped in rev 2 unless the Worker moves off Free.

### 4. Treating 4xx as "up" trades a missed page for fewer false pages `[4.6-b, 4.5-b]`

Rev 1 §2.4 recommended treating 4xx as reachable. But an origin returning 403 to
*everyone* — a WAF misfire, an expired cert on a challenge page, Under Attack
mode — is down as far as customers are concerned, and rev 1 would have made that
permanently silent. Worse, "alert once on a persistent 4xx" **cannot be built on
the current schema at all**: state is `{status, fails}` (`:33-36`) with no field
for "already mentioned this", so "once" is either every minute or never again.

## Majors

- **`cf.resolveOverride` is silently ignored for this deploy shape** `[all four]`.
  Both the URL host and the override host must be in the Worker's zone, and
  foghorn is cron-only with **no route** (`wrangler.jsonc:7-10`) — a cron
  invocation has no zone request. You would believe you were probing the origin
  while still hitting the edge. The grey-cloud hostname is the real mechanism, and
  it needs a certificate covering that name — which rev 1 omitted.
- **The origin-lock warning pointed at the wrong field** `[4.6-a, 4.6-b, 4.5-a]`.
  `lib/origin_lock.sh` ACCEPTs Cloudflare **source** IPs to :443 and drops the
  rest. Worker egress *is* those IPs — the 2026-08-04 handoff records foghorn
  arriving as `162.158.163.234`, `172.68.87.x`, `172.69.40.x` — so a probe to a
  grey-cloud name should be ACCEPTed. Verifying `origin-lock status` first is
  right; predicting the probe gets dropped is not.
- **The swatter coupling in §3 was wrong in its mechanism** `[all four]`, and I
  verified each correction:
  - `request_flood` requires `rps >= RATE_SAT(8) && n >= 60` (`score.awk:254`).
    Foghorn at 1 req/min is ~10 hits per 600s window, 0.017 rps — **it cannot trip
    that floor**, on a vhost or anywhere else.
  - `ACCESS_LOG` **is** ingested (`lib/ingest.sh:191`, default `common.sh:45`).
    The "swatter never reads that log" half of the gate-D note is false; foghorn
    is unbannable because it arrives from Cloudflare ranges, full stop.
  - `corroborate.sh` puts an absent UA in its own **`noua`** bucket, explicitly
    *not* folded into bot (`:205-206`, `:252`), and only ever classifies **5xx**
    in per-account domlogs — foghorn's 200s never reach it.
  The **policy still stands** on rev 1's first reason (it changes the product and
  scales false pages with the flakiest tenant); the scare story does not.
- **Sequencing put the risky change before the valuable one** `[all four]`, and
  "independently testable against the existing suite" was overstated. The suite
  stubs `fetch` as 200-unless-prefix-matches (`test/index.test.ts:31-41`) and never
  asserts headers; a `CF-Cache-Status` check that fails on a missing header would
  **break every existing test**, and the 4xx change would leave them all green
  while not covering the new behaviour.
- **"Nothing watches foghorn" is overstated** `[4.6-a, 4.5-a]`. `observability`
  is enabled (`wrangler.jsonc:5`) and Cloudflare retains logs and the last ~100
  cron invocations. Nothing *pages*, which is the real point — say that instead.
- **§2.1's "the origin notices the silence" is swatter work** `[4.5-a]` and never
  appeared in rev 1's sequencing at all.

## Minors

- The heartbeat's own outage is a false page, and if the heartbeat service also
  texts via Twilio, a Twilio outage takes down both alarms (common mode).
- Grey-cloud TLS misconfiguration produces a permanent DOWN.
- Cloudflare cron can silently skip; the heartbeat is the right detector for that
  and the spec should say so explicitly.
- `notify()`'s no-notifier-configured path logs and returns **without throwing**
  (`:154-157`), so an unconfigured foghorn drops alerts silently — worth naming.

## My own gap findings, added to rev 2

- **Credential rot is invisible to every proposal here.** A heartbeat proves the
  Worker ran; it proves nothing about whether Twilio would actually deliver. If
  the auth token is rotated or the account lapses, foghorn stays "healthy" and
  the first anyone learns is a missed outage. A periodic synthetic send is the
  only thing that tests the delivery path.
- The heartbeat ping URL is a capability URL and belongs in `wrangler secret`,
  not `vars`.

## What survived

- The §0 line-by-line reading of `src/index.ts` is accurate, including the
  README's "zero KV writes" being true only when *fully* healthy.
- "Workers `fetch` sends no User-Agent" is **confirmed**, with live evidence: the
  08-04 handoff shows foghorn's own probe in cds1's `access_log` with UA `"-"`.
  Setting a UA remains the correct first ship, and `Foghorn/1.0` is not in
  `score.awk`'s suspicious-UA table.
- The KV free-tier figures and the ~1,440 reads/day/URL profile are correct.
- Not putting customer vhosts on the SMS path — right conclusion, wrong reason.
