# Handoff — foghorn hardening, shipped (2026-08-12, verified 2026-08-13)

**Repo:** `foghorn` · **Worker:** `down-detector`, version `e2f54d2c`, **DEPLOYED**.
**Status:** steps 1–4 are built, reviewed across five gate rounds, and live —
**as are three things the step list never numbered**: the `no-store` /
`redirect: manual` probe levers, the delivery-failure ping
(`DELIVERY_PING_URL` → `/fail`), and the opt-in content assertion.
Step 5 cancelled itself, step 6 is deferred, step 8 is untouched and lives in
another repo. **79 tests**, typecheck clean.

**Re-verified live 2026-08-13** against the running Worker, not against this
document: version `e2f54d2c` (uploaded `2026-08-13T02:20:13Z`, 12 seconds after
commit `71928f4` — so the deployed code *is* HEAD's code), cron firing every
60s, `outcome: ok`, no errors. See §8 for the full deployed-state table and the
config-drift trap it uncovered.

**Artifacts:** `docs/specs/2026-08-12-hardening-design.md` (rev 2) and its review,
`…-hardening-design-review-grok.md`. Rev 2 is the one to read; rev 1 was wrong in
several places and rev 2 says where.

| | |
|---|---|
| **What foghorn is** | A dead-man alarm: cron Worker, one file, texts the operator when cds1 stops answering. Not a status page — the README declines that on purpose. |
| **Biggest gap found** | Nothing *pages* when foghorn itself dies. §2.1 — now closed by `HEARTBEAT_URL`. |
| **Biggest correction** | Three of rev 1's claims about the `swatter` repo were wrong. §5. |
| **Next to build** | Nothing required. Step 5 was run and CANCELLED itself (spec §0.5); step 6 is deferred behind a trigger. healthchecks.io `/fail` **is now wired** — `DELIVERY_PING_URL` is set on the live Worker. Remaining: step 8 in the *swatter* repo. |
| **Scope, settled** | Foghorn watches **the server**, not the sites. Jetpack covers individual sites; NetData and Swatter cover the box. Two long-standing "open" items were closed on that basis — see "Closed" below and §4. |
| **Trap for the next machine** | `wrangler.jsonc` is gitignored, so it drifts per-machine and git cannot see it. It had silently drifted on the iMac. §8. |

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

**Five `/grok` rounds; 1, 2 and 4 returned HOLD.** Worth knowing what they
caught, because every Blocker after the first was introduced by the fix to a
previous finding:

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

## Rounds 3–5: the delivery test, fixed twice more

`runSyntheticTest` used to send and then record. If `notify()` succeeded and the
KV write threw, the outer `catch` logged a false `FAILED`; if the retry write
also failed, `attempt` never landed and every run looked due — a reviewer
measured five texts in five runs, which is what an exhausted write quota would
have produced.

It now records the **attempt first and sends nothing if that write fails**, then
sends, then records success separately. Only `ok` waits for proven delivery, so
a failed send still costs the interval nothing.

**That fix then introduced round 4's Blocker, caught by both models.** It wrote
the same key twice in one invocation, and **Workers KV allows 1 write per key
per second, throwing 429 beyond it** — a Twilio round trip is well under a
second. On the *happy* path the success write would 429, `ok` would never
advance, and the hourly brake would resend forever: ~24 texts a day once the
flag was on. Fifty-one passing tests could not see it, because `fakeKV` does not
rate limit.

Now split across **two keys** — `synthetic:ok` and `synthetic:attempt`, bare
timestamps — each written at most once per invocation. Two writes per interval
(~24 a year). Pinned by tests that assert no key is written twice in a run, and
that a rate-limiting KV still lets `ok` advance.

`attempt > ok` means **"retry slowly"**, not "delivery is known broken": the two
keys are read independently and KV serves stale values for up to ~60s, so a
healthy path can read as broken for a while. Every torn state was enumerated in
round 5 — worst case is a surplus text or a delayed re-proof, never a missed
origin page.

**`SYNTHETIC_TEST_DAYS` is ON at 30 days** (2026-08-12) and the first text was
received, so the Twilio path is proven end to end — the one thing the heartbeat
can never tell you. Production runs Twilio only, so the "several notifiers means
it only proves ONE path" caveat does not currently bite.

## Closed 2026-08-13 — the two items that used to live here

Both were carried in this doc for a while as "the highest-value work left".
**Neither is going to be built**, and the reasoning matters more than the
verdict, so it is recorded in §4 as a decision rather than deleted. Short
version:

- ~~**Point `CHECK_URLS` at a health endpoint that touches PHP and the
  database.**~~ **WON'T DO.** It was drifting toward the status-page role the
  README and §4 both refuse. The real gap it named is real — nothing pages when
  MariaDB dies — but it belongs to NetData, which already watches that server.
  §9 has the evidence.
- ~~**Make the content assertion per-URL.**~~ **WON'T DO — it existed only to
  serve the item above.** Per-URL assertion is what would let foghorn watch a
  placeholder and a health endpoint at once without one falsely paging on the
  other. With one server-level URL watched forever, that case never arrives.
  The current per-deployment behavior is already the safe default, and
  `EXPECT_TEXT`/`FORBID_TEXT` are unset in production anyway.

**If either is ever revived, revive them together** — the second is plumbing
for the first and is pointless alone.

Still true, and still the reason someone will keep proposing this: **the checked
URL is a 163-byte cPanel default page**, so "up" means "Apache answered", not
"the sites work". That is now a deliberate property, not a shortfall. See §4.

---

## 1. Where this came from

It was §5 of swatter's outage-corroboration design. Two adversarial reviews there
cut half of it, so it was moved into its own spec in this repo rather than shipped
as an afterthought to another repo's work. Four more passes (grok-4.6 and grok-4.5,
each under a correctness and a safety lens) then took rev 1 apart.

