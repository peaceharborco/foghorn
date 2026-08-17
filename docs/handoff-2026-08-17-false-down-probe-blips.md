# Finding — foghorn paged a false DOWN; `FAIL_THRESHOLD = 2` is too tight for a 60 s probe

**Repo:** `foghorn` · **Worker:** `down-detector`, version `e2f54d2c` (unchanged since 2026-08-13)
**Status:** diagnosed from both sides of the wire, **no code or config changed yet.**
**Severity:** false page, not a missed page. Foghorn's machinery is sound; its threshold is not.

| | |
|---|---|
| **Symptom** | Operator got a DOWN text followed by an UP text. The server was never down. |
| **Cause** | Two consecutive probes failed in transit between the Workers runtime and the origin. `FAIL_THRESHOLD = 2` treats that as confirmed downtime. |
| **Not the cause** | Foghorn itself, the origin, the origin's firewall, the synthetic delivery test, KV, or a missed cron. All four ruled out with evidence below. |
| **The real fix** | One in-run retry before a probe counts as a failure. Kills the class instead of raising the bar on it. |
| **The immediate fix** | `FAIL_THRESHOLD = 3`. Against 6,550 measured probes this sends **zero** false pages. |
| **What made this diagnosable** | The `Foghorn/1.0` probe `User-Agent` shipped in the 2026-08-12 hardening (step 1). Without it the probes were indistinguishable from scanner noise in the origin log and this would have stayed a guess. |

## Evidence — origin side

The watched host is DNS-only, so probes hit the origin directly and land in Apache's access log
under the probe UA. Grepping that UA and parsing each request's `_cb=` value (the run's epoch ms)
gives a per-minute ledger of which probes actually arrived. Over **4.5 days / 6,550 probes**:

| Result | Count |
|---|---|
| `200`, full body | 6,548 |
| `200`, **zero bytes** — origin answering, client already hung up | 2 |
| **Absent from the log entirely** | 20 minutes |

Of the 20 absent minutes, **19 are isolated singles. Exactly one is a consecutive pair.** That
pair is the false page — two failures in a row is precisely the threshold.

One of the two zero-byte responses is the tell: the run started at `:55:10` and its cache-buster
reached Apache at `:55:38`. The origin was answering. The Worker had given up at its 10 s
`CHECK_TIMEOUT_MS` and closed the connection 18 s before the response was written.

## Evidence — Worker side

Cloudflare observability, same window:

- **10,010 invocations in 7 days, every one `outcome: ok`.** Zero exceptions, so no `NotifyError`
  and no machinery fault.
- **1,439 of 1,440 invocations in the last 24 h.** The cron is not missing minutes.
- KV read live: `{"status":"up","fails":0}` — the streak had already cleared.

Cron fired, fetch failed. That is the whole story.

## Ruled out

- **Synthetic delivery test.** `synthetic:ok == synthetic:attempt`, four days old, with a 30-day
  interval — next test is weeks away. Checked first because the README's own warning for
  `DELIVERY_PING_URL` (*"set its period to the test interval, not a minute"*) describes exactly
  this shape of recurring false alarm. It was not this.
- **The origin.** Load ~1.2, ~35 GB free, no `MaxRequestWorkers` event all day, `:443` answering
  in **11 ms** across five samples via both loopback and the public IP.
- **The origin's firewall.** The host runs a Cloudflare-only lock on :80/:443. Its allowlist is an
  exact match for Cloudflare's published IPv4 ranges (15/15, verified against the live API), it
  builds with `ipset add -exist` so there is **no flush window** during a re-apply, no
  Cloudflare-range address has ever appeared in its drop log, and no firewall reload occurred
  during any blip minute. Connection tracking was at 200 of 262,144. This was the leading
  hypothesis and it is dead.
- **Missed crons.** See the invocation counts above.

Conclusion: transient `fetch` failures between the Workers runtime and the origin, never longer
than two minutes.

## The design point, for the project and not just this deployment

`FAIL_THRESHOLD` defaults to `2`, and the README sells that as *"~2 minutes of confirmed
downtime."* That wording assumes probe failures are rare **and independent**. Measured here they
are neither rare enough nor evenly spread: the base rate is ~1 miss/day for most of the window,
but today it was 17, arriving in clusters (five inside 25 minutes, four inside 21, five inside
22). Under clustering, "two in a row" stops being a remote coincidence and becomes a routine
event — which is why the first false page arrived after four quiet days rather than never.

A dead-man alarm that pages a phone should be biased hard toward the false-negative side of one
extra minute, not toward waking someone for a network hiccup. **Two consecutive probes is one
observation repeated, not two independent confirmations.**

## Proposed changes, in priority order

1. **One in-run retry before a probe counts as a failure** *(the fix)*. On a failed fetch, retry
   once — fresh connection, fresh cache-buster, short backoff — and only record a failure if the
   retry also fails. Constraints for whoever implements it:
   - The retry pair must resolve to **one** outcome. It must not increment `fails` twice, and it
     must not write KV twice.
   - Budget the wall clock deliberately. Two 10 s probes plus a 10 s notify plus a 5 s heartbeat
     must stay inside the cron invocation, and **the heartbeat must still be reached** — a retry
     that eats the ping trades a false DOWN for a false "foghorn is dead," which the existing
     heartbeat contract explicitly forbids.
   - Retry only the transport failure, not a definitive answer. A `500`, or a content assertion
     that failed on a `200`, is the origin telling you something real; retrying it just delays
     a true page.
   - It costs one extra request only on minutes that already failed. Healthy runs are unchanged.
2. **Set this deployment's `FAIL_THRESHOLD` to `3`** now, as config, ahead of (1). Longest
   consecutive miss in 6,550 probes is 2, so 3 would have produced zero false pages across the
   whole window. Cost: one additional minute of detection latency on a real outage.
3. **Revisit `CHECK_TIMEOUT_MS = 10_000`.** Not the primary cause, but it is why a slow-but-alive
   origin is indistinguishable from a dead one. At least one probe needed ~28 s end to end.
   Raising it trades detection latency for tolerance and should be decided alongside (1), not
   independently.
4. **Correct the README.** Say what a threshold actually buys — *N consecutive failed probes, at
   the cron interval* — and note that on a 1-minute cron, `2` is sensitive enough that ordinary
   transient network failure can trip it. Recommend `3` as the default for an SMS notifier.

## Explicitly not proposed

- **Do not gate the heartbeat on any of this.** The existing contract stands.
- **Do not add jitter or a delay in front of the DOWN alert.** The point of a dead-man alarm is
  that a real outage pages promptly; the fix belongs in *what counts as a failure*, not in how
  long the alert is held once one is confirmed.
- **Do not suppress repeat DOWN/UP pairs.** That hides the symptom and would mask a genuinely
  flapping origin, which is a thing an operator needs to know about.

## How to re-measure after the change

The probe UA makes this reproducible on any origin whose access log you can read: grep the UA,
extract each request's `_cb=` epoch, reduce to minutes, and diff for gaps. Absent minutes are
probes that never arrived; `200` with a zero byte count is a probe the Worker abandoned. Confirm
against Cloudflare observability that the invocation count for the same window is ~1/minute — that
separates "fetch failed" from "cron didn't run," which is the distinction the whole diagnosis
turns on.
