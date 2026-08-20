# Changelog

## Unreleased

Hardening, from `docs/specs/2026-08-12-hardening-design.md` steps 1–4. The
theme: foghorn could previously fail in ways indistinguishable from a healthy
server, and nothing raised the alarm when the alarm itself died.

- **A probe that fails in transit no longer counts on its own.** It is
  retried once inside the same run — fresh connection, fresh cache-buster, one
  second apart — and only counts as a failure if the retry fails too. A
  definitive answer still counts immediately, as it always did. The pair
  resolves to one outcome, so it cannot increment the streak twice or write KV
  twice, and the run still reaches its heartbeat. What gets retried is any
  failure where the origin never finished answering — a timeout, a refused
  connection, a DNS failure, or — when a content assertion is switched on — a
  body that stopped arriving before it could be checked. A 4xx,
  a 5xx, or a page that arrived in full and was wrong is the origin telling
  you something real, and is not retried. This closes the false page of 2026-08-17
  (`docs/handoff-2026-08-17-false-down-probe-blips.md`), where two probes failed
  in transit on consecutive minutes and `FAIL_THRESHOLD = 2` read that as
  confirmed downtime. A rescued probe logs one line, so the blip rate stays
  countable from Workers observability rather than only from the origin's own
  access log. The README's description of `FAIL_THRESHOLD` was corrected with
  it: it sold the default `2` as "~2 minutes of confirmed downtime", wording
  that assumed probe failures are rare *and independent* when the measured ones
  were clustered. It now says what a threshold actually buys — N consecutive
  failed checks at the cron interval — and when to raise it.
- **Something now watches foghorn.** `HEARTBEAT_URL` pings a third-party
  dead-man service on each run where foghorn could actually page you. It stays
  quiet only when it could not — a dead KV binding, no notifier configured, or
  an empty `CHECK_URLS` — so silence raises the alarm instead of passing for
  health. It deliberately still fires on DOWN runs, and on runs where an alert
  failed to send: withholding it there would page "foghorn is dead" on top of a
  correct DOWN alert, two alarms with one of them lying.
- **Something now tests the delivery path.** `SYNTHETIC_TEST_DAYS` texts you
  every N whole days. Success and attempts are tracked separately, so a failure
  neither burns the interval nor passes for proof — it retries hourly until it
  lands. Off unless set, and only ever sent on a completely clean run.
- **A sent alert now leaves a log line.** foghorn previously logged only when a
  send *failed*, so a delivered page left no trace of its own and "did it page,
  and when?" could not be answered from Workers observability at all — the
  2026-08-18 investigation had to infer it from the wall-clock duration of each
  run instead (`docs/handoff-2026-08-17-path-latency-and-item-3.md`). Each DOWN
  and UP transition that a notifier actually accepted now emits one line, so the
  paging history is directly queryable, and the scheduled delivery test emits
  one too — the one alert a healthy box sends, which had the same blind spot.
  `notify()` now reports whether any notifier *accepted* the alert, and that
  return value is the only gate on the line, so it stays silent when none is
  configured — where the existing "dropped alert" error already says what
  happened and claiming a page would be a lie. Read it as "an alert left the
  building", not "the phone rang": with both Twilio and a webhook configured
  either one succeeding is enough, and the adjacent "Twilio send failed" error
  is what tells them apart. Only the host is logged, never the path or query,
  so a credential-bearing check URL cannot end up in retained logs. Healthy
  runs are unchanged.
- **A delivery test that sent nothing no longer counts as proof.** `notify()`
  returning false — no notifier configured — did not throw, so the synthetic
  canary fell through to stamping the interval as delivered and pinging
  `delivery-ok`. It was unreachable in practice, guarded only by a predicate
  duplicated in another function; it now fails explicitly instead.
- **Probes identify themselves.** Requests carry a `User-Agent` instead of
  arriving as empty-UA cache-busted traffic every 60 seconds — which is, almost
  exactly, the shape of an abusive scanner.
- **DOWN alerts say which kind of dead it is** — *unreachable* when nothing
  answered, *answered HTTP 403* when the origin is up but refusing. A 4xx still
  counts as DOWN; only the wording changed.
- **Alerts fit one SMS segment.** Bodies stay inside GSM-7 (a single em dash
  was cutting the segment from 160 characters to 70) and the hostname is
  clamped, so a long check URL cannot split an alert into parts that arrive out
  of order.
- Notifier requests carry a 10s timeout — an unbounded one could previously eat
  the whole 15-minute cron wall clock, taking the heartbeat ping with it.
- The cache-buster is set via `searchParams`, so a URL carrying a fragment can
  no longer strip it and let the check be answered from cache.

## 1.0.0 — 2026-07-17

Initial public release.

- Cron-triggered Cloudflare Worker: checks each configured URL every minute,
  alerts after `FAIL_THRESHOLD` consecutive failures, alerts again on
  recovery. Exactly one alert per transition.
- Multiple check URLs (`CHECK_URLS`, comma-separated) with independent
  per-URL failure streaks and alerts.
- Two notifiers, usable together: Twilio SMS and a generic webhook whose
  payload (`text` + `content`) is Slack- and Discord-compatible out of the box.
- Delivery-coupled state: a transition only commits after at least one
  notifier delivers, so a failed send is retried every cron run instead of
  silently dropped.
- KV state written only on change — a healthy server costs zero KV writes,
  keeping the free tier's 1,000 writes/day quota untouched.
- Vitest suite covering transitions, thresholds, multi-URL independence,
  notifier dispatch, and the zero-write invariant.
