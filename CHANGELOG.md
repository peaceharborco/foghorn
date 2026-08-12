# Changelog

## Unreleased

Hardening, from `docs/specs/2026-08-12-hardening-design.md` steps 1–4. The
theme: foghorn could previously fail in ways indistinguishable from a healthy
server, and nothing raised the alarm when the alarm itself died.

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
