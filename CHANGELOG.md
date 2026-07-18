# Changelog

## 1.0.0 — 2026-07-17

Initial public release.

- Cron-triggered Cloudflare Worker: checks each configured URL every minute,
  alerts after `FAIL_THRESHOLD` consecutive failures, alerts again on
  recovery. Exactly one alert per transition.
- Multiple check URLs (`CHECK_URLS`, comma-separated) with independent
  per-URL failure streaks and alerts.
- Two notifiers, usable together: Twilio SMS and a generic webhook whose
  payload (`text` + `content`) is Slack- and Discord-compatible out of the box.
- KV state written only on change — a healthy server costs zero KV writes,
  keeping the free tier's 1,000 writes/day quota untouched.
- Vitest suite covering transitions, thresholds, multi-URL independence,
  notifier dispatch, and the zero-write invariant.
