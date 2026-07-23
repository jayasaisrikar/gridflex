# GridFlex Console — A Plain-English Guide

This document explains every page in the GridFlex console: what you see, what each
button does, and why it matters. No prior knowledge assumed.

---

## First, the big picture

GridFlex answers one question for a facility (like a data centre):

> **"How much electricity can this site safely stop using, on demand — and can you prove it?"**

That number is worth money. Grid operators pay facilities to reduce power when the
grid is stressed. But nobody will pay for a number somebody just typed in. They want
proof.

So the whole console is built around one idea: **never mix a guess with a measurement.**
Every capacity number carries a label saying where it came from:

| Label | Plain meaning | How much to trust it |
|---|---|---|
| **Declared** | A human typed it in. | Lowest. It's a claim, not evidence. |
| **Modeled** | Calculated from real meter readings. | Medium. Based on data, but not directly tested. |
| **Tested** | Proven by an actual test where load really dropped. | Highest. This is real evidence. |
| **Simulated** | Produced by the built-in fake-data generator. | Useful for practice. Proves nothing about the real world. |

You'll see these words everywhere as small coloured tags. They're the point of the
product, not decoration.

### The journey through the app

The eight pages are really one path, in order:

```
1. Connectors   →  Where does the data come from?
2. Telemetry    →  Is the data good enough to trust?
3. Facility     →  What are the safety rules we must never break?
4. Envelope     →  Given all that, how much can we safely cut?
5. Drills       →  Let's actually test it and see what happens.
6. Passport     →  Seal the proof into a document we can hand to a customer.
7. Audit        →  A permanent record of everything anyone did.
```

The **Overview** page sits on top and tells you which step you're on.

---

## Things you'll see on every page

**The left sidebar** lists all eight pages. The current one is highlighted.

**"Go to…" button (or press ⌘K / Ctrl+K)** opens a search box. Start typing a page
name and press Enter to jump there. Arrow keys move up and down the list, Escape
closes it.

**Bottom of the sidebar** shows the facility name, its region/market/timezone, a dot
showing whether simulated data is present, and a **Sign out** button.

**On a phone**, the sidebar collapses into a menu button in the top bar.

**The "SIM" banner** appears across the top when any simulated data exists for this
facility. It's a warning: results on screen may come from the fake-data generator, not
real equipment. If GridFlex can't work out where the data came from, the banner instead
shows **"CHK"** and warns you to treat results as possibly simulated. It deliberately
assumes the worst rather than claiming data is real.

**The footer** lists the version numbers of the calculation methods used, so a reviewer
can tell exactly which version of the maths produced your numbers.

---

## 1. Overview — *"What should I do next?"*

The home page. It answers "where am I, and what's the next thing to do?"

### Next safe action
A single big suggestion box. It looks at your progress and tells you the one thing to
do next, with a button that takes you there. It works down this list and shows the
first unfinished item:

1. No data source connected → **"Activate a telemetry source"**
2. Data quality too poor → **"Restore drill-ready telemetry"**
3. No capacity calculated yet → **"Compute the first envelope"**
4. Never run a test → **"Prove the declared capability"**
5. No Passport issued → **"Issue the first Passport"**
6. All done → **"Share verified evidence"**

If you're ever unsure what to do, this box is the answer.

### Readiness strip
Three quick numbers: current power draw right now (kW), how many data connectors are
working (e.g. "3/4 active"), and whether a Passport has been issued.

### Reducible capacity by evidence class
Three panels side by side: **Tested**, **Modeled**, **Declared** — each showing a kW
figure.

**These are deliberately NOT added together.** A single "600 kW available" headline
would blend a real measurement with somebody's guess, which would look impressive and
be dishonest. Keeping them apart lets you see how much of your capacity is actually
proven. If Tested shows 0 kW, nothing has been proven by a real test yet, and the panel
says so directly.

### Current envelope
Your headline capacity number in kW, plus:

- **Confidence** — a score from 0 to 1. Higher means better-backed by evidence.
- **Binding constraint** — which safety rule is the bottleneck. This is the single most
  useful field for improving your number: it tells you what to fix.
- **Aggregate ramp** — how fast you can shed load, in kW per minute.
- **Sustainable duration** — how many minutes you can hold the reduction.
- **Response time** — seconds from "go" to load actually dropping.
- **Methodology** — the version of the calculation used.

If nothing has been calculated yet, you get a button to go and do it.

### Data quality · last 24h
- **Completeness** — what percentage of the last 24 hours has meter readings. **90% is
  required** before the system will calculate anything.
- **Last reading** — how long ago the newest reading arrived.
- **Source health** — how many connectors are active.

