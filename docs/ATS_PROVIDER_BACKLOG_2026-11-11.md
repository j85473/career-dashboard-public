# Capacity-controlled intake for the four-provider discovery backlog

Joseph authorized continuing the Homerun, Softgarden, d.vinci and Flatchr
discovered-board backlog after their initial launch collections completed.
The live starting inventory had 7,113 unattempted candidates: 1,904 Homerun,
3,835 Softgarden, 428 d.vinci and 946 Flatchr. These are discovery candidates,
not validated employers or suitable jobs.

The ordinary 32-board first-collection allowance remained occupied by older
retry work. An independent one-board serial allowance now supports explicit
enrollment of these four providers. It uses the existing reservation and collection
machinery, shared worker pool and volume gates. Enrollment is a separate operator
action; deploying the code does not enable it automatically. It creates the
backlog's own policy and leaves the older oversized queue unchanged. A failing
large board in that older queue cannot hold up all four providers.

The existing first-collection timer refills this queue without a separate worker:

1. Respect ordinary and reviewed operator modes and the shared validator lease.
2. Require a free provider-backlog slot, including absence of ready, retrying or
   incompletely persisted work in that backlog.
3. Verify staging, response-size and persistence headroom using the existing
   reviewed publication window and hard ceilings.
4. Select a due discovered candidate from an eligible enrolled provider, rotating
   by provider validation turn and preserving candidate order within providers.
5. Validate its normal canonical feed. Unavailable boards retain normal retry
   dates; catalogues above 250 postings enter size review.
6. Recheck operator enrollment after the network read, then let the existing
   exact-batch reservation and collector perform collection and persistence.
7. Refill after successful persistence releases the serial slot.

The ordinary 32-board allowance, shared worker pool, request pacing and volume
ceilings are unchanged. Ordinary providers can still use their own available
capacity. A full reviewed slot prevents further enrolled-provider validations,
while ordinary work may proceed independently when eligible.

Only these four provider scopes can be enrolled. Their first catalogues retain
the 250-posting maximum. The older oversized queue retains its own reviewed
allowance. Discovery candidates still require
normal feed validation; enrollment does not create schedulable boards in bulk,
resurrect retired identities, change retry dates or clear operator holds.
Existing jobs, scores, attachments and lifecycle state are not rewritten. The
new allowance permits one additional first-collection board alongside older
oversized work; it adds no physical worker and raises no volume limit.

## Activation and status

Run on the active M70 release with the service environment:

```sh
node scripts/with-env.mjs node --import tsx scripts/control_ats_provider_backlog.ts
node scripts/with-env.mjs node --import tsx scripts/control_ats_provider_backlog.ts --apply
```

The first command previews status and the four proposed enrollments. Apply
requires the ordinary policy to remain in capacity mode and preserves any saved
backlog hold. The new backlog policy has exactly one slot and a 250-posting first
feed limit. Later enrollment checks its existing shape and matching response
limits. The existing first-collection timer then owns progression.

## Verification

The disposable PostgreSQL integration check fills the ordinary queue, rotates
through all four enrolled providers with concurrent validators, proves one ready
and one reserved reviewed board at a time, and refills after completed
persistence. It preserves a scored interviewing job and an existing future retry.
An older oversized board also retains its actual reserved retry while all four
backlog providers advance through their independent allowance.
Further cases enforce unavailable-feed retries, the 250-posting size review,
persistence backpressure, runtime admission gates, operator holds and a policy
change during validation. No test writes target the production database.

The release suite passed 3,170 tests with 10 skipped and zero failures.
TypeScript, ESLint on changed TypeScript files, whitespace checks and the
production build passed. Builds used an intentionally unusable database URL.