Nothing here is urgent. Foghorn works. This is about the ways it could be lying to
you without either of you noticing.

## 2. What rev 2 proposes, in build order — only step 8 is still open

**This whole list is now history, not a task list.** Steps 1–4 are built, gated
and deployed; 5 cancelled itself; 6 is deferred behind a trigger; 7 shipped out
of order. **Step 8 is the only entry left, and it is work in the swatter repo.**
Kept below as the record of what was intended and why.

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
5. ~~**The origin-probe experiment**~~ — see §3. **RUN, AND IT CANCELLED
   ITSELF.** `cds1` turned out to be DNS-only already, so there is no Cloudflare
   edge in front of it and foghorn had been probing the origin all along. Spec
   §0.5 has the evidence. §3 below is preserved as the method, not as a to-do.
6. **`CF-Cache-Status` assertion**, fail-open, with rev 2's corrected table.
   **DEFERRED, not cancelled** — a Worker subrequest still reads through a
   Cloudflare cache even for a DNS-only host. **Trigger: any host in
   `CHECK_URLS` becoming proxied (orange-cloud) reopens this immediately.**
7. ~~**Content assertion**~~, opt-in, default off, and only for
   200-with-error-body. **SHIPPED** (`71928f4`) as `EXPECT_TEXT` /
   `FORBID_TEXT` — out of order, ahead of 5 and 6. Unset in production; see §8.
   Still per-deployment rather than per-URL, and **staying that way** — making
   it per-URL was closed as won't-do on 2026-08-13; see "Closed" above and §4.
8. **Swatter-side cross-check** (nightly "did foghorn probe me?"). Work in the
   *swatter* repo, listed here so it is not lost. **The only step still open.**

## 3. The experiment that gated step 6 — ALREADY RUN, see §0.5 of the spec

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
- **Foghorn watches the SERVER, not the sites — settled by the owner
  2026-08-13.** Individual sites are Jetpack's job; it already pings them and
  notifies per site. Foghorn works *in tandem with* Swatter, NetData and
  Jetpack rather than duplicating any of them. This is the rule the two items
  closed above ran into, and it is the general form of the older "no customer
  vhosts" decision: **the 163-byte placeholder is not a shortfall, it is the
  right target.** It is the cheapest possible proof that the box is up and
  Apache is answering, and it cannot break for any reason specific to a site.
  A richer check buys coverage that other tools already own, and pays for it in
  false 3am pages — which §1 ranks as the worse failure.
- **"Nothing pages when MariaDB dies" is NOT foghorn's to fix.** The gap is
  real (§9 has the evidence) but the fix belongs in NetData, which already
  watches that server and can cover *every* systemd service in one change
  instead of just the database. Building it here would have meant a PHP
  endpoint on prod, a new DNS record, and a new public surface, to do a worse
  version of a job another tool already has.

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

- **The test suite is no longer small — 16 tests became 79** — but it still
  stubs `fetch` coarsely. `stubFetch` now takes a failure mode (an HTTP status,
  or `"throw"` for the no-response case) and `atTime` pins `Date.now()`. Still
  true and still relevant to step 6: **no test asserts response headers**, so a
  `CF-Cache-Status` check that failed on a missing header would break nearly
  every test — one more reason it must fail open.
