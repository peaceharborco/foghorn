# Foghorn hardening: make the dead-man alarm harder to fool

**Status:** **rev 3** — steps 1–4 BUILT AND DEPLOYED across five gate rounds;
step 5 run as an experiment and its outcome CANCELLED it and deferred step 6.
Read §0.5 first: it corrects rev 2's central premise about §2.2. Below is rev 2
as reviewed, preserved so the corrections are legible against it.

Rev 2 status — rev 1 reviewed by four adversarial passes
(grok-4.6 and grok-4.5, each under a correctness and a safety lens; all four
EXECUTE-WITH-FIXES). Four Blockers, and several were errors in rev 1's claims
about swatter's code. See `2026-08-12-hardening-design-review-grok.md`.
**Repo:** `foghorn` (Cloudflare Worker, cron-triggered)
**Origin:** scoped out of `swatter`'s
`docs/superpowers/specs/2026-08-12-outage-corroboration-design.md` §5, after two
adversarial reviews cut half of what was originally proposed there.

## §0.5 REV 3 AMENDMENT — §2.2's premise is wrong for the URL we actually watch

**Settled empirically 2026-08-12, which is what §5 step 5 existed to do. The
answer was "do not write the code."**

`cds1.peaceharborhosting.com` is **DNS-only (grey cloud)**. It resolves to
`67.225.133.76` — the origin, and the same address as the operator's SSH host —
which is in no range published at `cloudflare.com/ips-v4`. The zone *is* on
Cloudflare (`lucy`/`paul.ns.cloudflare.com`), so this is a per-record grey
cloud, not a zone that left. Two adversarial falsification passes closed every
alternative: BYOIP, Magic Transit, `enforce_dns_only`, an orange A/AAAA sibling,
a CNAME landing on a proxied name, Spectrum. Both authoritative nameservers and
three public resolvers agree, TTL 300. A non-Cloudflare client TCP-handshakes
that Liquid Web address and then dies in TLS — origin-lock, not an edge.

**So there is no Cloudflare edge in front of cds1.** Always Online,
`stale-if-error` and Cache-Everything cannot serve a page over a dead origin on
this hostname, because they only ever fire on proxy-generated 520–527. Foghorn
has been probing the origin directly all along.

Consequences:

- **§2.2's second fix and §5 step 5 are CANCELLED.** The `resolveOverride`
  experiment, the `origin.cds1.…` grey-cloud hostname, and §7 question 2 all
  die with it. Question 2 was moot regardless: `cds1` already publishes the
  origin IP. Cloudflare's own docs settle the mechanism anyway —
  `resolveOverride` "will only take effect if both the URL host and the host
  specified by `resolveOverride` are within your zone" and is otherwise
  "ignored for security reasons", and a cron-only Worker has no zone at all.
- **§2.2's first fix (`CF-Cache-Status`) is DEFERRED, not cancelled.** A Worker
  subrequest reads through a Cloudflare cache *even for a DNS-only hostname*,
  because the name still belongs to a Cloudflare zone. The header can still
  appear. Build it if the trigger below fires.
- **DONE INSTEAD — the two cheap levers rev 2 listed and never sequenced.**
  `cache: "no-store"` and `redirect: "manual"` on the probe. `no-store` closes
  the subrequest-cache residual outright. `redirect: "manual"` is narrower than
  it looks: it stops foghorn scoring a *different host's* response as though it
  were the origin's, but it does **not** rescue the orange-apex case — an edge
  301 is a 3xx and still reads up. It also trades one quiet failure for another;
  the matrix is in §6. Neither lever substitutes for the DNS-only policy.

**TRIGGER THAT REOPENS ALL OF THIS:** every host in `CHECK_URLS` must be
DNS-only. Point it at a proxied host and §2.2 becomes live again immediately.
This is not hypothetical — see the amendment to §3 below.

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