### Most recent drill
If you've run a test, a summary: energy delivered vs. promised, performance as a
percentage, and average kW achieved vs. requested. A button opens the full proof.

---

## 2. Telemetry — *"Is our data good enough?"*

This page is about the meter readings themselves. It covers the last 24 hours of the
`facility.active_power_kw` measurement (how much power the site is drawing).

### The four top boxes
- **Current load** — latest reading, in kW.
- **Completeness** — percentage of expected readings actually present, shown as e.g.
  "1440 / 1440 intervals". One reading per minute is expected.
- **Observed range** — lowest and highest power over the window.
- **Drill readiness** — **Ready** or **Blocked**. Blocked means you cannot run a test.

### The load chart
A 24-hour line graph of power draw, with two reference lines drawn on it: your
**minimum safe load** (never go below this) and your **normal load**.

Only trustworthy readings are plotted. Readings marked suspect are excluded and counted
separately ("N suspect excluded"). If the window has more than 5,000 readings, only the
most recent 5,000 are drawn, and the page says so rather than quietly hiding data.

### Quality gates
A table showing each rule, the threshold, your actual figure, and Pass or Blocked.

| Gate | Requirement | What it stops if failed |
|---|---|---|
| Completeness for envelope | ≥ 90% | Can't calculate capacity |
| Completeness for Passport | ≥ 90% over 24h, and fresh | Can't issue a Passport |
| Staleness | newest reading within 2 intervals + 60s | Can't do anything |

**This is where the "envelope is blocked" message comes from.** If completeness is
below 90%, the system refuses to calculate — on purpose. It would rather give you
nothing than give you a number built on missing data.

A note under the table is honest about a limitation: this pilot checks 24 hours, but a
real production certification should check at least 14 days with a stricter target.
The product doesn't pretend otherwise.

### Previewed CSV import
Upload meter readings from a spreadsheet file.

**Nothing is saved on upload.** GridFlex reads the file and shows you a preview first:
the time range covered, the interval spacing, and any rows it would reject. Only after
you confirm does anything get written. This stops a bad file from silently poisoning
your evidence.

Required columns: `metric_key`, `measured_at`, `value`, `unit`.
Optional: `quality`, `source_sequence`.

### Quarantine
Readings that were rejected — bad rows, or duplicates that contradict each other.

They're kept, not deleted. Each shows a reason code and the original raw data, so you
can look at exactly what arrived and why it was refused. **Quarantined readings never
count towards any calculation.**

---

## 3. Envelope — *"How much can we safely cut, and why that number?"*

The envelope is your capacity figure. This page exists to make the number
**explainable**, not just visible. Anyone should be able to see how it was reached.

### If blocked
A red panel lists each reason with a code and a plain explanation — for example,
telemetry completeness being too low. Fix the reason, then recompute.

### The four headline boxes
- **Total reducible** — the number itself, in kW, and which rule limited it.
- **Aggregate ramp** — kW per minute you can shed.
- **Sustainable duration** — minutes you can hold it, set by the *shortest*
  contributing mechanism (the weakest link decides).
- **Confidence** — 0 to 1, labelled Tested basis / Modeled basis / Declared basis.

### Capacity by mechanism
A bar chart. A "mechanism" is a specific way the site can reduce power — pausing
computing jobs, easing off cooling, switching to batteries. Each bar's length is its
kW contribution, coloured by evidence class.

### Per-mechanism detail
A table with one row per mechanism: its evidence class, reducible kW, ramp rate,
duration, and confidence. This shows exactly which parts of your total are proven and
which are just claimed.

### How confidence was derived
The most unusual panel in the app: a line-by-line ledger of every adjustment made to
the confidence score, in order, each with the amount (+ or −) and a written reason —
then the final figure.

So instead of "confidence: 0.72, trust us", you can read the full arithmetic. The last
row notes that confidence is **capped at 0.95** until an outside reviewer or a real
production event is on record. The system will never claim near-certainty about itself.

### Recompute envelope
Recalculates from current constraints, mechanisms, and telemetry. The old version isn't
overwritten — it stays in the audit trail, so past decisions remain reproducible.

---

## 4. Facility & Safety — *"What are the rules we must never break?"*

Setup for the physical site and, more importantly, its safety limits. As the page says:
**configuration is evidence.** Every change here is versioned and audited.

### Readiness gates
A checklist with ticks and crosses:
- Normal facility load is declared
- An active safety-constraint version exists
- At least one mechanism is enabled
- Every enabled mechanism has a declared reduction cap

### Active safety limits
The hard boundaries the system must respect:

