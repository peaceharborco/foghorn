# Findings — the retry is live; item 3 held at 10 s (provisionally); the real fault is the path

**Repo:** `foghorn` · **Worker:** `down-detector`, version `93a7274a-783f-4b36-aeca-8963de4174ee`
(deployed 2026-08-17 16:06:56 UTC, replacing `e2f54d2c` which had run since 2026-08-13)
**Status:** retry shipped and deployed; `CHECK_TIMEOUT_MS` **unchanged at 10 s**.
**Reads on from:** `handoff-2026-08-17-false-down-probe-blips.md`, and corrects one of its claims.

| | |
|---|---|
| **Shipped** | One in-run retry before a **transport** failure counts (`e04ef06`). Proposal 1 of the prior handoff. Only a no-status failure or a body that stopped arriving is retried; a 4xx, 5xx, or finished wrong page still fails on the first attempt. |
| **Item 2** | `FAIL_THRESHOLD` stays `2`. **Settled 2026-08-20** — the case for `3` rested on a premise the 08-18 data killed. See the update below. |
| **Item 3** | **Held at 10 s, provisionally.** Its premise ("a slow-but-alive origin") is wrong — but the case for *never* raising it is weaker than it first looked. See "What this does not settle". |
| **Item 4** | README rewritten to say what a threshold actually buys. |
| **Still open** | Why the Cloudflare→origin path degraded — ~4 h on 2026-08-17 and **~12 h on 2026-08-18**. **Not a foghorn problem**, and the owner closed this line on 2026-08-20. |
| ~~**Not yet proven**~~ | **Proven 2026-08-20**: 17 rescues observed, console output confirmed indexed. On 08-18 it carried a **12 h** episode to **zero** false pages, against 3 on the pre-retry 4 h episode — while still leaving 24 minutes where both attempts failed. See the update below. |

## Correction — the ~28 s was the path, not the origin

The prior handoff reads the `:55:10` → `:55:38` gap as a slow origin, and item 3 follows from that.
That reading is wrong.

- `_cb` is stamped when the **Worker** builds the URL (`Date.now()` in `probeOnce`).
- Apache's `%t` under `combined` records **when the request was received**.
  (Confirmed: `LogFormat "%a %l %u %t \"%r\" %>s %b ..." combined` — note there is **no `%D`/`%T`**,
  so this server records no service time at all.)

The event is still in the live log, and it is the one the sibling described:

```
172.71.81.55 - - [17/Aug/2026:12:55:38 +0000] "GET /?_cb=1786971310636 HTTP/2.0" 200 - "-" "Foghorn/1.0 ..."
```

`_cb` = 12:55:10, received 12:55:38 — **28 s before Apache saw it**, then answered with zero bytes
because the Worker had already hung up. The origin was not slow; the prior handoff measured `:443`
answering in **11 ms** across five samples.

So raising `CHECK_TIMEOUT_MS` does not buy tolerance for a slow *origin*. Whatever it buys, it buys
against a slow **network path**.

Note also: probe source IPs are Cloudflare addresses (`172.71.81.x`). Even though `cds1` is
DNS-only, a Worker subrequest still egresses via Cloudflare's edge, so this path resembles the one
real visitors take to the *proxied* sites on this box.

## The measurement

Window `12/Aug/2026 23:39:25` → `17/Aug/2026 16:19:11` — **4.69 days, 6,739 probes with a parseable
`_cb`, every one HTTP `200`.** (The log grows ~1 line/min, so exact counts drift between queries.)

Response bodies: **6,773 at 163 bytes, 3 logged as `-`** — Apache's notation for *zero bytes sent*,
i.e. the origin answered a client that had already gone. Those three are the class the sibling
called out; one of them is the `:55:38` tell above.

> **Script bug worth not repeating:** an earlier pass tested `bytes == "0"` and reported *no*
> zero-byte responses. Apache writes `-`, not `0`. Test for `-`.

Per-probe path delay (Worker stamp → Apache receipt):

| p99 | p99.9 | max |
|---|---|---|
| 1.65 s | 8.36 s | 39.84 s |

22 probes ≥ 5 s; 6 probes ≥ 10 s.

> **Sub-second percentiles are meaningless here and are deliberately omitted.** Apache's `%t` has
> **one-second resolution**, and the minimum observed delay is **−0.75 s** (clock skew between
> Cloudflare and the origin). The p50 and p90 this method produces (0.06 s, 0.37 s) are
> quantization and skew, not measurements. Trust nothing under ~1 s.

### The timeout tables

Failed probe-minutes, split by cause:

