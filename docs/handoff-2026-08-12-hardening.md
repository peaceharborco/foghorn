# Handoff — foghorn hardening, steps 1–4 shipped (2026-08-12)

**Repo:** `foghorn` · **Worker:** `down-detector`, version `26049c67`, **DEPLOYED**.
**Status:** steps 1–4 of the sequencing below are built, reviewed across three
gate rounds, and live. Steps 5–8 are untouched. 49 tests, typecheck clean.

**Artifacts:** `docs/specs/2026-08-12-hardening-design.md` (rev 2) and its review,
`…-hardening-design-review-grok.md`. Rev 2 is the one to read; rev 1 was wrong in
several places and rev 2 says where.

| | |
|---|---|
| **What foghorn is** | A dead-man alarm: cron Worker, one file, texts the operator when cds1 stops answering. Not a status page — the README declines that on purpose. |
| **Biggest gap found** | Nothing *pages* when foghorn itself dies. §2.1 — now closed by `HEARTBEAT_URL`. |
| **Biggest correction** | Three of rev 1's claims about the `swatter` repo were wrong. §5. |
| **Next to build** | Step 5, the origin-probe experiment. It gates step 6. |

## What shipped, and what it cost to get right

Steps 1–4: probe `User-Agent`, DOWN-alert wording, outbound heartbeat, and a
periodic delivery test. Verified live — foghorn now appears in cds1's
`access_log` as `Foghorn/1.0` (it was UA `"-"` until 23:38:25 UTC).

Also closed spec §2.5's worry: **`workers_dev: false`** (version `3afedd8f`).
The `*.workers.dev` URL served nothing — foghorn is cron-only with no `fetch`
handler — but requests to it still burned invocations, and exceeding the free
tier's 100,000/day stops the cron, which is the silent death the heartbeat
exists to catch. Now `HTTP 404`. Note this lives in `wrangler.jsonc`, which is
**gitignored**, so the deployed config is not in version control; the setting is
mirrored in `wrangler.jsonc.example` so it survives a fresh setup.

**Three `/grok` rounds, and the first two both returned HOLD.** Worth knowing
what they caught, because two of the three Blockers were introduced by the
fixes rather than by the original code:

1. The delivery test **stamped KV before sending**, so a rotated Twilio token
   produced one log line and thirty days of green heartbeats. Now success and
   attempts are recorded separately, retrying hourly.
2. A gap-fix **enabled `SYNTHETIC_TEST_DAYS` in the tracked example**, which
   would have texted anyone following the quick start — and silently answered
   §7's open question 4, which belongs to the operator.
3. Wiring a failed delivery test to **withhold the heartbeat deadlocked**: the
   test is skipped while a URL is down, so nothing could clear the flag and the
   dead-man service would page "foghorn is dead" for a whole outage while
   foghorn was correctly firing DOWN. **Reverted, with a regression test.**
   `src/index.ts` says so at the `Synthetic` interface and at the call site —
   do not re-couple them.

## Live-but-dormant bug: fix before enabling `SYNTHETIC_TEST_DAYS`

Round 3 M3. In `runSyntheticTest`, if `notify()` succeeds and the KV write then
throws, the outer `catch` logs a false `FAILED`; if the retry write also fails,
`attempt` never lands and the hourly brake never engages — a reviewer measured
five texts in five runs. Harmless while the var is unset, which is why it
shipped. **Split the success-write failure from a failed send before turning
that flag on.**

## Also open

- **A failed delivery test pages nobody** — it logs and retries. The fix is
  healthchecks.io's `/fail` endpoint, ideally against a second dedicated check
  so it does not flap the liveness one.

---

## 1. Where this came from

It was §5 of swatter's outage-corroboration design. Two adversarial reviews there
cut half of it, so it was moved into its own spec in this repo rather than shipped
as an afterthought to another repo's work. Four more passes (grok-4.6 and grok-4.5,
each under a correctness and a safety lens) then took rev 1 apart.

Nothing here is urgent. Foghorn works. This is about the ways it could be lying to
you without either of you noticing.

## 2. What rev 2 actually proposes, in build order

1. **Set a User-Agent.** One line. Workers `fetch` sends none, confirmed by live
   evidence — foghorn's own probe appears in cds1's `access_log` with UA `"-"`.
   Land this first; it makes every log-side interaction downstream legible.
2. **Change the DOWN alert wording for a 4xx.** No logic change, no schema change:
   a 404 still counts as down, but the text distinguishes *answered with 403* from
   *unreachable*. Rev 1 wanted to treat 4xx as up; that was rejected as trading a
   missed page for fewer false pages.
3. **Heartbeat to a third-party dead-man service.** The largest real gain. Read
   §2.1's ping contract in the spec **before** writing it — the obvious
   implementations all break in a specific way (gate the ping on the origin being
   up, and a real outage makes the third party page "foghorn is dead" while Twilio
   is correctly firing DOWN).
4. **Periodic synthetic send.** Nothing else tests whether Twilio would actually
   deliver. If the auth token rots, foghorn stays "healthy" until the first missed
   outage.
