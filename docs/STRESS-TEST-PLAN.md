# Stress test and verification plan

A lot landed in a short window: company-first discovery, vertical-aware ICP,
single-contact enrichment, a reworked Apollo credit model, email threading, a
rewritten template bank, warm-up and per-channel caps, an inert Twilio A2P
stack, and consent lanes with a hard dial gate. This is how to prove each of
them does what it claims, and — more to the point — how to prove the expensive
and irreversible ones cannot do anything else.

Two things make this different from a normal test pass. Some of these checks
spend real money, and some of them put a message in front of a real person.
Every step below is labelled for both, and nothing that contacts a stranger is
proposed without a rehearsal that does not.

## How to read this

Each test carries three labels.

| Label | Meaning |
| --- | --- |
| **Automated** | A vitest file or a script under `scripts/`. Repeatable, safe, no judgement required. |
| **Manual** | The operator drives the UI or inspects a dashboard. Cannot be scripted, usually because the assertion is "does this look right to a human". |
| **Costs money** | Spends provider credits. The amount is stated. |
| **Contacts a person** | Sends an email or a text to somebody outside the company. Never run against a stranger without reading [Rehearsal](#rehearsal-testing-without-touching-a-stranger) first. |

Unlabelled means free and safe.

The verification scripts share a house style: they read `DATABASE_URL` from
`.env.local`, print `console.table` output, take `--problems` to show only what
looks wrong, and set a non-zero exit code when they find something. They are
**strictly read-only** — see [The read-only guarantee](#the-read-only-guarantee).

Run them from the repository root:

```bash
npx tsx scripts/check-schema-drift.ts
npx tsx scripts/verify-credit-spend.ts --days 7
npx tsx scripts/verify-text-kill-switch.ts --problems
```

---

## 0. The deploy gate

### 0.1 Schema drift — run this before every deploy

**Automated.** `npx tsx scripts/check-schema-drift.ts`

Two outages this week had one cause: a migration was generated, the PR merged
and deployed, and the deployed Drizzle schema referenced a column the database
did not have. Drizzle emits an explicit column list on every select, so the
first read of that table threw and the page returned HTTP 500. Nothing in the
build catches this, because the TypeScript compiles perfectly — the type came
from the same file that was wrong.

The checker reads the Drizzle table objects out of `src/lib/db/schema.ts` by
introspection rather than from a hand-kept list, so a table added tomorrow is
covered with no edit to the script. It currently sees 23 tables, 360 columns,
15 enums and 9 unique indexes.

What blocks a deploy, because the deployed code would throw:

- a table in the schema the database does not have
- a column in the schema the table does not have
- an enum value the code can write that the database enum does not accept
- a unique index the code needs, because `ON CONFLICT` against a missing one is
  a runtime error rather than an ignored hint

What is reported but does not block (add `--strict` to make these block too):

- a column whose SQL type differs between code and database
- a column the database requires that the code treats as optional with no
  default, which fails on INSERT rather than on read
- a column the code marks NOT NULL that the database lets be null, which hands
  TypeScript a null it has typed as non-null

Extras the database has and the code does not are listed for information and
never block: a column dropped from the schema before its migration lands is
safe, and an unrelated table in the same database is none of this check's
business.

**Steps**

1. Point `DATABASE_URL` at the database the deploy will talk to.
2. `npx tsx scripts/check-schema-drift.ts`
3. In CI, gate on the exit code. `--json` emits `{ ok, blocking, warnings, info }`.

**Pass** — exit 0 and "PASS: the database matches what the code expects."

**Fail** — exit 1 with a table of blocking differences. Do not deploy; run the
pending migration first, then re-run.

**Comparison notes.** Types are normalised on both sides before comparison, so
`integer`/`int4`, `boolean`/`bool`, `timestamp without time zone`/`timestamp`
and `text[]`/`_text` do not read as drift, and precision qualifiers such as
`numeric(10,2)` are stripped. Unique indexes are matched on their column set
rather than their name, because drizzle-kit and a hand-written migration name
the same index differently and what `ON CONFLICT` resolves against is the
columns.

### 0.2 The build gate

**Automated.**

```bash
npx tsc --noEmit          # 10 known failures in test fixtures, see below
npx vitest run
npx eslint
DATABASE_URL="postgresql://user:pass@localhost:5432/db" npx next build
```

**Known baseline as of this branch.** `tsc` reports 10 errors, all in
`*.test.ts` fixtures constructing a settings object without
`emailReportPreferences` / `contactTitles`. They are fixture drift, not product
bugs. `eslint` reports 0 errors and 2 warnings (`scripts/fix-listing-pseudo-companies.ts`,
`scripts/verify-pipeline-cycle.ts`), both pre-existing unused imports.

**`main` is currently red — see [Finding 1](#finding-1-the-florida-geo-footprint-collapsed-from-36-cities-to-8).**

---

## 1. Company-first discovery

Apollo Organization Search finds companies by vertical, market and employee
band. Companies land in a review queue at `/crm?tab=discovery` with
`review_status = 'pending'` and six review actions: approve, reject, review
later, already contacted, existing client, do not contact.

### 1.1 A run costs 1 credit, or 2 with the unknown-headcount pass

**Automated. Verifies a cost claim; the run itself costs money.**

Organization Search bills 1 credit per page of up to 100. Surfacing
unknown-headcount companies is a second query and therefore a second credit.
`organizations/search` is booked at `estimatedCost: 1` in both
`domain-resolver.ts` call sites.

**Steps**

1. Note the current spend: `npx tsx scripts/verify-credit-spend.ts --days 1`
2. Operator runs one discovery from the launcher. **Costs 1–2 Apollo credits.**
3. Re-run the script.

**Pass** — the run added exactly 1 `organizations/search` booking, or 2 when the
unknown-headcount pass ran, each at cost 1. No `people/match` and no
`mixed_people/api_search` rows appeared: discovery reveals nobody.

**Fail** — any `people/match` row attributable to the run (paid people data must
start at Approve, not at discovery), or more org-search pages than requested.

### 1.2 Discovery reveals no contacts

**Automated.** Part of `verify-credit-spend.ts`.

The whole point of company-first is that finding a company is cheap and
revealing a human is not. A discovery run must not touch `people/match`.

**Pass** — zero `people/match` bookings in the run's window.

### 1.3 Idempotency: day two must not re-return day one

**Automated.** `npx tsx scripts/verify-discovery-idempotency.ts`

Pagination state per `(vertical, market, pool)` lives in
`company_discovery_runs`, which carries a unique index on exactly those three
columns (`company_discovery_runs_vertical_market_pool_uq`). If the cursor does
not advance, the same page is bought and discarded every day: credits spent for
nothing, and a review queue that never grows.

The script checks three things: that the cursor advanced, that no company was
inserted twice under the same domain or normalised name, and — the one that
actually loses work — that a re-run has not reset a company that was already
reviewed back to `pending`.

**Steps**

1. Run discovery for a vertical and market. **Costs 1–2 credits.**
2. Review a few companies (approve one, reject one).
3. Run discovery again for the *same* vertical and market. **Costs 1–2 credits.**
4. `npx tsx scripts/verify-discovery-idempotency.ts`

**Pass** — the cursor advanced, no duplicate domains, and every company reviewed
in step 2 still carries the decision made there.

**Fail** — a review decision back at `pending` is the serious one: it means the
operator's judgement is being overwritten by a scheduled job, and the same
company will be re-reviewed forever.

### 1.4 The review queue never shows a pre-discovery company

**Automated.** Covered by `getReviewQueue`'s `review_status IS NOT NULL`
condition. `review_status` is null for every company that predates discovery,
which is exactly the pre-discovery pipeline.

**Pass** — the queue's total equals the count of companies with a non-null
`review_status`.

### 1.5 The state and city filters do not cross state lines

**Automated — and expected to FAIL today. See [Finding 2](#finding-2-the-review-queue-state-filter-matches-across-state-lines).**

**Steps**

1. Open `/crm?tab=discovery` and filter state = `IN`.
2. Read the `state` column of the results.

**Pass** — every row is Indiana.

**Fail** — rows from Illinois, Washington, Virginia or Minnesota appear. The
filter builds an unanchored `ILIKE '%IN%'`, and every one of those state names
contains the letters "in".

### 1.6 Scale: 100 companies a day

**Manual. Costs money.**

100 companies is 1–2 org-search pages, so roughly 1–2 credits — discovery is not
where the spend is. The pressure lands on the review queue and on whoever has to
work it.

**Steps**

1. Run discovery until roughly 100 pending companies exist. **Costs 1–2 credits.**
2. Load `/crm?tab=discovery`. Time the load.
3. Page to the end of the queue.
4. `npx tsx scripts/verify-discovery-idempotency.ts`

**Pass** — the page renders in a few seconds, paging is stable (no company shown
twice, none skipped), and the counts in the tab header match the rows.

**Fail** — an unbounded query pulling all 100 with their contacts and listings,
or paging that shifts rows because the sort is not total. Watch for the sort
being on a non-unique column: rows will swap between pages under a stable
offset.

**Where the cap binds.** Nowhere at 100/day, and that is worth stating
explicitly — discovery is cheap and the queue is the bottleneck. The binding
constraint is human review throughput, not credits or database load.

---

## 2. Vertical-aware ICP and company-first scoring

`evaluateIcp` used to hard-code a 20–500 employee band, which failed a
12-person law firm that was a perfectly good prospect. It now reads the band
from the vertical config. `scoreCompanyFirst` scores companies with no job
postings, which the old job-listing-shaped scorer put near zero.

### 2.1 The 12-person law firm passes

**Automated.** vitest, `src/lib/icp-filter*.test.ts`.

**Pass** — a 12-employee company in a vertical whose configured minimum is at or
below 12 returns `pass`. The same company in a vertical with a minimum of 20
returns `fail`. The band must come from the config, not a constant.

### 2.2 A company with no job postings still scores

**Automated.** vitest, `src/lib/lead-score*.test.ts`.

**Pass** — `scoreCompanyFirst` returns a score in a useful range for a company
with zero listings, and the ordering is sensible: a larger firm in a target
vertical in a target market outranks a smaller one outside it.

**Fail** — everything clustering near zero, which is the old scorer's behaviour
and makes the review queue's ordering meaningless.

### 2.3 Rescoring is stable

**Manual.** Run `recompute-company-scores` twice with no data change.

**Pass** — identical scores. **Fail** — drift, which means the score depends on
something uncontrolled (row order, wall-clock time) and the queue reshuffles on
its own.

---

## 3. Single-contact enrichment and Apollo credit accounting

### 3.1 The cost model

`paid-egress.ts` is meant to mirror Apollo's billing exactly:

| Endpoint | Booked cost | Notes |
| --- | --- | --- |
| `mixed_people/api_search` | 0 | People Search is free. Listed in `ZERO_COST_ENDPOINTS`, so excluded from the cap by name. |
| `organizations/search` | 1 per page | Counts against the cap. |
| `people/match` | 1 if a person came back, 0 if not | Reserved at worst case, booked at actual. |
| `people/match:mobile` | 8 | Booked by the phone webhook only when a mobile actually came back. |

Two subtleties worth understanding before reading any usage report.

**Reservation is not a booking.** `assertPaidEgressAllowed` checks
`used + estimatedCost > cap` using the *worst case* (1 + 8 = 9 for a
phone-enabled match) but writes no row on the allowed path. Only
`recordProviderUsageEvent` books, and it books what happened. So the cap is
conservative going in and accurate looking back, and the two never double-count.

**Daily usage can legitimately exceed the cap.** The +8 mobile surcharge is
settled by the webhook after the fact, with no cap check — the money is already
spent by then. `dailyUsage > cap` is therefore not by itself a bug.

### 3.2 Every booking matches the model

**Automated.** `npx tsx scripts/verify-credit-spend.ts --days 7`

The script holds the table above as data and flags any row booked at a cost the
model does not allow. A `people/match` booked at 9 is called out specifically:
that would be the reservation having been written as a charge, and the surcharge
would then be counted twice once the webhook lands.

**Pass** — no off-model rows.

**Fail** — an unknown endpoint (a new call site nobody costed) or a known
endpoint at a surprising cost. Both matter: over-booking stops real work by
exhausting the cap early, under-booking lets a burst through.

### 3.3 Approving a company reveals exactly one contact

**Automated. The approval itself costs money.**

Approving reveals ONE decision-maker ranked by the vertical's titles, verifies
the email, and stops. "Find Additional Contact" reveals one more, on demand.

**Steps**

1. `npx tsx scripts/verify-credit-spend.ts --days 1` — note the baseline.
2. Approve one company from the review queue. **Costs 1 Apollo credit, plus 8 if
   a mobile is returned and phone enrichment was requested.**
3. Re-run the script.

**Pass** — exactly one `people/match` booking for that company, and exactly one
new contact row. `mixed_people/api_search` may appear (it is free) but must not
be followed by more than one match.

**Fail** — two or more matches from a single approval. At 1 credit each plus a
possible 8 for a mobile, a loop here is the single most expensive bug available
in this codebase.

### 3.4 "Find Additional Contact" reveals exactly one more

**Manual + automated. Costs 1 credit per click, +8 if a mobile returns.**

**Pass** — one click, one new contact, one `people/match` booking.

### 3.5 A match that returns nothing costs nothing

**Automated.** vitest, `src/lib/apollo-phone-cost.test.ts`.

**Pass** — `recordProviderUsageEvent` books 0 when `data.person` is absent, and
the mobile surcharge is not booked at request time.

### 3.6 The cap is per channel and excludes free endpoints

**Automated.** vitest, `src/lib/paid-egress.test.ts` and
`src/lib/outreach/daily-cap-scope.test.ts`.

**Pass** — `endpointConsumesCredits("apollo", "mixed_people/api_search")` is
false; `people/match` is true. On the send side, `sentTodayOnChannel` filters by
channel, so email and text do not share one budget.

**Why this matters.** On 2026-08-17 the shared budget cost 71 intro emails: 83
emails plus 73 texts hit the shared 100 first, and the email loop deferred
everything after that while the sending pool still had headroom.

### 3.7 Scale: 25 approvals a day

**Manual. Costs 25–225 credits.**

25 approvals is 25 `people/match` calls at 1 credit each, plus up to 8 each if
mobiles come back — so anywhere from 25 to 225 credits depending on phone
enrichment and hit rate. **This is the expensive path in the whole system and
the one to model before turning up volume.**

**Steps**

1. Record `providerDailyCap("apollo")` and the current `dailyUsage`.
2. Approve companies in batches of 5, running `verify-credit-spend.ts` between
   batches.
3. Continue until the cap blocks.

**Pass** — spend tracks the model (1 per approval, +8 only where a mobile
actually arrived); when the cap is reached the next approval fails with a clear
`PaidEgressBlockedError` surfaced in the UI, and a `blocked: true` row is written
with `reason: daily_cap_reached`.

**Fail** — the cap being hit silently, an approval appearing to succeed while
revealing nothing, or the block arriving as an unhandled 500.

---

## 4. Email outreach

### 4.1 Follow-ups thread onto the first send

**Automated.** `npx tsx scripts/verify-email-threading.ts`

Follow-ups previously arrived as brand new threads with their own subjects, so
"following up on my note" showed up with no note above it. `threadHeaders` now
sets `In-Reply-To` and a full `References` chain and reuses the first send's
subject with one `Re:` prefix.

**Pass** — every sent email has a stored `message_id` to be referenced by; every
follow-up's `sent` event payload carries `threaded_to`; and the follow-up's
stored subject is the root subject with exactly one `Re:` prefix.

**Fail** — a null `message_id` (nothing downstream can thread onto it), a missing
`threaded_to`, or a stacked `Re: Re:` chain.

Note that the stored subject is deliberately the *threaded* subject rather than
the drafted one, so the record agrees with what is actually in the contact's
inbox.

### 4.2 Threading survives a real inbox

**Manual. Contacts a person — use a rehearsal lead.**

Header correctness does not guarantee visual threading; Gmail and Outlook each
have their own opinion.

**Steps**

1. Seed a rehearsal lead on an address you own (see [Rehearsal](#rehearsal-testing-without-touching-a-stranger)).
2. Drive intro + follow-up 1 + follow-up 2.
3. Open the mailbox in Gmail web, the Gmail app, and Outlook.

**Pass** — one collapsed conversation in all three, follow-ups nested under the
intro, subject reading `Re: <original>` once.

**Fail** — separate conversations, or a subject that has drifted.

### 4.3 Warm-up ramp and per-domain caps

**Automated.** vitest, `src/lib/outreach/profiles*.test.ts`.

Three email domains ramp `min(50, 5 + 5 * stage)` per day, +1 stage per clean
week.

**Pass** — stage 0 gives 5, stage 3 gives 20, stage 9 gives 50, and stage 20
still gives 50. A profile only advances after a clean week. Profiles created by
`ensureSmsSendingProfile` ship as `new`, which `pickSendingProfile` does not
select — registering an identity must not by itself make it sendable.

### 4.4 Bounce and complaint throttling

**Automated.** vitest.

`hasViolation` throttles above a 5% lifetime bounce rate (raised from 2%) and
0.1% complaints.

**Pass** — 4.9% bounce does not throttle, 5.1% does; 0.09% complaints does not,
0.11% does. A violating profile drops one ramp stage, has its `daily_limit`
recomputed from the new stage, goes `throttled` with
`pausedReason: "bounce/complaint rate violation"`, and has `cleanSince` cleared.

**Watch the sample-size floor.** `hasViolation` returns false below 20 lifetime
sends — "too sparse to judge". A test that sets 1 bounce in 10 sends is at 10%
and still will not throttle, which is correct behaviour and a very easy false
alarm to raise against it.

**Fail** — the old 2% threshold still in force, which throttles healthy domains.

### 4.5 Deferrals are visible

**Automated.** `verify-email-threading.ts` reports deferral reasons.

A silent deferral looks identical to a lost email from the Call List, which is
exactly how an unsent intro goes unnoticed for hours. A deferral now writes a
Call List note naming the cause, once per distinct reason rather than once per
15-minute pass.

**Pass** — every message with a `deferred_reason` has a matching Call List note;
`deferred_reason` is cleared back to null when the message eventually sends.

### 4.6 Sent emails carry a Resend deep link

**Manual.** Open a sent row in the CRM, click through.

**Pass** — the link opens that exact message in the Resend dashboard.

### 4.7 The template bank

**Automated.** vitest, `src/lib/outreach/seed-templates*.test.ts`.

The `followup_1` exemplar was rewritten (135 sends, 0 replies) and the "boutique
firm pitch" intro was **deactivated** rather than rewritten (3 replies on 383
sends). `seedOutreachTemplates` runs on every enrollment, so retirement has to be
one-directional or the next enrollment resurrects what was just retired.

**Pass** — seeding twice leaves the boutique intro inactive. This is the whole
test: an idempotent seeder that un-retires a retired template is worse than no
seeder.

**Fail** — the retired template active again after a second seed.

### 4.8 The sanitizer rejects dashes

**Automated.** vitest, `src/lib/outreach/sanitizer*.test.ts`.

Any dash or hyphen in drafted copy or an exemplar is rejected — it is the
clearest machine-written tell.

**Pass** — copy containing `-`, `–` or `—` is rejected. Every seeded exemplar
passes its own sanitizer (a shipped exemplar that fails is a permanent draft
failure). Note `formatBookingWhen` builds "Monday Aug 3 at 9 AM ET" specifically
to avoid a dash, and `zoneLabel` returns empty rather than smuggle a `GMT+5`
past the check.

### 4.9 Scale: several hundred queued emails

**Manual + automated. Costs nothing directly; contacts people if run against real leads.**

**Steps**

1. With several hundred messages queued, run one dispatch pass.
2. `npx tsx scripts/outreach-send-report.ts`

**Pass** — the pass processes its batch (50 per pass, ordered by
`scheduled_for`), sends up to the per-channel daily cap and the per-profile
warm-up capacity, and **defers the remainder with a reason rather than dropping
it**. The deferred messages are picked up on the next pass. Nothing is lost.

**Where the caps bind, in order.** Per-profile warm-up capacity binds first
(3 domains × 50 at full ramp = 150/day ceiling), then the system
`dailySendCap`, then the 50-per-pass batch. With several hundred queued and
domains at full ramp, expect ~150 sent on day one and the rest deferred as
`daily_cap_exhausted` or for want of profile capacity.

**Fail** — messages silently dropped, `consecutiveFailures` halting the pass
without a visible signal, or the same 50 retried forever because the batch order
never advances.

---

## 5. The SMS/iMessage kill switch

`outreach_settings.text_enabled` defaults to false and gates five independent
paths. A switch is only as strong as its least-covered path, so each is checked
separately.

| # | Path | Where |
| --- | --- | --- |
| 1 | Channel plan at enroll time | `channel-plan.ts`, `enroll.ts` |
| 2 | Mac worker queue | `/api/outreach/imessage-queue` |
| 3 | Reply auto-responders | `rules.ts` |
| 4 | Booking confirmations | `booking-confirmation.ts` |
| 5 | Flow engine send node | `flow-engine.ts` |

Path 5 exists because enrollments pin an immutable `flowVersionId`. An
enrollment created before the switch was thrown still walks the text nodes of
the graph it started on, no matter what today's setting says. It is the path
most likely to leak and the one hardest to reason about.

### 5.1 All five paths hold

**Automated.** `npx tsx scripts/verify-text-kill-switch.ts --problems`

The script checks outcomes in the database rather than reimplementing the logic:
texts sent after the switch went off, enrollments whose plan still contains a
text step, anything sitting in the worker queue, inbound replies answered by
text, and pinned flow versions whose graph still holds an active send-text node.

**Pass** — with `text_enabled = false`: zero texts sent since the switch, and any
enrollment pinned to a text-bearing flow version is walking past those nodes
rather than drafting at them.

**Fail** — any text sent while the switch was off. This is the highest-severity
failure in the plan: it is an unconsented message to a real person.

### 5.2 An enrollment pinned to an old flow version

**Automated.** vitest, `src/lib/outreach/text-switch-flow.test.ts`.

**Steps**

1. An enrollment whose `flowVersionId` points at a graph containing
   `send / channel: imessage`, with `currentNodeId` sitting on that node.
2. `text_enabled = false`.
3. Run the flow engine.

**Pass** — the node is skipped, a `rule_action` event with
`action: skip_text_step` is logged, and the enrollment advances. Nothing is
drafted.

**Important and deliberate:** the switch does **not** cancel messages already
queued. It holds them for a decision. So a non-zero queued count with the switch
off is expected, not a failure — but see [Finding 3](#finding-3-the-phone-backfill-stages-text-steps-while-the-kill-switch-is-off).

### 5.3 Flipping the switch on does not release a burst

**Manual. Contacts people. Rehearse first.**

This is the test [Finding 3](#finding-3-the-phone-backfill-stages-text-steps-while-the-kill-switch-is-off)
exists for, and the one most likely to surprise.

**Steps**

1. With the switch off, run `npx tsx scripts/verify-text-kill-switch.ts` and
   record the queued-text count and the number of enrollments parked on a text
   node with `next_step_at` in the past.
2. Before flipping the switch, confirm that count is what you intend to send in
   the first minutes after flipping.

**Pass** — the backlog is small and understood.

**Fail** — a large parked backlog. Every one of those fires on the first pass
after the switch goes on, with no warm-up ramp between them and the carrier.

### 5.4 Reply auto-responders and booking confirmations fall back to email

**Automated.** vitest, `rules.test.ts`, `booking-confirmation.test.ts`.

**Pass** — with the switch off, a positive reply that would have been answered by
text is answered by email instead, and a booking confirmation goes out by email.
Falling silent is a failure: the contact asked a question.

---

## 6. Twilio A2P SMS (built, inert)

The stack is complete but nothing calls `sendSms`, and it is gated on
`OUTREACH_SMS_ENABLED`. Carriers block unregistered A2P traffic outright, so a
half-configured environment must be inert rather than optimistic.

### 6.1 The flag is off unless exactly "true"

**Automated.** vitest, `src/lib/outreach/sms/provider.test.ts`.

**Pass** — `""`, `"1"`, `"yes"`, `"false"` are all off; `"true"` and `" TRUE "`
are on. Credentials alone are never enough.

### 6.2 With the flag off, nothing reaches the network

**Automated.** vitest.

**Pass** — `sendSms` with complete credentials and the flag off returns
`{ ok: false, retryable: false }` and `fetch` is never called. Non-retryable
matters: a caller that ignores the flag must not spin.

### 6.3 Webhook signature verification

**Automated.** vitest, plus a manual check on the deploy.

**Pass** — a request with a valid `X-Twilio-Signature` is accepted; an invalid
one is rejected; and with `TWILIO_AUTH_TOKEN` unset the endpoint returns 401
rather than trusting the payload. **Fail-closed is the requirement** — an unset
token must not mean "skip the check".

### 6.4 STOP writes a suppression

**Automated.** vitest.

**Pass** — an inbound STOP writes a suppression covering that number, and the
next send attempt against it is refused.

### 6.5 Permanent error codes

**Automated.** vitest.

Twilio 21610 (STOP-listed) and 30007 (carrier filtered) arrive as HTTP 400 but
are permanent. Retrying them burns quota and worsens carrier reputation.

**Pass** — both classified non-retryable despite the 400.

### 6.6 A real A2P send

**Manual. Costs money and contacts a person. Do not run before the A2P campaign
is approved.** Send to a phone you own, once, and confirm delivery and the
inbound STOP round trip.

---

## 7. Consent, lanes, and the dial gate

**Status: merged.** This work landed on `main` in PR #48 while this plan was
being written, so these tests are live rather than pending. `consent_records`,
`companies.lead_source`, phone classification, the dial gate, call outcome
logging and the opt-in link action are all present in
`src/lib/db/schema.ts` today.

### 7.1 No cold contact has a text path

**Automated.** `npx tsx scripts/verify-consent-gate.ts`

`suppressions` records how to STOP; `consent_records` records how permission was
GRANTED. Note that `sequence_enrollments.legal_basis` ("legitimate interest —
B2B recruitment outreach") is a cold-email posture, not consent to send SMS.

The script detects whether `consent_records` is deployed and asks the matching
question, so it is safe against an environment that has not had the migration
applied yet.

**Pass** — every live enrollment with a text target has an unrevoked
consent record whose `channel_scope` is `sms` or `both` and whose phone matches
that number.

**Expected and not a failure** — a `cold_discovery` lane row with a stored number
and no consent. That is exactly why the text channel is off. It becomes a
failure the moment one of them shows a send.

### 7.2 Consent is an artifact, not a flag

**Automated.** Part of `verify-consent-gate.ts`.

`disclosure_text` stores the wording the person actually saw at capture time. A
version tag or a pointer to today's copy would be worthless — the defence is
what was rendered then, not what is deployed now.

**Pass** — every consent record has non-empty `disclosure_text`. Web opt-ins also
carry `ip_address` and `user_agent`; a written request arriving by email
legitimately has neither.

**Fail** — an empty disclosure. That record proves a click and nothing else.

### 7.3 Revocation is honoured and preserved

**Automated.** Part of `verify-consent-gate.ts`.

**Pass** — no contact with `revoked_at` set has a text queued, and the revoked row
still exists. Revocation must be a tombstone, not a delete: proving somebody
opted out requires the row.

### 7.4 The dial gate blocks non-business lines

**Automated.** Part of `verify-consent-gate.ts`, which groups `call_outcomes` by
the class each number was dialed under.

Only `business_line` may be dialed. `unknown` is treated exactly like `mobile`,
because TCPA restrictions attach to the number type and an unclassified number
has to be assumed restricted.

**Pass** — zero calls logged against `mobile` or `unknown`.

**Fail** — any. A call logged against either is the gate having been bypassed.

### 7.5 The classification defaults are opposite on purpose

**Automated.** Part of `verify-phone-safety.ts`.

`contacts.phone_classification` defaults to `mobile`; `companies.phone_classification`
defaults to `business_line`. An unclassified contact number is assumed unsafe to
dial, an unclassified company number is assumed to be the main line. Both
defaults fail safe for their own table, in opposite directions.

**Pass** — the split is as expected. A large `unknown` bucket means the
classifier is not running; unknown is gated like mobile, so this degrades
availability rather than safety.

### 7.6 The opt-in form and lane assignment

**Manual.**

**Steps**

1. Submit the self-hosted opt-in form.
2. Inspect the resulting `consent_records` row and the company's `lead_source`.

**Pass** — a record with the verbatim disclosure, IP, user agent and
`source: web_form`; the company's lane is `inbound_form`. Every pre-existing row
and every discovery insert stays `cold_discovery`, so existing pipeline
behaviour is unchanged.

### 7.7 The unsafe dial is unreachable in the UI

**Manual.** Open a company whose only number is a mobile.

**Pass** — the dial control is absent or disabled, not merely a confirm dialog.
A gate that can be clicked through is not a gate.

---

## 8. Phone safety and data integrity

### 8.1 No switchboard is ever a text or dial target

**Automated.** `npx tsx scripts/verify-phone-safety.ts`

`contacts.phone` falls back to the company's main line when Apollo has no direct
dial, and `contacts.personal_phone` takes whatever ContactOut returns, including
a company number. Reading either directly aims a first-person text ("Hey, my
name is Alejandro, I've just emailed you") at a receptionist — and because every
contact at the firm falls back to the SAME line, all of them text one
switchboard. `pickPhone` exists to stop that.

The script checks the stored result rather than the function, in severity order:

1. an enrollment's `phone_number` equals its own company's main line
2. the number is labelled `kind = 'company'` in `contacts.phones`
3. the contact is classified `business_line` — for text the polarity is
   reversed from dialling, so a business line here is the switchboard
4. one number is the send target for several contacts, which is the shape of a
   switchboard nobody labelled

**Pass** — nothing in categories 1–3, and no number shared across companies.

**Fail** — a shared number across *different* companies is almost certainly a bad
number rather than a coincidence. Several contacts at *one* company sharing a
number is the classic unlabelled main line.

### 8.2 The city filter does not cross state lines

**Manual — expected to fail. See [Finding 2](#finding-2-the-review-queue-state-filter-matches-across-state-lines).**

**Steps** — filter city = `Springfield` with no state filter.

**Pass** — results are constrained to one state, or the UI makes the ambiguity
explicit.

**Fail** — Springfield IL, MA and MO all returned together, plus any company
whose HQ is elsewhere but which has a single job listing in a Springfield.

---

## 9. Failure modes

Each of these must fail **visibly**. A silent failure in an outreach system is
worse than a loud one: the operator believes mail is going out when it is not.

| Scenario | How to induce | Expected |
| --- | --- | --- |
| Provider 401 | Rotate a key to an invalid value on a staging deploy | Send fails, message marked failed with the reason, attempt count incremented. After **3** consecutive failures the pass halts, sets `summary.halted`, and emails an alert — no silent pile-up and no recovery burst |
| Provider 429 | Drive past the provider's rate limit | Retryable, exponential backoff `15 × 2^(attempts-1)` minutes — 15, then 30, then 60 |
| Provider 5xx | Provider outage, or a staging stub | Retryable with the same backoff, permanent at **3** attempts (`MAX_SEND_ATTEMPTS`) |
| Apollo cap reached | Set `providerDailyCap` low, then approve | `PaidEgressBlockedError`, a `blocked: true` row with `reason: daily_cap_reached`, and a clear UI message. **Not** a 500 |
| Warm-up capacity exhausted | Queue more than `min(50, 5+5×stage)` per domain | Remainder deferred with a reason and a Call List note; nothing dropped |
| Mac worker offline | Stop the worker | `/api/cron/check-worker` alerts. Texts stay queued, not failed |
| Anthropic drafting failure | Invalid key, or copy that fails the sanitizer | `throw new Error("draft failed sanitization")` — the step does not advance and no unsanitized copy is sent |

### 9.1 Sanitizer failure must not send

**Automated.** vitest.

**Pass** — when a draft fails sanitization the flow engine throws and no message
row reaches `queued`. Sending unsanitized copy is worse than sending nothing.

### 9.2 Cron authentication fails open when the secret is unset

**Manual — a real hole. See [Finding 5](#finding-5-cron-auth-and-the-discovery-endpoint-fail-open).**

**Steps** — `curl` the cron endpoints and `POST /api/discovery/run` from outside
the deployment, unauthenticated.

**Pass** — 401.

**Fail** — 200. `POST /api/discovery/run` has no authentication of any kind, and
the cron routes only check the secret `if (cronSecret)`.

---

## 10. Scale and stress, end to end

The three numbers in the brief, and where each actually binds.

| Load | Binding constraint | Degrades safely? |
| --- | --- | --- |
| 100 companies/day discovery | Human review throughput. 1–2 credits, negligible database load | Yes — the queue grows, nothing is lost |
| 25 approvals/day | **Apollo credits: 25–225/day.** The daily cap blocks further approvals | Yes, if the cap raises `PaidEgressBlockedError` visibly — verify [3.7](#37-scale-25-approvals-a-day) |
| Several hundred queued emails | Per-profile warm-up capacity (~150/day at full ramp across 3 domains), then `dailySendCap`, then the 50-per-pass batch | Yes — the remainder defers with a reason and a Call List note |

### 10.1 The combined day

**Manual. Costs money.** Run discovery, 25 approvals and a full dispatch pass on
the same day, then:

```bash
npx tsx scripts/check-schema-drift.ts
npx tsx scripts/verify-credit-spend.ts --days 1
npx tsx scripts/verify-discovery-idempotency.ts
npx tsx scripts/verify-text-kill-switch.ts --problems
npx tsx scripts/verify-phone-safety.ts --problems
npx tsx scripts/verify-consent-gate.ts
npx tsx scripts/verify-email-threading.ts --problems
```

**Pass** — all exit 0, and the day's Apollo spend matches the model within the
mobile-surcharge uncertainty.

### 10.2 The daily cap resets at UTC midnight, not on the business day

**Automated.** See [Finding 4](#finding-4-the-daily-send-cap-resets-at-utc-midnight-8-pm-eastern).

`sentTodayOnChannel` and `sentTodayByProfile` both use `setUTCHours(0,0,0,0)`, so
they agree with each other — but that boundary is 8 PM Eastern in summer. Sends
in the 8 PM–midnight ET window count against the next day's cap.

**Pass** — understood and intentional, or the boundary moved to Eastern.

---

## Rehearsal: testing without touching a stranger

Anything that sends must be rehearsed against an address or number the operator
controls before it goes near a prospect. `scripts/seed-test-leads.ts` and
`scripts/retire-all-seed-v12.ts` show how this was done before.

`seed-test-leads.ts` creates a company, contact and job listing and nothing
else — no enrollment, nothing drafted or queued — so the test drives the real UI
path: add to Call List → enroll → day 0 email and text → reply → auto-reply with
the booking link. It refuses to write when it would create a second record on a
lead's email or phone, because two records on one identifier is exactly what
makes an inbound reply ambiguous, and it refuses when either identifier is
already suppressed.

**The rehearsal loop**

```bash
npx tsx scripts/seed-test-leads.ts                                 # dry run
npx tsx scripts/seed-test-leads.ts --lead=<slug> --apply           # write it
# ... drive the flow from the UI, then:
npx tsx scripts/seed-test-leads.ts --lead=<slug> --remove --apply  # tear down
```

`--remove` deletes every row the company owns, children first, plus any
suppression the lead's own email or phone picked up during the test, and touches
nothing outside that company. That last part is what makes the round repeatable:
without clearing the suppression, the second round's enrollment would be
rejected.

**Rules for rehearsal leads**

- Use addresses and numbers the operator owns. Never a colleague's without
  asking; never a former prospect's.
- Rehearse on a domain that is **not** in the warm-up pool, or accept that the
  sends count against that domain's ramp and its bounce statistics.
- Tear down between rounds. A lead left in place makes the next round's inbound
  matching ambiguous.
- Before any real A2P text, confirm the campaign is approved. An unregistered
  send is blocked by the carrier and counts against the number's reputation.

---

## Automated versus manual, at a glance

**Automated — scripts** (all read-only, all safe, all free):

| Script | Answers |
| --- | --- |
| `check-schema-drift.ts` | Does the database have what the code expects? **Deploy gate.** |
| `verify-credit-spend.ts` | Did anything spend more than the model allows? |
| `verify-discovery-idempotency.ts` | Does a re-run duplicate work or overwrite a review decision? |
| `verify-text-kill-switch.ts` | Can text escape any of the five gates? |
| `verify-email-threading.ts` | Do follow-ups thread onto the first send? |
| `verify-phone-safety.ts` | Is anything aimed at a switchboard? |
| `verify-consent-gate.ts` | Could a cold contact be texted? Was a non-business line dialed? |

**Automated — vitest**: ICP band, company-first scoring, credit cost model,
per-channel caps, warm-up ramp, bounce thresholds, template retirement,
sanitizer, kill switch on a pinned flow version, SMS flag, Twilio signature,
STOP, error-code classification.

**Manual**: review queue UX and paging at 100 companies, inbox threading in
Gmail and Outlook, Resend deep links, the opt-in form round trip, the dial
control being unreachable, provider failure injection, deployment protection,
and every real send.

**Costs money**: discovery runs (1–2 credits), approvals (1 credit, +8 with a
mobile), "Find Additional Contact" (same), the 25-approval scale test
(25–225 credits), and any real A2P text.

**Contacts a real person**: real-inbox threading, the A2P send, flipping the
kill switch on with a backlog parked, and any dispatch pass against non-seeded
leads.

---

## The read-only guarantee

Every verification script goes through `scripts/lib/read-only-sql.ts`. These run
against production, so "read only" has to be a property of the connection rather
than a promise in a header comment. Two independent guards:

1. **Postgres enforces it.** Every statement is submitted as a one-statement
   transaction with `readOnly: true`, which is `SET TRANSACTION READ ONLY` on the
   server. An INSERT that slipped past review fails with "cannot execute INSERT
   in a read-only transaction" instead of running.
2. **The client refuses to send it.** The static fragments of each template are
   checked for a writing keyword before the query leaves the process, so a
   mistake surfaces as a thrown error naming the statement rather than a server
   round trip.

Interpolated values are parameterized by the driver and can never become SQL,
which is why checking only the static fragments is sufficient. The keyword list
is word-anchored, so `updated_at`, `created_at` and `outreach_settings` do not
trip it.

**This is tested, not asserted.** `scripts/lib/read-only-sql.test.ts` covers the
client-side half: the query shapes the scripts actually use are allowed,
identifiers embedding a keyword do not false-trip, every writing statement is
refused, and so are the two ways a write tries to hide — smuggled after a
leading `SELECT` (`select 1; drop table companies`) and concealed behind a
comment. `vitest.config.ts` includes `scripts/**/*.test.ts` so this runs with
everything else.

Postgres remains the real enforcement. The client check exists because a script
that gets as far as asking the server to DELETE has already lost the argument.

---

## Findings: things that look wrong

Found while reading the code for this plan. Each has a test above; each is
listed here because I expect it to fail.

### Finding 1: the Florida geo footprint collapsed from 36 cities to 8

**`main` is red right now.** `src/lib/georgia-geo-verification.test.ts` fails on
a clean checkout of `origin/main` — this is not caused by this branch.

The DB-backed Florida config returns 8 metro cities where the legacy WPB list
had 36. Everything in Broward is gone (Fort Lauderdale, Hollywood, Pembroke
Pines, Coral Springs, Pompano Beach, Davie, Sunrise, Plantation, Deerfield
Beach, Tamarac, Margate, Dania) along with most of Palm Beach County (Riviera
Beach, Royal Palm Beach, Greenacres, Palm Springs, Lake Park, North Palm Beach,
Juno Beach, Tequesta, Loxahatchee, Belle Glade, Palm Beach, Lantana, Hypoluxo,
Manalapan). "Lake Worth" also became "Lake Worth Beach".

If the DB-backed config is what production reads, the Florida scrape and match
footprint just shrank by roughly three quarters. Either the seed is incomplete
or the test encodes an intent the migration did not carry over. Worth resolving
before anything else here, because it silently shrinks the top of the funnel.

### Finding 2: the review queue state filter matches across state lines

`src/lib/discovery/review-queue.ts:119` builds `` `%${abbr}%` `` and applies it
as an unanchored `ILIKE` against `companies.state`. Apollo stores full state
names, so the pattern has to match "Georgia" as well as "GA" — but unanchored,
two letters match far too much:

- `IN` matches **Ill**in**ois**, Wash**in**gton, Virg**in**ia, M**in**nesota
- `GA` matches Michi**ga**n
- `OR` matches Ge**or**gia, N**or**th Carolina, N**or**th Dakota

Separately, `abbr` is the only pattern here not passed through `escapeLike` —
the full state name is escaped, the abbreviation is not. A filter value of `%`
becomes `'%%%'` and matches every row. It is parameterized, so this is
wildcard injection rather than SQL injection, but it is still user input
reaching a LIKE pattern unescaped.

The city filter has a related problem: `companies.city ILIKE '%Springfield%' OR
EXISTS (a job listing whose location matches)`. A company headquartered in
Boston with one listing in Springfield IL matches a search for Springfield.

Suggested fix: match `companies.state` on equality against both the
abbreviation and the resolved full name rather than on `ILIKE`, and escape
`abbr`. The job-listing side already anchors on `', ' || abbr`, which is the
right shape.

### Finding 3: the phone backfill stages text steps while the kill switch is off

`src/lib/outreach/phone-backfill.ts` never reads `outreach_settings.text_enabled`.
It calls `phoneIsTextEligible`, which checks only that a phone exists, that the
Mac worker confirmed iMessage capability, and that the number is not suppressed.
The switch lives one level up in `resolveChannelPlan`, which the backfill does
not call.

So with texting globally off, the backfill still attaches `phone_number` to live
enrollments and rewinds `current_node_id` onto a text node with
`next_step_at = now()`.

**No text escapes** — the flow engine's send-node gate (path 5) skips the node
and logs `skip_text_step`. The switch holds. But the flow engine deliberately
does not cancel what is already queued ("the switch holds them for a decision,
it does not cancel them"), and the backfill keeps parking more enrollments on
text nodes that are due immediately. The moment the operator flips the switch on,
every one of them fires on the first pass, with no warm-up between them and the
carrier.

This is why [5.3](#53-flipping-the-switch-on-does-not-release-a-burst) exists.
The fix is a one-line `text_enabled` check in the backfill, so that a backfilled
enrollment is never in a state a fresh enrollment could not have reached — which
is the stated intent of the code immediately above it.

The backfill's idempotency is sound, incidentally: the update is guarded on
`phone_number` still being null, so a concurrent dispatch pass cannot
double-attach.

### Finding 4: the daily send cap resets at UTC midnight (8 PM Eastern)

`sentTodayOnChannel` and `sentTodayByProfile` both use `setUTCHours(0,0,0,0)`.
They agree with each other, so there is no inconsistency between the cap and
warm-up accounting — but the business day is Eastern everywhere else in this
codebase (`call-list-sync.ts` stamps Eastern precisely so rows read as the day
they happened, and `DEFAULT_TIMEZONE` is `America/New_York`).

UTC midnight is 8 PM EDT. A send to a Pacific contact at the end of their
business window is 8 PM Eastern or later, so it counts against tomorrow's cap.
Low severity, but it makes "how many did we send today" mean two different
things depending on who is asking.

### Finding 5: cron auth and the discovery endpoint fail open

There is no `middleware.ts` in this repository and no authentication library in
`package.json`. Application-layer auth does not exist; the deployment is
presumably protected by Vercel Deployment Protection.

That matters more than usual for one route. `POST /api/discovery/run` has no
authentication of any kind and spends Apollo credits on each call. If deployment
protection is ever off — a preview deployment, a misconfiguration — it is an
open, unauthenticated, credit-spending endpoint.

The cron routes are better but still fail open:

```ts
if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

With `CRON_SECRET` unset the check is skipped entirely. Compare the Twilio
webhook, which gets this right by returning 401 when `TWILIO_AUTH_TOKEN` is
missing. The cron routes should do the same: a missing secret should mean "refuse
everything", not "allow everything".

### Finding 6: `sendSms` answers to a different switch than the operator's

`sendSms` → `resolveSmsProvider` checks `OUTREACH_SMS_ENABLED` and the Twilio
credentials. It never reads `outreach_settings.text_enabled`.

Today this is harmless: nothing calls `sendSms`, so the path is genuinely inert
and the environment flag is the only gate that matters. But there are now two
independent kill switches with no relationship between them, and the one the
operator can see in Admin is not the one guarding the Twilio path. The first
person to wire `sendSms` into the flow engine will reasonably assume the Admin
switch covers it.

Worth either making `sendSms` consult `text_enabled`, or adding a test asserting
that nothing imports it — so that wiring it up forces the question.
