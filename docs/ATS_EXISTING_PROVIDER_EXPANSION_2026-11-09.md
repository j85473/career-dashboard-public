# Existing ATS expansion and recovery

ClearCompany discovery now resolves hosted career pages and embedded widgets to
their published site UUID. Symphony Talent supports two additional verified
employers. Public-board recovery recognizes a verified Avature domain migration,
localized BrassRing search, genuinely empty Taleo sections, unavailable Jobvite
tenants and Talemetry security challenges.

These are prospective collector changes. They require no database migration and
do not rewrite jobs, remove scores, reset crawl cursors, revive retired boards or
change first-collection allowances. Verification made no production writes.

## ClearCompany

The prior collector discovered only URLs already containing a site UUID. Hosted
pages on `apply.clearcompany.com`, older HRMDirect career pages and employer
application subdomains could not supply a collectable board identity. The feed
parser also rejected the employer subdomains returned by current public feeds.

Discovery now accepts those career-page formats and recognizes the provider's
career-site script, including its `data-site-id` attribute. Hosted/HRMDirect
aliases remain candidates until validation binds them to one published UUID.
Admission checks the canonical UUID for existing or retired boards, then records
the result against the original discovery candidate. Alias URLs cannot create a
second schedulable identity for the same site or bypass its retirement.

Unrelated scripts, conflicting widget IDs and redirects to another employer do
not establish identity. Existing UUID boards continue directly to their feeds;
they do not acquire an extra page request. Current employer application URLs
must preserve the feed's exact posting ID. Published remote locations remain
intact when structured office fields contain only a country.

The explicitly requested historical HRMDirect backfill uses the narrower
`*.hrmdirect.com/employment/*` pattern. That distinct path scope earns its own
per-index completion receipts with the expanded parser. The original
`*.hrmdirect.com/*` receipts remain valid and are neither removed nor reset.
Local discovery inherits completed coverage for the existing patterns and reads
the selected index sections for missing coverage, beginning with recent crawls.

Two new seed candidates passed complete live reads:

| Employer | Listing records | Verification |
| --- | ---: | --- |
| FranklinCovey | 17 | Hosted-page configuration, canonical UUID, all listing records and full descriptions |
| Lonestar Forklift | 11 | Hosted-page configuration, canonical UUID, all listing records and full descriptions |

## Symphony Talent

The verified employer registry now includes Hilton Grand Vacations and Victoria's
Secret alongside Deltek. Each entry binds its employer host, public API
organization, source company name, numeric organization ID, published portal
filters and posting URL format. Discovery uses all three verified hosts.

The newer career-site configuration is read as literal JSON without executing
page scripts. Listing and exact-detail validation retain the employer and
posting checks. Deltek still requires its duties and qualifications sections;
the other verified employers publish their full description in a different
format. Their `level` field is a category or employment type, so location comes
from their published location fields rather than that category.

Live checks read two distinct 20-record pages and verified an exact full detail
for each new employer. The selected public portals reported 1,182 and 1,369
listings respectively. These are source totals, not new suitable jobs or imported
cards, and the checks did not traverse either entire catalogue.

## Recovery outcomes

| Provider | Verified cause and resulting behavior |
| --- | --- |
| Avature | The Advocate Health career section redirects to an employer domain. That exact reviewed host maps back to its original Avature board, preserving board and requisition identity. Two pages returned six distinct jobs each, and an exact detail verified its employer and full description. Arbitrary custom domains remain unsupported. |
| BrassRing | A Swedish search button was missed by the English-label lookup. The reader now recognizes the publisher's search control independently of its translated label. An empty result requires an active unfiltered search, the embedded public zero count and its rendered empty message. The live affected board completed as genuinely empty. |
| Taleo | A zero-result section was rejected because public response evidence required at least one requisition. A zero result now requires a first-page unfiltered response, zero total, no requisitions, matching portal and a rendered empty state. The live affected section completed as genuinely empty. |
| Jobvite | Removed tenants redirected to the vendor's explicit invalid-tenant support page. They now defer immediately with the existing unavailable-board retry policy. They do not become successful empty catalogues or permanently retired boards. |
| Talemetry | Sampled public sites and exact details presented security challenges. Recognized challenge pages now defer as access failures, including challenge pages returned with HTTP 200. HTTP 403 already uses the access retry policy. Saved work remains available for the next permitted attempt; this does not resolve the external access restriction or claim that every outstanding detail is recovered. |

## Activation and validation

After deploying this commit, the existing seed command can catalogue the four
new candidates through normal admission:

```sh
node --import tsx scripts/seed_public_ats_boards.ts --apply
```

That command preserves existing boards and retired identities. New ClearCompany
candidates must validate and pass the usual capacity checks. The new Symphony
boards exceed the current 250-job first-collection allowance and will require
size review; this change does not release oversized catalogues. Existing parked
boards retain their retry dates and saved work until their normal next attempt.

The database-free endpoint checks and browser outcomes are recorded in the
[sanitized live verification receipt](audit-evidence/ats-existing-provider-expansion-2026-11-09.json).
Regression coverage includes canonical retirement protection, conflicting widget
configuration, exact employer/posting validation, location preservation,
localized search and filtered/hidden/unsupported empty-state rejection.

The release unit suite passed 3,121 tests, with 10 skipped and no failures.
TypeScript checking (`npx tsc --noEmit --incremental false`), ESLint on every
changed TypeScript file and whitespace validation also passed.
The production build passed with a deliberately unusable database connection.
