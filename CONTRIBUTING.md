# Contributing

Thanks for looking under the hood. Two things to know before you open a PR.

## The scope is the feature

Foghorn stays small on purpose: one file, cron → check → one alert per
transition, zero KV writes while healthy. Bug fixes, notifier improvements,
and reliability hardening are all welcome. Status pages, history storage,
dashboards, and multi-region checks are not — that's
[UptimeFlare](https://github.com/lyc8503/UptimeFlare)'s job, and it does it
well. PRs that grow the surface area will be declined kindly.

## Workflow

```bash
npm install
npm test            # vitest — must pass
npm run typecheck   # tsc --noEmit — must be clean
```

- Tests first. Every behavior change needs a test that fails without it.
- Keep the zero-KV-writes-while-healthy invariant — there's a test for it,
  and it must stay green.
- No new runtime dependencies. The Worker uses only platform APIs.
- Functional comments only — say what the code does, never when it changed.

CI runs the test suite, the typecheck, and a gitleaks scan on every push.