| `CHECK_TIMEOUT_MS` | absent (no log line) | slow (arrived late) | total failed |
|---|---|---|---|
| **10 s (current)** | 24 | 6 | **30** |
| 15 s | 24 | 3 | 27 |
| 20 s | 24 | 2 | 26 |
| 30 s | 24 | 1 | 25 |

Streaks of ≥2 consecutive failed minutes, which is what pages at `FAIL_THRESHOLD = 2`:
**4 at 10 s, 4 at 15 s, 3 at 20 s, 2 at 30 s.**

## What this does NOT settle

An earlier draft of this document closed item 3 on the argument that *"24 of 30 failures are probes
that never reached Apache; no timeout value touches them."* **That argument does not hold, and the
tables above should not be read as if it did.**

1. **The `absent` column is constant by construction, not by evidence.** It is computed as
   "minute bucket with no log line", which cannot vary with a simulated timeout. It is *not*
   demonstrated that a larger `AbortSignal.timeout` would leave those minutes absent. If a
   TCP/TLS handshake is taking longer than the timeout, aborting at 10 s means Apache never
   receives a request at all — and waiting 30 s might let it complete and be logged. Some unknown
   fraction of the 24 could be timeout-induced.
   *Partial counter-evidence:* the 6 late arrivals prove that aborting does **not** always prevent
   arrival — those requests reached Apache 10–39.84 s after the Worker **stamped** them, i.e. up to
   ~29.8 s after it gave up at 10 s. (Mind the reference point: the measured delay is stamp →
   receipt, not abort → receipt. Subtract the timeout to get the post-abort lag.) But we can only
   observe the ones that arrived, so this bounds nothing.

2. **A longer timeout is not strictly dominated by the retry.** An earlier draft claimed the retry
   "addresses it better, because a fresh connection beats waiting longer on a sick one." That is
   unsupported. A longer timeout keeps waiting on the **same in-flight request** — and those 6 late
   arrivals *did* eventually arrive, so a longer timeout would have scored **some of them** `200` on
   the first attempt — five of the six at 30 s, four at 20 s, per the table above. Not all six:
   the 39.84 s outlier outruns every timeout that fits the cron budget.

   The retry does something different: it aborts, sleeps 1 s, and opens a **new** fetch with a
   fresh `_cb` and a fresh 10 s budget. For a *transient* path fault the new connection is
   plausibly better; for a *sustained* one (this episode lasted ~4 hours) it is not shown to be.

3. **`FAIL_THRESHOLD = 3` is not proven unsafe.** The case against it rests on the 3-minute streak
   at 12:54→12:56. But the streak detector is known to overcount: it predicts 4 streaks / 8 texts
   where the operator received **6** (3 pairs). One streak is a phantom and *this document does not
   identify which*. Ground truth is equally consistent with three 2-minute streaks and no 3-minute
   streak — in which case `3` would have suppressed all of them. What is fair to say: the sibling's
   window-wide claim that `3` yields "zero false pages" is **unverified**, not refuted.

The practical consequence: **10 s is a hold, not a settled answer.** It is defensible — 22 of ~6,776
probes exceeded 5 s (0.3%), the budget ceiling caps any increase at ~22 s, and the retry gives
connection-establishment failures a second handshake. But reopening it is legitimate, and should be
done against **live retry data**, not against these tables.

There is also a design argument for 10 s that is independent of the arithmetic: if the
Cloudflare→origin path takes 27 s, the proxied customer sites on `cds1` are degraded too. That may
be a page foghorn *should* send, and a longer timeout would mask it.

## The 2026-08-17 degradation episode

Four candidate streaks, all on the old `e2f54d2c`. Operator reported the texts as arriving "this
morning", consistent with these UTC times falling in the early hours Pacific:

| streak (UTC) | length |
|---|---|
| 09:38 → 09:39 | 2 min |
| 12:54 → 12:56 | 3 min |
| 13:03 → 13:04 | 2 min |
| 13:17 → 13:18 | 2 min |

**Operator received 6 texts** (3 DOWN/UP pairs) — so one of the four above is not real. Text count
is ground truth; absent-minute detection is approximate.

Cloudflare observability shows **at least 15** runs at ~11 s wall time — the 10 s timeout plus
overhead — between roughly 09:51 and 13:26 UTC. That is a floor, not a total: the query was capped
at 25 events. Against a baseline of roughly one miss per day, this was an anomalous day.

Timeline, since it is easy to get backwards: the sibling was committed at **2026-08-17 13:33:49
UTC** (`382a0c0`), which is **after all four streaks**. It saw the elevated miss rate that day and
said so, but counted only absent minutes, so it registered one pair.

