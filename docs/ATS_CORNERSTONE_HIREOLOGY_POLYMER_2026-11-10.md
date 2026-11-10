# Cornerstone, Hireology and Polymer collection

These adapters connect pasted URLs, Common Crawl, web discovery, first-collection
admission, acquisition, full descriptions, stable posting identities and normal
job intake. The original seven-provider discovery audit retains its exact URL
patterns, historical receipts and saved direct-file scans.

Cornerstone retains the tenant host, career-site number and explicit language.
Its public anonymous configuration binds the token to that tenant and career
site and supplies the regional API. Search traverses twenty-record pages. A
public exact requisition verifies the employer through the publisher's structured
job data before a populated catalogue can proceed. Tenant slugs never supply
employer names. Hireology likewise reads anonymous career-page configuration,
verifies hosted aliases, traverses twenty-record pages and preserves the employer
published for each posting. Anonymous tokens remain in process memory and
request headers; they are omitted from saved listings, metadata and receipts.

Polymer uses its documented unauthenticated jobs API. Its complete-feed read
follows the provider's page numbers without assuming a page size, rejects
repeated IDs and changing totals, and is bounded to 100 pages and five MiB of
continuation data. Empty catalogues require explicit zero-count metadata.
Exact JSON job detail supplies descriptions after the normal early title gate.
Published remote residency restrictions, city and overlap requirements remain
part of the location evidence. A false country-residency requirement is rendered
as worldwide remote eligibility; a required country list stays restricted.

New first collections use the existing policy, capacity, size-review and
reservation checks. The additive migration replaces the two admission guard
functions to include these three providers. It does not update existing boards,
jobs, scores, batches or operator policy. Expired public tokens are refreshed on
the next request. Repeated Cornerstone/Hireology pages cannot advance the saved
listing cursor. Current jobs retain their existing identities and scores.

## Live verification

Read-only whole-board checks on November 10 completed:

| Provider | Employer | Listings | Listing pages |
| --- | --- | ---: | ---: |
| Cornerstone | Interfor, career site 7 | 45 | 3 |
| Cornerstone | World Bank Group, career site 1 | 60 | 3 |
| Hireology | Beach Chevrolet | 4 | 1 |
| Hireology | Capital Ford Raleigh | 13 | 1 |
| Polymer | Aboard | 3 | 1 |
| Polymer | Select | 9 | 1 |

The verifier checked distinct posting IDs and obtained a full sample description
for every board. These are publisher listings, not additional suitable jobs or
imported cards. The [sanitized receipt](audit-evidence/ats-expanded-public-2026-11-10.json)
contains counts and sample metadata without anonymous tokens or source bodies.

## Activation

After a guarded release and migration, catalogue the six verified launch boards
before handing off archived discovery inventory:

```sh
node --import tsx scripts/seed_public_ats_boards.ts --platform=cornerstone --platform=hireology --platform=polymer --apply
node --import tsx scripts/catalogue_expanded_ats_backlog.ts
node --import tsx scripts/catalogue_expanded_ats_backlog.ts --apply
```

The handoff only changes discovery inventory and creates missing first-collection
candidates. Existing validation attempts, holds, due dates, completed work and
retired board identities survive. Archived addresses without a canonical board
identity remain separately held. Homerun, Softgarden, d.vinci and Flatchr remain
discovery-only. Their candidates do not become schedulable boards.

The normal first-collection timer validates and admits candidates as capacity
allows; this release does not raise its limits or release oversized boards.
The standalone adapter verifier makes no production writes. The PostgreSQL
integration check requires a disposable database with the enforced test prefix.
