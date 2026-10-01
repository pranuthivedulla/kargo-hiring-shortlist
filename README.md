# Kargo Hiring Shortlist

Ranks candidates for Kargo's two open product roles against a pattern calibrated
from past hires, shows the reasoning, and leaves every decision to Arjun. The
tool never decides and never sends anything on its own.

## Run it

```bash
npm install
cp .env.example .env.local   # fill in the keys you have
npm run dev                  # http://localhost:3000
```

`npm run dev` uses Turbopack's HMR websocket. If you are previewing inside a
sandboxed browser pane where that websocket is blocked, React will not hydrate
and the page stays on "Loading…". Use `npm run build && npm start` there.

## Data

Everything lives in `data/`, read fresh on every run. Replace the files and the
behaviour changes; no code edit needed.

```
data/applications/PM/     15 CVs that named the role      (committed)
data/applications/SPM/    15 CVs that named the role      (committed)
data/applications/OPEN/   30 CVs that named no role       (GITIGNORED - see below)
data/hires/               8 past-hire CVs + outcomes.json (committed)
data/jds/                 PM.pdf, SPM.pdf
data/_fixtures/           invented corpus used by the tests
data/runs/                one JSON file per batch run     (local scratch)
data/decisions.json       Arjun's advance/reject record   (local scratch)
```

Role comes from the folder a CV sits in, falling back to a `PM`/`SPM` token in
the filename. A CV that resolves to neither is filed under `OPEN` and flagged,
rather than being guessed into a pool where a wrong guess is invisible.

### `data/applications/OPEN/` is not in git, deliberately

Thirty of the sixty CVs arrived with no role on them, and they are **real
people's documents** — names, email addresses and eleven phone numbers. They are
gitignored and must not be committed, must not be seeded into the deployed
database, and are the reason `RESEND_API_KEY` is kept out of the Vercel
environment: the deployed site is public for grading, and a stranger clicking
Reject must not be able to email a real person on behalf of a company that does
not exist.

The other thirty CVs and the eight past-hire CVs are course-generated and carry
no real personal data, so they are committed and safe to deploy.

### The OPEN pile is ranked as its own list

`lib/rank.ts` has a second prompt, `TRIAGE_SYSTEM_PROMPT`, used only for `OPEN`.
It gates against **both** job descriptions, records a `recommended_role` per
candidate with a one-line rationale, and ranks the whole pile as one list.
`RANKING_SYSTEM_PROMPT` is specified verbatim for "a single open role" and is
never edited — the triage prompt is separate and reuses the same gate/signal
vocabulary so the dashboard reads both kinds of run identically.

This keeps every run inside the brief's 30-per-run cap. Merging the OPEN CVs
into the PM and SPM pools would have pushed those past 30, and splitting a role
across two batches would quietly change the ranking, which is relative across
the batch.

### Fixtures

`data/_fixtures/` holds an invented corpus — 18 CVs and 8 hire profiles — used
by the test suite so tests never touch real candidates' CVs or write them to the
production database. Tests set `DATA_DIR=data/_fixtures` through
`scripts/use-fixtures.mjs`, which must be imported before any `lib/` import
because ES module imports are hoisted.

Regenerate with `python scripts/make_fixtures.py`.

## The five stages

1. **Ingestion** — `lib/ingest.ts`. PDF via `unpdf`, DOCX via `mammoth`. Original
   files are never modified. A scanned or unreadable CV is kept with a
   `parseError` and still goes to the model, flagged.
2. **Gate + rank** — `lib/rank.ts`, `POST /api/run`. One Claude call per role,
   capped at 30 CVs. The system prompt is used verbatim and must not be
   paraphrased: the UI reads the vocabulary it defines.
3. **Dashboard** — `app/page.tsx`. Role tabs, gate summary, ranked cards with
   "Why ranked here" and "What to probe" always visible, and a collapsed
   "Not advancing — with reason" panel.
4. **Decision** — `POST /api/decide`. Arjun's click is the only thing that
   changes a status. It writes `decisions.json`, fetches a Calendly link (on
   advance) and drafts the message. **It does not send.**
5. **Send** — `POST /api/send`. Reached only from the confirm dialog, only for a
   decision already on disk.

## Two guarantees, enforced in code

**Nobody disappears.** The prompt says every candidate appears in the output.
`runBatch` checks that independently: any candidate the model failed to return
is added to "not advancing" with a reason saying so, rather than vanishing.

**Nothing sends on a click.** `/api/decide` records the decision and produces a
draft; `/api/send` is a separate call that only the confirm dialog makes. This
is a deliberate departure from the original spec, which had the decision click
fire the email directly — one misclick would have put an irreversible rejection
in a real candidate's inbox. A failed send leaves the decision recorded and
marks the message retryable.

The drafting call is told the outcome and nothing else. Signals, evidence and
rank are never passed to it, so an internal assessment has no route into a
candidate's inbox.

## Environment

| Variable | Needed for | Behaviour when unset |
|---|---|---|
| `ANTHROPIC_API_KEY` **or** `GEMINI_API_KEY` | ranking, drafting | ranking refuses; drafting falls back to a fixed template |
| `RESEND_API_KEY`, `RESEND_FROM` | sending | send fails with a clear error; decision is kept |
| `BOOKING_URL` | booking link | falls through to the options below |
| `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` | free/busy slots | falls through |
| `CALENDLY_API_KEY`, `CALENDLY_EVENT_TYPE_URI` | single-use links | invite asks for times instead of linking |
| `SEND_OVERRIDE_TO` | testing | addresses come from CVs — see the warning above |
| `DATABASE_URL` | storage | falls back to JSON files under `data/` (local only) |
| `RANK_STUB=1` | testing | batch runs return a canned response, no API call |