## The fix is unexercised — do not read the quiet as proof

- **Last timeout: 13:26:10 UTC.**
- **Deploy: 16:06:56 UTC.**
- That is **2 h 40 m of already-clean running before the new version went live.**

The texts stopped on their own. The path recovered; the fix did not end the episode. It is live,
healthy, and unproven. KV state at time of writing: `{"status":"up","fails":0}`.

Evidence that no rescue has occurred, with its limits stated:

- No post-deploy run exceeds **2,519 ms**, far below the ~13 s a timeout-then-rescue would take.
- A query for log messages containing `retry` returned empty — but **this is weak**: no console
  output of any kind appears in that dataset for the whole window, so it was never confirmed that
  `console.warn` is indexed there at all.
- The 2,519 ms run is *not* a rescue signature: the old version, which cannot retry, produced runs
  at 2,514 / 2,531 / 2,619 / 2,636 ms. It sits inside the no-retry distribution.

## What to do when picking this up

1. **Look for the first rescue.** Filter `down-detector` for `failed in transit, succeeded on
   retry`. First confirm that filter can see console output at all — emit a test log if needed,
   because an empty result currently proves nothing.
   Wall-time signatures, with the caveat that they only cover the timeout subclass:
   - timeout → rescue: **~13–14 s**. Not 11 s: 10 s abort + 1 s backoff is only the floor, and the
     run still does everything a healthy run does (1.2–2.6 s here) on top of it.
   - timeout → retry also fails, and it pages: **~22 s** in practice — the probe pair is 21 s and
     notify plus heartbeat are normally sub-second. **Do not filter for 36 s.** That figure is the
     worst-case *budget* (both notify and heartbeat hanging to their own timeouts) and is what the
     cron-fit arithmetic is built on; it is not what an operator will see, and searching for it
     will miss ordinary paging failures.
   - fast-fail (DNS/refused) → rescue: ~2–3 s, **indistinguishable from a normal slow run**. The
     log line is the only reliable signal for this class.
2. **Chase the path, not the constant.** The unexplained part is why Cloudflare→`cds1` degraded for
   ~4 hours. A 39.8 s max against an origin answering in 11 ms is a routing/provider question,
   outside this repo.
3. **If reopening item 3**, first settle the question this document could not: *how much of the
   absent class is timeout-induced?* That cannot be answered from the origin log alone — it needs
   the Worker side (does a longer timeout reduce absent minutes?), which now means an experiment,
   not an analysis.

## How to re-measure

On the origin (`ssh peaceharbor`, read-only — the host *is* `cds1`, so probes land in the main
`/etc/apache2/logs/access_log`, not a domlog):

```python
import re, calendar, time
pat_t = re.compile(r'\[(\d{2}/\w{3}/\d{4}:\d{2}:\d{2}:\d{2}) ([+-]\d{4})\]')
pat_cb = re.compile(r'_cb=(\d+)')
rows = []
with open('/etc/apache2/logs/access_log', errors='replace') as f:
    for line in f:
        if 'Foghorn/1.0' not in line: continue
        mt, mc = pat_t.search(line), pat_cb.search(line)
        if not (mt and mc): continue
        ep = calendar.timegm(time.strptime(mt.group(1), '%d/%b/%Y:%H:%M:%S'))
        off = mt.group(2)
        ep -= (1 if off[0] == '+' else -1) * (int(off[1:3])*3600 + int(off[3:5])*60)
        cb = int(mc.group(1)) / 1000.0
        rows.append((cb, ep - cb))          # (worker stamp, delay in SECONDS)

# delay is in SECONDS. The slow test is `d >= 10`, i.e. CHECK_TIMEOUT_MS / 1000 —
# comparing against the raw 10_000 constant silently classifies everything as fast.
#   slow    = {int(cb // 60) for cb, d in rows if d >= 10}
#   absent  = every minute bucket between first and last probe with no row at all
#   failed  = absent | slow   -> then find runs of consecutive minutes
```

This builds `rows` only; the tables above need the reduction sketched in the comments. It is a
starting point, not a one-shot reproduction.

Caveats to carry forward:

- The delay measured is **Worker stamp → Apache receipt only**. It excludes Apache processing and
  the return trip, so it is a *lower bound* on round-trip time.
- `%t` resolution is **1 second** and clock skew reaches **±0.75 s**. Ignore anything under ~1 s.
- `time.strptime(..., '%b')` needs an English locale for `Aug`.
- Zero-byte responses log as `-`, not `0`.
- "Absent" conflates *fetch failed* with *cron did not run*, and — per "What this does not settle"
  — with *aborted before the request landed*. Cross-check invocation counts in Workers
  observability for the same window to separate the first two.

