# Capacity-controlled intake for the four-provider discovery backlog

Joseph authorized continuing the Homerun, Softgarden, d.vinci and Flatchr
discovered-board backlog after their initial launch collections completed.
The live starting inventory had 7,113 unattempted candidates: 1,904 Homerun,
3,835 Softgarden, 428 d.vinci and 946 Flatchr. These are discovery candidates,
not validated employers or suitable jobs.

The ordinary 32-board first-collection allowance remained occupied by older
retry work. The existing reviewed serial queue now supports explicit enrollment
of these four providers. Enrollment is a separate operator action; deploying the
code does not enable it automatically. It appends the four provider scopes to
the existing reviewed policy and retains every previously reviewed identity.

The existing first-collection timer refills this queue without a separate worker:

1. Respect ordinary and reviewed operator modes and the shared validator lease.
2. Require a free reviewed slot, including absence of ready, retrying or
   incompletely persisted reviewed work.
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
the 250-posting maximum even though the same reviewed queue also contains older,
explicitly authorized oversized boards. Discovery candidates still require
normal feed validation; enrollment does not create schedulable boards in bulk,
resurrect retired identities, change retry dates or clear operator holds.
Existing jobs, scores, attachments and lifecycle state are not rewritten.

## Activation and status

Run on the active M70 release with the service environment:

```sh
node scripts/with-env.mjs node --import tsx scripts/control_ats_provider_backlog.ts
node scripts/with-env.mjs node --import tsx scripts/control_ats_provider_backlog.ts --apply
```

The first command previews status and the four proposed enrollments. Apply
requires both existing policies to remain in capacity mode, the valid single-slot
reviewed policy and matching response limits. It changes only its explicit
enrollment entries. The existing first-collection timer then owns progression.

## Verification

The disposable PostgreSQL integration check fills the ordinary queue, rotates
through all four enrolled providers with concurrent validators, proves one ready
and one reserved reviewed board at a time, and refills after completed
persistence. It preserves a scored interviewing job and an existing future retry.
Further cases enforce unavailable-feed retries, the 250-posting size review,
persistence backpressure, runtime admission gates, operator holds and a policy
change during validation. No test writes target the production database.

The release suite passed 3,170 tests with 10 skipped and zero failures.
TypeScript, ESLint on changed TypeScript files, whitespace checks and the
production build passed. Builds used an intentionally unusable database URL.
