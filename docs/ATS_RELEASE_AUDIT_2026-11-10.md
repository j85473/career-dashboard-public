# November 10 ATS release audit

Reviewed all eight November 10 commits on `main`, from the reviewed oversized
collection release through the Homerun/Softgarden/d.vinci/Flatchr integration.
At audit start, remote `main` and M70 both pointed to
`5261dac547469bbe6767723b91d60e79fd82edc0`; the successful activation was
[workflow 42882086857](https://github.com/j85473/career-dashboard/actions/runs/42882086857).
No additional November 10 commits existed outside that remote history. Cancelled
intermediate workflows did not leave their commits absent from the final release.
The original local checkout's older, uncommitted edits were preserved separately.

## Corrections

- Cornerstone sampled one exact posting's employer and copied it to every job,
  then cached that employer for later pages. The listing now leaves employer
  identity unresolved. After title triage, each retained posting verifies its own
  requisition, board, title and published employer through the paced detail lane.
  Unverifiable details remain pending for retry. No existing cards or scores are
  rewritten or invalidated by this release.
- The nightly backup failed immediately if crawl disposal owned their shared
  storage lock. M70's logs showed this failure on November 8–10, with its latest
  paired nightly recovery point completed November 7. Backup now waits up to five
  minutes for the same exclusive lock, retains its retry behavior if still busy,
  and rechecks the maintenance hold after obtaining ownership. Existing recovery
  points and retention rules are unchanged. November 10 deployment database
  archives also existed; they are distinct from the failed nightly paired backup.
- Provider documentation now reflects that all seven adapters are connected,
  while retaining validation and controlled first-collection admission.

## Validation before release

- Node 24.19.0; full suite: 3,150 passed, 10 skipped, zero failed.
- Production Next.js build passed using an unusable database address.
- Real temporary PostgreSQL tests passed the admission triggers for all seven
  providers, concurrent single-slot reviewed admission, raw-writer refusal,
  retry/persistence holds, operator controls, and preservation of an existing
  scored interviewing job. Production was not used for these writes.
- Live read-only verification completed 14 boards across all seven providers,
  with distinct posting IDs, complete pagination and a full sample description.
  The [receipt](audit-evidence/ats-audit-live-2026-11-10.json) contains normalized
  counts and sample metadata only. These listings are not counts of suitable jobs.
- New regression cases exercise two employers on the same Cornerstone board,
  stale sampled configuration, wrong posting details, title triage, and actual
  exclusive backup-lock contention and timeout.

## Production observations and limits

At approximately 14:15 America/Chicago, Cornerstone, Hireology and Polymer had
observed 7,873, 1,333 and 12 postings respectively. Their batch processing error
counts were zero. Two Cornerstone boards retained listing schema errors for retry;
this does not establish that every discovered board works.

Homerun, Softgarden, d.vinci and Flatchr were present in discovery inventory but
had not yet reached validation. The existing controller selects oldest candidates
first; older November 10 candidates preceded their 13:28 registration. Live reader
verification proves their source contracts, not completed production collection.
The audit does not change admission order, release size-review holds, reset
unfinished work, or claim exhaustive provider coverage.