---

# Update 2026-08-20 — the retry is exercised, and it does not cover a sustained episode

Three days of live data on `93a7274a`. This closes pickup item 1, settles item 2, and adds a
constraint the original document could not have known.

## Pickup item 1 is closed: console output *is* indexed, and rescues happened

The document warned that an empty `retry` query "currently proves nothing" because no console
output had ever been confirmed in that dataset. It is confirmed now — `$metadata.message` for
`down-detector` holds exactly two distinct values in the post-deploy window:

```
* * * * *
Foghorn: probe of cds1.peaceharborhosting.com failed in transit, succeeded on retry.
```

**17 rescues**, 2026-08-17 17:42 → 2026-08-19 18:58 UTC. The fix works and is no longer unproven.

## But there was a second episode, and the retry did not cover it

2026-08-18, roughly **03:00 → 15:00 UTC** — ~12 hours against the ~4 of 08-17. Worse, not better.

Wall time is cleanly bimodal in the observed data, and the two modes match the signatures this
document predicted:

| mode | observed values (ms) | reading |
|---|---|---|
| rescue | 12,083 · 12,447 · 13,145 · 13,274 · 15,487 | timeout → retry succeeded (~13–14 s, as `eba4678` says) |
| failed check | 18,089 … 22,059 · 22,094 · 22,106 · 22,115 · 22,119 · 22,271 · 23,557 | 10 s abort + 1 s backoff + 10 s abort + overhead |

**24 runs exceeded 18 s**, and *all 24* fall inside that one 08-18 window. Against 4,277 total
cron runs post-deploy.

This answers a question the document left open. It reads: *"For a transient path fault the new
connection is plausibly better; for a sustained one (this episode lasted ~4 hours) it is not
shown to be."* The answer is **yes, but not by rescuing every minute** — see the correction
immediately below, which was written after operator ground truth arrived and supersedes an
earlier, harsher reading of these same numbers.

They also cluster hard. Runs >18 s, 08-18 05:00–14:00 UTC (9-minute buckets):

| bucket (UTC) | count |
|---|---|
| 05:06 | **4** |
| 07:30 | 1 |
| 08:51 | 1 |
| 09:00 | 2 |
| 09:09 | 1 |
| 09:27 | 1 |
| 11:24 | 1 |
| 12:27 | 2 |
| 12:54 | 1 |

## Correction — operator ground truth: the retry *did* cover the episode

**No SMS was received on 2026-08-18** (operator, confirmed 2026-08-20). That is ground truth, and
it is decisive.

An earlier draft of this update concluded from the 24 double-failures that "the retry does not
cover a sustained episode." **That reading was wrong**, because it measured the wrong thing. The
output that matters is *pages*, and there were none — which means **no two failed checks ever
landed on consecutive minutes** across twelve hours.

Run the counterfactual. Every one of the 17 rescued minutes would have been a *failed* minute on
the old `e2f54d2c`. So the sequence the threshold actually saw was 24 failures where, without the
retry, it would have seen **41** — in the same twelve hours, on a path in the same condition.
Removing 17 failures from a sequence is exactly what prevents adjacent pairs from forming.

The comparison that makes the point:

| episode | version | duration | false pages |
|---|---|---|---|
| 2026-08-17 | `e2f54d2c`, no retry | ~4 h | **3** (6 texts) |
| 2026-08-18 | `93a7274a`, retry live | ~12 h | **0** |

Three times the duration, on a worse path, and it went from three false pages to none. **The retry
is doing its job**, and `FAIL_THRESHOLD = 2` rode out a twelve-hour degradation without once
crying wolf.

What remains true from the harsher reading: during a sustained episode the retry does **not** save
every minute — both attempts genuinely fail sometimes, 24 times here. It thins the failures, it
does not eliminate them. Do not expect it to.

## Item 2 settled: `FAIL_THRESHOLD` holds at `2`

`2` has now been **measured** against the worst path conditions on record — twelve hours, 24 failed
checks — and produced **zero** false pages. There is no false-page problem left for `3` to solve.
Raising it would buy nothing and cost one cron interval of detection latency on every real outage,
permanently.

The sibling's case for `3` also rested on *"longest consecutive miss in 6,550 probes is 2, so 3
would have produced zero false pages."* That premise is separately dead: 4 failed checks inside 9
minutes at 05:06 means three consecutive is entirely reachable, so `3` was never the guarantee it
was sold as.