**Nothing PAGES when foghorn dies.** If the cron trigger is removed, the Worker
fails to deploy, the account is suspended, KV or Twilio credentials rot, or a code
change throws before the first `fetch`, the result is indistinguishable from a
healthy server: **silence**. (Observability is enabled in `wrangler.jsonc:5` and
Cloudflare retains logs and the last ~100 cron invocations, so the evidence exists
in a dashboard nobody is looking at during an outage. "Nothing watches it" was
rev 1's overstatement; "nothing tells anyone" is the accurate claim.) A dead-man alarm whose own death is silent is not a dead-man
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

**The ping contract, which rev 1 left as one sentence and every reading of it was
broken:**

- Ping **whenever the handler ran to completion**, including runs where the origin
  was DOWN and runs where a notifier failed. Gating the ping on the origin being
  up means a real outage stops the heartbeat and the third party pages "foghorn is
  dead" while Twilio is correctly firing DOWN — two alarms, one of them lying.
- The ping must **never throw into `checkOne`**. `notify()` deliberately rethrows
  so a failed alert skips `saveState` and retries (`:140-162`); a heartbeat that
  can throw becomes a second, accidental way to skip that write.
- The empty-`CHECK_URLS` path returns without throwing (`:43-46`). It must **not**
  ping — otherwise foghorn heartbeats healthily while watching nothing.
- The ping URL is a capability URL: `wrangler secret`, not `vars`.

**What it detects:** cron removed or silently skipped, a deploy that throws, an
account suspension, a missing KV binding. **What it does not:** an unconfigured or
misconfigured check URL, an edge serving Always Online, and — most importantly —
**notifier credential rot**. A heartbeat proves the Worker ran; it proves nothing
about whether Twilio would deliver. If the auth token is rotated or the account
lapses, foghorn stays "healthy" and the first you learn is a missed outage. Only a
**periodic synthetic send** (monthly, distinctly worded) tests the delivery path.
That belongs in this spec and was missing from rev 1.

Also: if the heartbeat provider texts via Twilio too, a Twilio outage takes both
alarms down at once. Prefer a provider whose delivery path differs from foghorn's.

### §2.2 The edge can serve a page over a dead origin

`isReachable` cache-busts with a query parameter, which defeats ordinary caching
but **not** Cloudflare Always Online, `stale-if-error`, or a custom "serve stale
on 5xx" rule. In those modes the edge answers 200 from its own copy while the
origin is unreachable, and foghorn reports UP. This is the failure the original
proposal tried to fix with a content assertion, which does not fix it at all: a
stale-but-healthy cached page passes any content check you write.

Two fixes, and rev 1 had the cheap one factually wrong.

1. **Assert on `CF-Cache-Status` — with the right table.** Rev 1 listed
   `REVALIDATED` and `EXPIRED` as uninformative. They are the opposite: both mean
   the origin *was* contacted, so shipping rev 1's list would have paged on
   ordinary cache revalidation.

   | Value | Origin contacted? | Reading |
   |---|---|---|
   | `HIT` | No | No information about the origin |
   | `STALE` | No — could not be reached | **The dead-origin case** |
   | `UPDATING` | Background revalidation | Origin may be fine |
   | `REVALIDATED` | Yes (304) | Origin is **up** |
   | `EXPIRED` | Yes (fresh body) | Origin is **up** |
   | `DYNAMIC` / `MISS` / `BYPASS` | Yes | Origin is **up** |

   Two more rev 1 overclaims: the header is **not** on every proxied response
   (uncached HTML is `DYNAMIC`; WAF blocks and redirects can log `NONE`/`UNKNOWN`),
   and cache-busting already makes `HIT`/`STALE` unlikely because default cache
   keys include the query string. **The residual mask is Always Online** or a
   Cache-Everything / ignore-query rule — a much narrower target than rev 1 implied.

   **Fail direction, which rev 1 never specified:** a missing or unrecognized value
   must **fail open** — treat as up, draw no conclusion from this signal. Failing
   closed on an absent header pages on every `DYNAMIC` response and would break
   every existing test.

   Two levers rev 1 missed and which may do the job more directly:
   `fetch(..., { cache: "no-store" })`, and `redirect: "manual"` — the default
   `follow` can turn a 302 onto an Always-Online property into a final 200.

2. **Probe the origin directly — but not the way rev 1 said.**
   `cf.resolveOverride` requires both the request host and the override host to be
   **in the Worker's own zone** and is **silently ignored** otherwise. Foghorn is
   cron-only with no route (`wrangler.jsonc:7-10`) and a cron invocation has no
   zone request, so the likely outcome is believing you are probing the origin
   while still hitting the edge. A silent no-op is worse than not trying.

   **The mechanism that actually works is a grey-cloud (DNS-only) hostname** such
   as `origin.cds1.…`, checked alongside the proxied one — two independent results
   make "edge up / origin dead" trivially visible. It needs a **certificate
   covering that name**; rev 1 omitted that, and a missing cert produces a
   permanent false DOWN.

**Origin-lock, corrected.** Rev 1 warned the probe would be dropped. That has the
packet field backwards: `lib/origin_lock.sh` ACCEPTs Cloudflare **source** IPs to
:443 and drops the rest, and Worker egress *is* Cloudflare — the 2026-08-04 handoff
records foghorn arriving from `162.158.163.234`, `172.68.87.x`, `172.69.40.x`. A
probe to a grey-cloud name should be **accepted**. Run `swatter origin-lock status`
as a preflight anyway, but expect it to pass.

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

`resp.status >= 200 && resp.status < 400` (`:134`) means a 404, a WAF 403, a Bot
Fight challenge or a 429 pages the operator with "appears DOWN".

**Rev 1 proposed treating 4xx as up. Rejected** — two reviewers showed it trades a
missed page for fewer false pages, which inverts §1. An origin returning 403 to
*everyone* (a WAF misfire, Under Attack mode, an expired challenge cert) is down as
far as customers are concerned, and rev 1 would have made that permanently silent.
Rev 1's "alert once on a persistent 4xx" is also **unbuildable on the current
schema**: `{status, fails}` (`:33-36`) has no field for "already mentioned", so
"once" degrades to every minute or never again.

**Rev 2 changes only the WORDING, not the up/down logic.** A 4xx still counts as
DOWN — no missed-page risk — but the alert distinguishes *answered with 4xx* from
*unreachable*: "cds1 answered 403 to foghorn's check — the origin is up but
refusing the alarm, or the check URL is wrong." Same page, far better first
sentence, zero schema change, zero new silence.

A genuinely different persistent-4xx behaviour needs an explicit state field and
belongs in its own change.

### §2.5 A read-only state endpoint — DROPPED on the Free plan

Rev 1 proposed a token-gated `fetch` handler so swatter's digest could cite
foghorn. **Cut**, on a limit rev 1 never counted: the Free plan allows **100,000
Worker invocations/day**, and adding a `fetch` handler publishes a `*.workers.dev`
URL. Rejected requests still consume invocations, so anyone who finds that URL can
burn the daily cap, trigger Error 1027, and **stop the scheduled runs** — the exact
silent death §2.1 exists to detect. In-Worker rate limiting cannot help (the
invocation is already spent), and cross-isolate limiting needs KV writes that fight
the write budget.

It is also a schema change: state is `{status, fails}` with no timestamps
(`:33-36`), so `since` cannot be reconstructed and would have to start being
written.

Revisit only if the Worker moves to a paid plan, or via a mechanism with no public
surface — foghorn *pushing* its state to swatter rather than swatter pulling.

### §2.6 Content assertion — narrow, and not what it was sold as

`EXPECT_TEXT` / `FORBID_TEXT` per URL. Worth having for exactly one case: an
origin that answers **200 with an error body** (WordPress's "There has been a
critical error on this website" is usually a 500, but plugin error handlers and
maintenance pages routinely return 200). It does **not** address edge caching —
§2.2 does — and a homepage copy change will cause a false page, so it must be
opt-in per URL and default off.

## §3. Explicitly NOT doing: watching customer sites on the SMS path

**REV 3 AMENDMENT — this section has a hole, and it is live.** It forbids
*customer* vhosts. It says nothing about the operator's **own** proxied
properties, and those are the §2.2 trap sitting one hostname away:
`peaceharborhosting.com` and `www` are orange and **301 at the edge** to
`hosting.peaceharbor.com`, which is also orange and already serves
`cf-cache-status: REVALIDATED`. `CHECK_URLS` is a comma-separated list. One
edit to "also check the public homepage" puts foghorn on a name the edge can
answer while cds1 is dead — and `redirect: "follow"`, the fetch default, turns
that 301 into a final 200.

**`redirect: "manual"` does NOT close this.** An earlier draft of this paragraph
claimed it did; that was wrong and a reviewer caught it. The edge 301 is a 3xx,
`checkReachable` counts any 3xx as up, and the result is the same silent UP. The
deferred `CF-Cache-Status` check would not catch it either — that 301 carries no
such header, and §2.2 specifies fail-open on a missing value.

**The only thing that closes it is the policy: every `CHECK_URLS` host stays
DNS-only.** That rule is not enforced in code, so it lives or dies by being
read. If enforcement is ever wanted, the cheap version is to flag a probe
response carrying `cf-ray` — that means the host is proxied and §2.2 is live —
which is a far smaller change than the full cache-status table.

The original §5 proposed pointing `CHECK_URLS` at three or four customer vhosts.
Cut, for two reasons:

1. **It changes the product.** One flaky tenant pages the operator at 3am about
   someone else's WordPress, and the false-page rate scales with the least
   reliable customer. "The box is dead" and "a site is sad" are different alarms
   and want different channels.
2. **It touches a closed gate-D item in swatter — though not for the reason rev 1
   gave.** swatter's `TODO.md` and the 2026-08-04 handoff closed the
   `monitoring.cidr` precondition as *correctly empty*, partly on the basis that
   foghorn never probes a customer vhost. Rev 1 repeated the stated mechanism —
   1,440 cache-busted probes reading as a `request_flood` — and **that mechanism is
   wrong**, verified in swatter's own code:
   - `request_flood` needs `rps >= RATE_SAT(8) && n >= 60` (`lib/score.awk:254`).
     Foghorn at one request a minute is ~10 hits per 600s window, 0.017 rps. It
     cannot come close.
   - `scanner_profile` needs `ndist >= 25` and a majority of errors. Foghorn hits
     one path and gets 200s.
   - `ACCESS_LOG` **is** ingested (`lib/ingest.sh:191`, default `lib/common.sh:45`).
     The "swatter never reads that log" half of the handoff note is false —
     foghorn is unbannable because it arrives from Cloudflare ranges, full stop.

   So the *policy* holds and reason 1 alone carries it. Do not implement or
   document a `monitoring.cidr` reopen on a scoring story the scorer cannot
   produce. (This correction belongs back in swatter's handoff too.)

## §4. Cost and limits

Cloudflare free tier: 1,000 KV writes/day, 100,000 KV reads/day, and — the limit
rev 1 missed, which is what kills §2.5 — **100,000 Worker invocations/day**, past
which Error 1027 stops the scheduled runs entirely. The Worker is already at
~1,440 KV reads/day per URL (one `loadState` per cron per URL). Adding a heartbeat is one subrequest per
minute. Writing a timestamp on every transition does not change the write
profile meaningfully — transitions are rare. **The thing to avoid is writing
state on every run**, which §2.5's `since` field could tempt: store it only when
the status actually changes.

## §5. Sequencing

Reordered after review: the largest real gain moves ahead of the riskiest change,
and the origin-probe **experiment** precedes any code that depends on its outcome.

1. **§2.3 user agent.** One line, no behaviour change, de-risks every log-side
   interaction downstream. Testable today by asserting on `init.headers`.
2. **§2.4 alert wording.** No logic change, no schema change, removes the "404
   reads as unreachable" confusion.
3. **§2.1 heartbeat**, to the contract spelled out above — the largest reduction
   in missed-page risk. Must include a test that a **DOWN** run still pings.
4. **§2.1 synthetic send**, so notifier credential rot cannot stay invisible.
5. ~~**The origin-probe experiment.**~~ **DONE 2026-08-12, outcome: CANCELLED.**
   cds1 is DNS-only, so there is no edge to probe around. See §0.5.
6. ~~**§2.2 cache-status assertion**~~ **DEFERRED** — fail-open, corrected
   table, build only if a `CHECK_URLS` host is ever proxied. The cheap levers
   (`cache: "no-store"`, `redirect: "manual"`) shipped instead. See §0.5.
7. **§2.6 content assertion**, opt-in, default off.
8. **§2.1(2) swatter-side cross-check** — nightly assertion that foghorn probed at
   least N times. This is work in the *swatter* repo, not this one; rev 1 listed it
   as a fix and then never sequenced it.

**Testability, corrected.** Rev 1 claimed each step was independently testable
against the existing suite. Accurate for the UA and the wording changes. Not for
the rest: `test/index.test.ts:31-41` stubs `fetch` as 200-unless-prefix-matches and
never asserts response headers, so a `CF-Cache-Status` check that failed on a
missing header would break **every existing test** (which is one more reason it
must fail open), and the 4xx work would leave the suite green while covering
nothing new. Each step needs its own stub work; "independently deployable" is the
claim that holds.

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
  watches the heartbeat service. If it delivers via Twilio too, a Twilio outage
  takes both down at once.
- **A JS challenge or Bot Fight response is a 403 to a Worker**, which does not run
  challenge JavaScript. Under Attack mode therefore reads as DOWN, correctly by
  §2.4's rule but for a reason the operator must recognise from the wording.
- ~~**`redirect: "follow"` is the fetch default**~~ — **changed to `manual`
  2026-08-12, which trades one quiet failure for another. Recorded as
  deliberate, per review.** `follow` scored the FINAL response; `manual` scores
  the FIRST HOP, and any 3xx counts as up. So these now read UP where they
  previously paged:

  | First hop | Old (`follow`) | New (`manual`) |
  |---|---|---|
  | 3xx to a host that times out, refuses, or 4xx/5xx | DOWN | **UP, silent** |
  | Redirect loop | DOWN (fetch throws) | **UP, silent** |
  | 3xx onto a cached/Always-Online property | UP (followed 200) | UP (the 3xx) |
  | Connection/TLS/timeout on the first hop | DOWN | DOWN |
  | 4xx / 5xx on the first hop | DOWN | DOWN |

  The trade is intentional. Foghorn asks *"did this origin answer?"*, and a 3xx
  is an answer; `follow` was an accidental deeper check on whether the redirect
  TARGET was alive. **It is a no-op on the deployed URL** — cds1 answers 200
  (`access_log`: `"GET /?_cb=… HTTP/2.0" 200 163`), so there is no first-hop
  redirect to score. It becomes live the moment a `CHECK_URLS` host starts
  redirecting, and at that point the right fix is to check the redirect target
  as its own `CHECK_URLS` entry rather than to restore `follow`.
- **An empty `CHECK_URLS` returns without throwing** (`:43-46`) — foghorn watching
  nothing looks exactly like foghorn watching a healthy server, which is why the
  heartbeat must not ping on that path.
- **`notify()` with no notifier configured logs and returns without throwing**
  (`:154-157`), so a misconfigured foghorn drops alerts silently.
- **Cloudflare cron can silently skip runs.** The heartbeat is the detector for
  that; nothing in foghorn itself would notice.