### Provider

The brief specifies the Claude API. Gemini is supported as well, because that is
the key available on this machine. `lib/model.ts` is the only file that talks to
a model: it picks Anthropic when `ANTHROPIC_API_KEY` is set, otherwise Gemini,
and `MODEL_PROVIDER=anthropic|gemini` forces one. Each run file records which
provider and model produced it, so no result is unattributable.

Gemini goes through the Interactions API (`/v1beta/interactions`, `x-goog-api-key`)
with **no tools** — this task reads the CVs it is given and must not go looking
for candidates online. Models: `ANTHROPIC_MODEL` (default `claude-opus-5`),
`ANTHROPIC_DRAFT_MODEL` (default `claude-sonnet-5`), `GEMINI_MODEL`
(default `gemini-3.8-flash`).

## Adding CVs

Two ways in, both landing in the same place:

- **Upload from the dashboard** — the *Add CVs* panel takes PDF, DOCX, TXT or
  MD. The file is parsed in the request and only its extracted text is stored;
  the original is never read again, so no blob storage is needed on a platform
  with a read-only filesystem. The role comes from the tab you are on, falling
  back to the filename and then to the OPEN pile.
- **Drop files into `data/applications/<ROLE>/`** and run a batch, which
  re-ingests from disk first.

`lib/store.ts`'s `allCandidates()` merges both by id, and **ranking reads that
merge, not the disk listing**. Without it an uploaded CV would be stored and
then silently skipped by the next batch, which is the bug this was built to
avoid.

Uploading never ranks. Ranking is a separate, explicit action — and a full
batch exceeds this platform's function limit in any case (see below).

## Storage

`lib/store.ts` is the only thing that writes at runtime. Two backends, same
interface, chosen by whether `DATABASE_URL` is set:

- **unset** — JSON files under `data/`. Fine locally.
- **set** — Postgres (Neon). **Required on Vercel.** Its filesystem is read-only
  apart from `/tmp`, which is per-invocation and not shared between instances,
  so file writes there either fail or vanish — and the decision record vanishing
  defeats the point of the tool.

Create the tables once: `psql "$DATABASE_URL" -f db/schema.sql`.

The CVs, job descriptions and calibration profiles are **not** in the database.
They never change while the app runs, so they ship inside the repo. That needs
`outputFileTracingIncludes` in `next.config.ts` — Next's tracer cannot see files
read through `fs` at request time, and without it production fails with
"No job description found" while local works fine.

### Sending from a deployment

A deployed instance that can send is one anyone with the password can send
from, to addresses read out of CVs — and those are real inboxes. So in
production `sendEmail` refuses unless one of these is set:

- `SEND_OVERRIDE_TO` — every message goes to that one address and no CV address
  is used. This is how the deployment is configured.
- `ALLOW_REAL_SENDS=1` — deliberate opt-in to emailing real candidates.

> **Before committing real CVs:** these are candidates' names, emails and work
> histories. Do not push them to a public repository. Either keep the repo
> private or move `data/applications/` to object storage.

## Scheduling

Four paths, each degrading to the next:

1. **`BOOKING_URL`** — a Google Calendar Appointment Schedule's public page.
   This is what is in use. Appointment Schedules are a Workspace feature and
   give the candidate real availability to choose from. There is **no API** to
   create or read them: the URL is made by hand once, so it is **one link for
   everyone, not single-use per candidate**. Anyone who receives it could
   forward it.
2. **Google OAuth** (`lib/gcal.ts`) — reads free/busy and offers real open
   slots in the email, at most two per day so options span the week. Scope is
   `calendar.readonly`: the app never writes to the calendar and never sends an
   invite nobody asked for. Set up with `npx tsx scripts/google-auth.mjs`.
   Written and compiling, but **not exercised against live Google credentials**.
3. **Calendly** — genuine single-use links, if `POST /scheduling_links` is
   available on the plan.
4. **Nothing** — the email asks the candidate to reply with times.

Interview length comes from `INTERVIEW_MINUTES` (default 45) and is shared by
the email text and the slot finder, so the two cannot disagree.

## Why batches run from the CLI

Measured on the real corpus with `gemini-3.8-flash`:

| Batch | CVs | Time |
|---|---|---|
| PM | 15 | 127.1s |
| SPM | 15 | 137.1s |
| OPEN | 30 | 147.6s |

Vercel's Hobby tier caps a function at **60 seconds**, so *Run batch* times out
on the deployment. Batches run from a laptop with `npx tsx scripts/run-live.mjs`
and write to the same database the deployed app reads.

The obvious workaround — splitting a role into smaller batches — is **not**
done, deliberately. STEP 4 ranks candidates against each other, so the model
has to see the whole batch. Chunking would quietly produce a different, worse
ranking while appearing to work.

## Tests

```bash
npx tsx scripts/test-ingest.mjs   # parsing, role tagging, name extraction
npx tsx scripts/test-rank.mjs     # corpus loading + a stubbed batch run
```