The design argument the document raised as an aside is the stronger one, and the 08-18 data
promotes it: probes egress from Cloudflare edge IPs over the same path the **proxied** customer
sites on `cds1` take. A path on which a two-attempt probe with a 10 s budget each fails outright
24 times in 12 hours is not a healthy path, and visitors were likely seeing timeouts too. Raising
the threshold mutes a true signal about a customer-facing problem.

## New constraint on item 3, and it cuts against raising the timeout

The retry changed the cron-fit arithmetic: the probe phase is now **2 × timeout + backoff**, not
one timeout. At the current 10 s that is the 21 s pair this document already documents. At 20 s it
would be 41 s before notify and heartbeat — which no longer fits the minute with any margin.
**Shipping the retry narrowed the room to raise `CHECK_TIMEOUT_MS`, it did not widen it.**

Item 3 therefore stays held at 10 s, now for a budget reason rather than only a provisional one.

## Cause: not settled, and deliberately dropped

Published incidents were checked and **none explain either episode**:

- **GitHub** (08-17 13:28 → 21:15 UTC, ~8 h, Actions/API/Copilot) — foghorn's 08-17 episode ended
  **13:26**, two minutes *before* this began, and it does not touch 08-18 at all. Ruled out.
- **Cloudflare Phoenix / Los Angeles network performance** (08-17 19:37 → 20:44 UTC) — after both
  episodes, and wrong geography: **`cds1` is 67.225.133.76, Liquid Web, Lansing MI.**
- **Cloudflare ATL (Atlanta) maintenance** (08-18 06:00 → 10:00 UTC) — partial overlap only. Of
  the 14 failed checks measured in 05:00–14:00, **6 fall inside the window and 8 outside**, and
  the worst cluster (4 in 9 minutes at 05:06) precedes it by an hour. Contributory at most.

Remaining suspect is the origin end — Liquid Web's own network, which does routine Lansing↔Chicago
and Chicago/Ashburn POP maintenance. Not chased: **the owner closed this line of inquiry on
2026-08-20.** Reopen only with a reason.

## Caveats on the above

- **The failed-check count is inference, not a log line.** It rests on wall-time bimodality. A
  rescue whose retry succeeded slowly could in principle reach ~21 s (10 + 1 + 10), so the two
  modes are not separated by construction — only by the observed gap between 15,487 and 18,089 ms.
  Treat 24 as ±1–2 at the boundary.
- ~~**It is still unknown whether any of this paged the operator.**~~ **Answered 2026-08-20: no SMS
  was received on 08-18.** See the correction above — this is what turns the threshold hold from a
  judgement call into a measured result.
- The Workers observability MCP tool errors with a schema-validation failure on the `events` view
  for this Worker (`$workers.outcome` missing). Use the `calculations` view. Series values render
  blank for sparse or sub-minute buckets; the aggregate is still correct.

## The one concrete gap this exposed

**Foghorn writes no log line when it successfully sends a DOWN or UP alert** — only when a send
*fails* (`src/index.ts`, the `console.error` calls). That is why the question above could not be
answered from Cloudflare data alone, and why every future investigation of "did it page?" has to
work backwards from wall-time inference.

A single log line on each DOWN and UP transition would make the paging history directly
queryable and cost nothing on healthy runs.

**Implemented 2026-08-20.** `logPaged()` in `src/index.ts` emits one line per DOWN and per UP
transition, and one for the synthetic delivery test. It uses **`console.warn`**, not `console.log`:
this document itself notes above that only `console.warn` was ever *observed* arriving in that
dataset from this Worker, so the paging line rides the channel already proven to land — next to the
rescue line operators query anyway. A page nobody can find is the exact bug being fixed. `notify()` now returns whether any notifier
accepted the alert, and that return value is the sole gate on the line — so it cannot claim a page
that was only dropped on the floor. Fifteen tests cover it: thirteen under "paging is observable"
plus two under "synthetic delivery test". Filter Workers logs for `Foghorn: paged` to read the
paging history directly, instead of inferring it from wall time the way this document had to.

Two limits worth knowing before you trust the line. **"Accepted" is not "delivered to the phone"**:
with Twilio *and* a webhook configured, `notify()` returns true if either succeeds, so a rotated
Twilio token can leave a `paged` line standing while only the webhook fired — the adjacent
`Twilio send failed` error is what tells them apart. And the line is emitted **before** the KV
write, deliberately: a `saveState` failure after a successful send re-pages next run, and logging
after the write would reproduce the exact blind spot this closes, going silent precisely when KV is
sick.