| Limit | Plain meaning |
|---|---|
| **Minimum safe load** | Never drop power below this. The most important number here. |
| **Maximum curtailment** | Most kW we may ever cut at once. |
| **Maximum ramp** | Fastest we may cut, in kW/min. Sudden changes can damage equipment. |
| **Maximum duration** | Longest we may stay reduced. |
| **Minimum recovery** | Rest time required before another test. |
| **Maximum rebound** | Cap on the power spike when everything switches back on. |
| **Thermal limit** | Temperature ceiling. |
| **Excluded workloads** | Jobs that must never be touched. |
| **Source note** | Which approved procedure or person these limits came from. |

### Create safety revision
Changing limits creates a **new version**. Old versions are never edited or deleted.
This means an envelope calculated last month can still be checked against the limits
that were actually in force at the time. Nothing is retroactively rewritten.

### Flexibility mechanisms
Each way the site can reduce power. Types: **Workload**, **Cooling**, **Storage**,
**Other**. For each you set the declared reduction (kW), minimum load, ramp rate,
maximum duration, rebound window, a control reference, and a description of what
actually changes operationally when it's used.

The **Enabled** checkbox controls whether it counts towards capacity. Disabling it
keeps the record in the audit history but contributes zero capacity — history is never
erased.

### Facility identity & load
Name, slug, timezone, country, region, market, plus baseline figures: normal load,
minimum safe load, maximum curtailment, ramp limit, cooling reserve.

---

## 5. Drills — *"Let's actually test it."*

A drill is a controlled test: deliberately reduce power, measure what really happened,
and turn that into evidence. This is how capacity gets promoted from *declared* to
**tested**.

> **Important for this release: simulation-only mode is locked on.** No command can be
> sent to physical equipment. Drills exercise the full approval and evidence process
> using the built-in simulator. The workflow is real; the electricity is not.

### Drill ledger
Every drill plan with its status and requested reduction. Statuses: DRAFT, READY,
ARMED, RUNNING, VERIFYING, COMPLETED, FAILED, ABORTED, CANCELLED. **No status can be
edited by hand** — it only changes by taking a real action.

### Plan a drill
You need a current envelope first. You set a name, requested reduction in kW (capped at
your envelope), planned ramp, start and end times in UTC, and operator notes that become
part of the review record.

Creating a plan **does not arm or start anything.** Those are separate, deliberate
steps.

---

## 5b. Drill detail — the proof chain

Opening a drill shows its complete evidence trail.

### Next controlled action
Only the single legal next step is ever offered, based on current status:

| Status | What you can do |
|---|---|
| **DRAFT** | **Validate safety gates** — check reduction, duration, ramp, envelope, telemetry freshness, and emergency-stop state. |
| **READY** | **Arm** — requires confirming a one-time challenge with a frozen copy of the safety limits. |
| **ARMED** | **Start drill**, or **Abort** with a reason code. |
| **RUNNING** | **Complete sustain window**, or **Emergency stop**. |
| **VERIFYING** | **Verify evidence** — seal the result. |
| Finished | Nothing. It's read-only forever. |

**Emergency stop** is always available while running, with a safe reason code already
filled in so nothing delays the stop.

### Results
Delivered energy (kWh) vs. committed, performance percentage, average kW delivered vs.
requested, and telemetry completeness with the longest gap.

### Baseline versus actual load
A chart with two lines: what power *would* have been used (baseline) and what was
actually used. **The gap between them is the energy you delivered.**

### The proof chain — 8 stages
1. **Plan** · 2. **Validation** · 3. **Operator arming** · 4. **Execution** ·
5. **Telemetry** · 6. **MRV** · 7. **Evidence hash** · 8. **Passport**

Each is marked **Verified**, **Recorded**, or **Not reached**, with a timestamp and who
did it.

The critical detail: **these stages are read from the permanent event log, not from a
checklist.** If an event was never written to the database, the stage shows as "not
reached". The page physically cannot claim a step happened when there's no record of it.

("MRV" = Measurement, Reporting and Verification — the standard term for proving energy
was actually delivered.)

### Evidence digest
A long SHA-256 code — a fingerprint of the sealed evidence. Change one character
anywhere in the record and the fingerprint changes completely.

An outside reviewer can recompute it themselves and confirm nothing has been altered.
The rules that make this repeatable: keys sorted alphabetically, timestamps in UTC,
decimals stored as text, no stray whitespace.

### Method and limitations
Deliberately states what the numbers *don't* prove:
- **Missing intervals count as zero delivered energy** — never guessed or filled in.
- **Rebound is reported separately** — never subtracted to flatter the result.
- **Exact integer watt-hours** — no floating-point drift.
- If simulated: **this drill does not evidence real-world delivery.** Stated plainly.

---

## 6. Passport — *"The document we hand to a customer."*

