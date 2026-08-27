# voiceagent-st-webhook

Express service behind Retell voice agents: matches callers to ServiceTrade locations, creates jobs
post-call, and sends the client notification emails.

## Read first

- `docs/session.md` — what changed recently, why, what is still outstanding, and the decisions that
  must not be quietly reverted.
- `docs/adaptive-call-flow.md` — the Adaptive Climate escalation contract across all three
  codebases.

## The thing that catches people out

`google-sheet/` and `retell/` are **gitignored** (`.gitignore:152`, `:75`) but hold **live
production code**: the deployed Apps Script `Code.gs` and the Retell agent configs.

**And the mirror has drifted.** As of 2026-08-28, 11 of 53 functions in `google-sheet/code.gs`
differ from the deployed script — the mirror is ahead on a partly-deployed test-row diversion,
and behind on a config rename. So it is not a record of what is running: **read the live editor
before assuming, and never paste the mirror in wholesale** — that would ship undeployed work
into emergency dispatch as a side effect. Details in `docs/session.md` (2026-08-28).

Changes there appear in no diff, no commit and no PR, and reach production only by being pasted
into the Apps Script editor and the Retell dashboard. A PR touching this flow is usually **not** the
whole change — check those directories before assuming otherwise, and say plainly when work lands
outside git.

## Live consoles (browser)

The two gitignored production surfaces are edited in a browser, not in this repo. Their URLs, so a
session can reach them without hunting:

| What | URL |
|---|---|
| Escalation state sheet — `Adaptive Inbound -> Outbound Sheet`, `Sheet1` cols A–AC | https://docs.google.com/spreadsheets/d/1qEOZEKBmZlkRWOM7gwpZcBnpCmL8ip9vnFbXoRAwhfg/edit?gid=0#gid=0 |
| Apps Script project `Adaptiveclimates oc-outbound` — the deployed `Code.gs` mirrored at `google-sheet/code.gs` | https://script.google.com/u/0/home/projects/1hrLa2f3kFAHqhZnT-w46aDBWfKnWLtEbz_HDNN-xIcyVleiB8FJehOj1/edit |
| ServiceTrade API reference — `GET /location/{id}` | https://api.servicetrade.com/api/docs/tag/location/GET/location/%7Bid%7D |

To open them: invoke the `claude-in-chrome` skill, pick the browser when prompted (the working one
is named **extended laptop**), then navigate a tab per URL. The Google pages need the signed-in
Chrome profile — they will not load in a fresh anonymous context.

The sheet is the live escalation state machine, and the Apps Script editor is the only path to
production for `Code.gs`. Read there freely; do not edit or run either without being asked.

## Deliberate — confirm before changing

These look like bugs and are not. Each was raised and kept:

- an **inactive** ServiceTrade location does NOT block dispatch or job creation. The
  technician is called, told, and their yes or no decides the job. Reversed deliberately
  on 2026-08-14 — see `docs/session.md` §4. **Nor does `none`**: corrected 2026-08-27,
  this said "only `none` is terminal", but `code.gs:1196-1216` dials on every verdict.
  A `none` address is dispatched too; the technician is told it is not on file, and the
  job is created by hand afterwards
- the technician alert CCs the client addresses
- when the on-call tech has an email but no phone, a backup contact is dialled while the tech is
  still the one emailed
- only the on-call technician is ever emailed; backup contacts are dialled cold
- a test call creates a real ServiceTrade job against a real customer location
- the escalation record is written **straight to Supabase** from `src/services/escalationStore.js`,
  not pushed over HTTP to `clara-lead-agent-server`. There is no ingest endpoint and no shared
  secret by design — see `docs/session.md` (2026-08-27, item 1). It also builds its own
  service-role client rather than using `config/database.js`, which prefers the anon key that
  RLS denies
- the Apps Script is **not** part of the escalation-record change. Four `callN - dialling`
  lines were added and then reverted once it was clear Retell already supplies `contact_name`
  — item 3 in that same entry

## Running things

Install with `npm ci --registry=https://registry.npmjs.org`. A plain `npm install` fails
`E401`: the global `~/.npmrc` points npm at an AWS CodeArtifact registry whose token is
dead. Every dependency is public and the lockfile already resolves to npmjs.

- `npm run build:syntax` — parses every file under `src/`.
- `npm run build:smoke` — boots the server. Passes.
- `npm test` — the suite in `tests/`, `node --test`, no network. Apps Script tests skip
  automatically when the gitignored `google-sheet/code.gs` is absent. Apps Script functions are
  evaluated in a `vm` with `SpreadsheetApp`, `UrlFetchApp`, `PropertiesService`,
  `LockService` and `Utilities` stubbed (`tests/harness.js`); Node modules are loaded with
  their dependencies swapped by `loadWithMocks`.
- `npm run test:all` — build then tests.

## Secrets

The repository is **public**. Live credentials currently sit in plaintext in `google-sheet/code.gs`
and the Retell configs — gitignored, so not in history, but real and unrotated. Never move those
files into tracked paths, and never paste a credential value into a tracked file, a commit message,
or a PR description.