- **KV write budget is the constraint, not reads.** 1,000 writes/day free. State is
  written only on transitions and sub-threshold streaks — do not add a field that
  makes every run write.
- **`notify()` is the best-designed part of the file. Do not touch it.** It rethrows
  only when *every* notifier fails, so the state write is skipped and the alert
  retries next minute. A heartbeat that can throw would become a second, accidental
  way to skip that write.
  *Amended:* one change was made — it throws a `NotifyError` subclass instead of
  a plain `Error`, so the heartbeat can tell "the alert did not get out" from
  "foghorn is broken". Reviewers confirmed the retry invariant survives. The
  `tasks.length === 0` path still logs and returns without throwing, which is
  why the heartbeat separately requires `hasNotifier(env)` — otherwise an
  unconfigured foghorn drops every alert while reporting healthy.
- **Deploy is `wrangler deploy` from this repo and is operator-run.** Cloudflare
  *zone* changes still go through `terminal-scripts`; deploying a Worker is not a
  zone change, but a DNS record for the grey-cloud hostname is.
- **`/grok` gates this**, per swatter's `CLAUDE.md` and the developer-wide rule:
  review the design before implementing (done — that is rev 2) and the diff
  before deploying (done — **five rounds**; 1, 2 and 4 returned HOLD, 3 and 5
  SHIP). Budget for that on steps 5–8: every HOLD after the first was a Blocker
  *introduced by the fix to a previous finding*, so one round is never enough.
  Round 4's was a misread of a documented platform limit that 51 passing tests
  could not see, because `fakeKV` does not enforce what Cloudflare does — it
  has no rate limiting, no eventual consistency, no size caps. Tests validate
  the model of the platform, not the platform.

## 7. Open questions needing a human

1. ~~**Which heartbeat provider**~~ — **ANSWERED 2026-08-12: healthchecks.io**,
   free tier, alerting by email and push with SMS off, so the alarm-on-the-alarm
   shares no delivery path with Twilio. Live and pinging. Its ping URL is a
   capability — a plain GET *is* a heartbeat — and is stored as a Worker secret.
2. ~~**Is the grey-cloud hostname acceptable?**~~ — **MOOT 2026-08-12.** It died
   with step 5: spec §0.5 found `cds1` is *already* DNS-only and already
   publishes the origin IP, so there was no new exposure to consent to and no
   hostname to create.
3. **Free plan or paid?** It decides whether §2.5's state endpoint is ever revived.
4. ~~**Is a monthly synthetic SMS acceptable noise**~~ — **ANSWERED 2026-08-12:
   yes, enabled at 30 days** and confirmed delivering.

---

## 8. Deployed state, verified 2026-08-13 — and the config-drift trap

Everything below was read from the **running Worker**, not from this repo. Do
this again rather than trusting the table; that is the whole point of it.