The Flexibility Passport is the finished product: a sealed, versioned, independently
verifiable record of what this facility can do and how well that's proven.

### Issuance gates
- A current envelope exists
- Envelope telemetry completeness ≥ 90%
- Current telemetry window complete and fresh
- *(Optional)* A verified drill attached, for stronger evidence

Issuing without a drill is allowed, but the Passport records that absence as a stated
limitation rather than hiding it.

### What's inside
Current capability in kW, data completeness sealed at the moment of issuance, how many
drill records are included, and status.

### Independent verification
Two SHA-256 fingerprints — one for the Passport, one for the underlying evidence — each
with a copy button, plus instructions for checking them yourself. A green **"Hashes
match"** tag means the document is intact and unmodified.

This is what makes the Passport trustworthy to someone who has no reason to trust you:
they don't take your word for it, they recompute the fingerprint.

### Capability provenance
Every mechanism with its evidence class, kW, and confidence — so the reader can see
which parts are proven and which are claimed.

### Limitations carried with this version
An explicit list of what this Passport does *not* prove, travelling with the document
so it can't be separated from the claim.

### Reviewer export
A shareable link (**audited, and expires after 7 days**) or a direct download of the
canonical JSON.

### Version ledger
Every Passport ever issued. Issuing a new one never edits the old one — superseded
versions stay verifiable forever.

---

## 7. Connectors — *"Where does the data come from?"*

Data sources. Each reading must be traceable to a known origin.

### Source ledger
One card per source: status (ACTIVE / ERROR / DISABLED), last successful reading, last
sync, poll interval, and whether encrypted config is stored. Errors show in a red box.

**Credentials are encrypted and never shown back on screen** — not even to you.

Per source you can:
- **Test source** — check it works without ingesting anything.
- **Queue simulator sync** — fetch a batch (simulator sources only).
- **Enable / Disable** — disabling requires expanding a confirmation that warns
  it will make your telemetry, envelopes, and Passports go stale.

### Add a pilot source
- **Deterministic simulator** — generates realistic fake data. Same seed, same numbers
  every time, so results are reproducible. Always labelled as simulated.
- **Previewed CSV upload** — the file workflow described under Telemetry.

Poll interval: minimum 30 seconds (CSV ignores this). Other connector types appear in
the system as records but aren't operational in this build — and the page says so
instead of implying they work.

---

## 8. Audit — *"Who did what, and when?"*

A permanent, combined history of configuration changes and drill events.

### Evidence contract
**Audit rows and drill events cannot be updated or deleted.** A later record can add a
new status, but it never rewrites what came before. This is the guarantee that makes
everything else believable.

### Activity timeline
Newest first, up to 100 entries. Each shows what happened, when, and what it affected.
A tag distinguishes **Audit** (configuration changes) from **Drill event** (test
lifecycle) — combined for convenience, but never blurred together.

Expanding an entry shows the actor (which operator or automated service), the object
ID, the source row, and the complete raw record. Drill entries link straight to their
proof chain.

Coloured dots flag entry types at a glance: red for aborts, emergency stops, failures
and errors; green for verified and completed.

---

## Quick reference

### The numbers that block things
| Threshold | Blocks | Where to check |
|---|---|---|
| Telemetry completeness < 90% | Envelope calculation | Telemetry → Quality gates |
| Completeness < 90% or stale | Passport issuance | Passport → Issuance gates |
| No fresh reading | Everything | Telemetry → Staleness |
| Confidence cap 0.95 | Always applies | Envelope → How confidence was derived |

### Jargon decoder
| Term | Plain English |
|---|---|
| **Envelope** | How much power you can safely cut right now. |
| **Mechanism** | One specific way to cut power (workload, cooling, storage). |
| **Drill** | A controlled test of your capability. |
| **MRV** | Measurement, Reporting, Verification — proof energy was delivered. |
| **Baseline** | What power *would* have been used without the drill. |
| **Provenance** | Where a number came from and how much to trust it. |
| **Completeness** | What share of expected meter readings you actually have. |
| **Stale** | The newest reading is too old to rely on. |
| **Quarantine** | Rejected readings, kept for inspection, excluded from maths. |
| **Canonical JSON** | Data written in one strict format so its fingerprint is repeatable. |
| **SHA-256** | A fingerprint that changes completely if anything is altered. |
| **Rebound** | The power spike when everything switches back on afterwards. |
| **Ramp** | How fast power changes, in kW per minute. |
| **Passport** | The sealed, shareable proof document. |

### The one thing to remember
Every unusual behaviour in this console — refusing to add numbers together, blocking
at 90%, capping confidence at 0.95, keeping rejected rows, never deleting history —
exists for the same reason:

**a number you can't defend is worse than no number at all.**