5. **The origin-probe experiment** — see §3. Blocks step 6.
6. **`CF-Cache-Status` assertion**, fail-open, with rev 2's corrected table.
7. **Content assertion**, opt-in, default off, and only for 200-with-error-body.
8. **Swatter-side cross-check** (nightly "did foghorn probe me?"). Work in the
   *swatter* repo, listed here so it is not lost.

## 3. The experiment that gates step 6 — run this before writing code

Rev 1 assumed `cf.resolveOverride` was the mechanism for probing the origin
directly. It requires both hosts to be in the Worker's own zone and is **silently
ignored** otherwise — and foghorn is cron-only with no route, so a cron invocation
has no zone request. The likely outcome is believing you are probing the origin
while still hitting the edge, which is worse than not trying.

Settle empirically, in this order:

1. Does `resolveOverride` do anything at all from a cron-triggered Worker with no
   route? Assume no until proven.
2. If not: create a grey-cloud (DNS-only) hostname, e.g. `origin.cds1.…`, and
   confirm (a) a certificate covers it, (b) foghorn can reach it, (c) origin-lock
   accepts the probe.

On (c), expect it to **pass**: `swatter`'s `lib/origin_lock.sh` ACCEPTs Cloudflare
**source** IPs to :443 and drops everything else, and Worker egress *is* Cloudflare
— foghorn has been observed arriving as `162.158.163.234`, `172.68.87.x`,
`172.69.40.x`. Rev 1 warned the probe would be dropped; that had the packet field
backwards. Run `swatter origin-lock status` as a preflight anyway.

**Any DNS change goes through `terminal-scripts`**, per the developer-wide rule —
not the dashboard, not from this repo.

## 4. Decisions already made, with reasons — do not silently re-litigate

- **No customer vhosts on the SMS path.** One flaky tenant pages the operator at
  3am about someone else's WordPress, and the false-page rate scales with the
  least reliable customer. If per-site checking is ever wanted it goes on a
  quieter channel.
- **No public `fetch` handler while on the Free plan.** 100,000 invocations/day;
  rejected 401s still count; anyone who finds the `workers.dev` URL can burn the
  cap, hit Error 1027, and **stop the cron** — the exact silent death the heartbeat
  exists to detect. Revisit on a paid plan, or have foghorn *push* state instead.
- **4xx stays DOWN.** See §2 step 2.
- **The content assertion is not the anti-cache fix.** A stale-but-healthy cached
  page passes any content check. It earns its place only for a 200 carrying an
  error body.

## 5. Corrections that propagated OUT of this repo

Rev 1 justified the "no customer vhosts" policy with a scoring story from swatter.
The story was wrong, verified in swatter's own code, and the corrections have been
written back into swatter's memory notes:

- `request_flood` needs `rps >= RATE_SAT(8) && n >= 60` (`lib/score.awk:254`).
  Foghorn at one request a minute is **0.017 rps** — it cannot trip that rule
  anywhere, vhost or not.
- **`ACCESS_LOG` is ingested** (`lib/ingest.sh:191`). The "swatter never reads that
  log" half of the gate-D `monitoring.cidr` note is **false**. Foghorn is
  unbannable because of the Cloudflare-range never-block, and that alone.
- `corroborate.sh` files an absent user agent in its own `noua` bucket — explicitly
  not "bot" — and only ever classifies 5xx.

The policy is unchanged; only its justification was wrong. Anyone revisiting
gate D should use the corrected reasoning.

## 6. Gotchas for whoever builds this

- **The test suite is small and stubs coarsely.** `test/index.test.ts:31-41` stubs
  `fetch` as *200 unless the URL prefix is in a `down` set*, and never asserts
  response headers. So: the UA change is testable today by reading `init.headers`;
  a `CF-Cache-Status` check that failed on a missing header would break **every
  existing test** (one more reason it must fail open); and the heartbeat needs a
  new assertion that a **DOWN** run still pings. `fakeKV` already counts writes, so
  write-budget assertions are cheap.
- **KV write budget is the constraint, not reads.** 1,000 writes/day free. State is
  written only on transitions and sub-threshold streaks — do not add a field that
  makes every run write.
- **`notify()` is the best-designed part of the file. Do not touch it.** It rethrows
  only when *every* notifier fails, so the state write is skipped and the alert
  retries next minute. A heartbeat that can throw would become a second, accidental
  way to skip that write.
- **Deploy is `wrangler deploy` from this repo and is operator-run.** Cloudflare
  *zone* changes still go through `terminal-scripts`; deploying a Worker is not a
  zone change, but a DNS record for the grey-cloud hostname is.
- **`/grok` gates this**, per swatter's `CLAUDE.md` and the developer-wide rule:
  review the design before implementing (done — that is rev 2) and the diff before
  deploying (not done, nothing exists yet).

## 7. Open questions needing a human

1. **Which heartbeat provider**, and does it deliver over a path that differs from
   Twilio? If it also texts via Twilio, one Twilio outage takes both alarms down.
2. **Is the grey-cloud hostname acceptable?** It publishes the origin IP in DNS.
   That is already inferable, and origin-lock is the actual defence, but it is a
   deliberate exposure and belongs to the operator, not to me.
3. **Free plan or paid?** It decides whether §2.5's state endpoint is ever revived.
4. **Is a monthly synthetic SMS acceptable noise** for proving the delivery path
   still works? It costs pennies and one text a month.