| Surface | Live value |
|---|---|
| Version | `e2f54d2c-ced2-4f4b-bc19-f5c2e3e6e9a2`, uploaded `2026-08-13T02:20:13Z` |
| Handlers | `scheduled` only — still no `fetch`, as §4 intends |
| Cron | `* * * * *`, `outcome: ok`, ~1.4s wall, 1–2ms CPU |
| `workers_dev` | **disabled** (`subdomain.enabled: false`) — spec §2.5 holds |
| Vars | `CHECK_URL` *(singular)*, `FAIL_THRESHOLD=2`, `SYNTHETIC_TEST_DAYS=30`, `TWILIO_FROM`, `TWILIO_TO` |
| Secrets | `HEARTBEAT_URL`, `DELIVERY_PING_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |
| KV | `STATE` → `9ce11ab5c5c14513a74861e3629c9381` |
| Not set | `WEBHOOK_URL`, `EXPECT_TEXT`, `FORBID_TEXT` — the content assertion is **off in production**, which is its documented default |

Two things worth internalising from that table:

- **`CHECK_URL` is singular in production.** `src/index.ts` accepts
  `CHECK_URLS ?? CHECK_URL`, so this is correct, not drift — but the example
  file and every doc say `CHECK_URLS`. Do not "fix" the live var without
  meaning to.
- **The content assertion has never run against production.** It is tested and
  deployed but unset, so its first real exercise will be whenever someone turns
  it on. Turn it on deliberately, not incidentally.

### The trap: `wrangler.jsonc` drifts per machine and git cannot see it

`wrangler.jsonc` is **gitignored**. That protects the phone numbers, and it
means **the deployed configuration lives on whichever Mac last deployed** —
there is no version control, no diff, and no warning.

Found live on 2026-08-13: the iMac's copy was dated **Jul 22**, predating this
entire spec. It was missing `workers_dev: false` **and**
`SYNTHETIC_TEST_DAYS: "30"`. A routine `wrangler deploy` from that machine
would have silently, in one command:

1. **re-enabled the `workers.dev` URL** — restoring the invocation-burn path
   that can stop the cron, which is precisely the silent death `HEARTBEAT_URL`
   exists to catch; and
2. **switched off the synthetic delivery test** — removing the only proof that
   Twilio still delivers.

Both regressions are *quiet*. Nothing would have alerted, and the heartbeat
would have stayed green through the first one right up until the invocation cap
bit. Reconciled and verified with `wrangler deploy --dry-run`, whose bindings
now match the live version exactly.

**Before deploying from any machine, diff the local config against the live
Worker** — `wrangler versions view <id> --name down-detector` lists vars,
secrets and bindings, and the `…/workers/scripts/down-detector/subdomain` API
endpoint is what tells you `workers_dev`, which `versions view` does *not*
show. Note the Cloudflare API token cannot read script *content*
(`10405: Method not allowed for this authentication scheme`), so verify
deployed code by comparing the upload timestamp against the last code commit —
here, 12 seconds apart.

### Housekeeping done the same day

- `wrangler` 4.112.0 → 4.122.0 (`cedcd79`). The emitted bundle is byte-for-byte
  identical across both versions (13,170 bytes, sha256 `3462f26a…`), so it
  changed the deploy tool and not the deployed artifact.
- Pushes go to **two remotes** — GitHub and a GitLab mirror. A push that
  succeeds on one and fails on the other will look half-done; check both lines.
- `.gitignore` matches `wrangler.jsonc` **exactly**, not `wrangler.jsonc.*`. A
  file like `wrangler.jsonc.bak` is therefore untracked-but-visible in a public
  repo, carrying real phone numbers. Do not leave backups next to it.

---

## 9. Why the health-endpoint idea died: what NetData does and does not cover

Measured on cds1, 2026-08-13, read-only. This section exists so the idea is not
revived from first principles a third time.

**NetData is running and enabled**, with 196 alarm instances across 63 alarm
types. They are almost entirely **host-level**: CPU, RAM, load, disk space and
inodes, network, TCP, OOM kill, reboot detection.

**Database coverage is absent.** The mysql collector runs and `mysql.*` charts
exist, but:

- there is **no MariaDB health alarm of any kind**; and
- unlike `phpfpm`, `exim`, `chrony`, `memcached` and apache's `web_log`, the
  mysql collector has **no `data_collection_status` alarm** — so when it loses
  its connection to a dead database, nothing fires.

The only mariadb-adjacent alarm is `mariadbd_fds_open_limit`, which is
file-descriptor *utilization*. A dead `mariadbd` has no file descriptors to
exceed a threshold: it goes quiet, not critical.

**The near-miss.** A stock `systemd_service_unit_failed_state` template exists,
the `systemd.service_unit_state` chart exists, and MariaDB *is* tracked
(`systemd_mariadb.cpu`). That would have covered this — but **the alarm is
never instantiated**; it appears nowhere in the active list. The fact is
confirmed; the reason was not determined. And even instantiated it would not
have texted: the template is **`warn`-only** (no `crit:` line) while the Twilio
recipient is scoped `+12089209073|critical`, so warnings never reach SMS.

### The shared-Twilio finding — matters to this repo

**NetData and foghorn send through the same Twilio path**: same account
(`ACe061…`), same `TWILIO_NUMBER` / `TWILIO_FROM` (`+12084189224`), same
recipient (`+12089209073`).

- **Risk:** one rotated auth token silences **both** alarms at once. Two
  monitors that look independent share one throat to choke. Anyone rotating
  that token must update the Worker secret *and* `health_alarm_notify.conf`.
- **Benefit, unplanned:** foghorn's 30-day synthetic delivery test is therefore
  proving NetData's SMS path too. Neither system knows this. It is also an
  argument for **keeping** `SYNTHETIC_TEST_DAYS` on.

Configuration was verified, **delivery was not** — firing a test alarm sends a
real text, so it was not done.
