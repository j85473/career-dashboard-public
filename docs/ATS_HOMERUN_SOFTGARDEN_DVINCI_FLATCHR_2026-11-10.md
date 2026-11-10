# Homerun, Softgarden, d.vinci and Flatchr collection

All four providers join the direct HTTP acquisition lane, public URL identification,
Common Crawl and web discovery, exact pasted-posting reads, normal first-collection
validation/admission, enrichment, persistence and existing four-day workload assignment.
They do not require employer API credentials or browser collection.

Homerun reads the public Atom feed, validates well-formed complete XML and its
employer namespace, retains the full description, and reads exact public posting
structured data after title triage to recover geographic and remote restrictions.

Softgarden supports both the modern, count-verified `jobs.feed.json` data feed
and classic career pages. Classic pages declare their complete posting-ID list;
every declared posting must appear in the downloaded HTML. Exact posting details
supply the employer, complete description and geographic restrictions after title
triage through the existing provider pacing and enrichment boundary.

d.vinci reads the public `jobPublication/list.json` catalogue. Each posting's
published employer, full rendered content, application/public URL identity and
locations remain bound to its tenant. Explicit portal identities stay distinct.

Flatchr reads only the public company site's structured server-rendered job data.
Company IDs and slugs must agree; intranet sites and closed/unpublished diffusion
records are refused. A separately published spontaneous-application record is
included when present, without duplicating its ordinary listing. Only normalized
job fields persist; site configuration, contact records and application controls
are not stored in acquisition payloads. Exact vacancy pages can supply their
owning company without inventing an employer from the vacancy slug.

All feeds reject missing/contradictory identities, repeated posting IDs, malformed
or incomplete catalogues, and unsupported continuation envelopes. Downloads retain
the existing response-size limits and provider pacing. Requests stay in verified
public vendor namespaces. Remote evidence retains any published country limit;
remote status alone never becomes worldwide eligibility.

## Admission and preservation

The additive migration extends the existing database insert/reservation guards to
these four providers. It does not rewrite any existing board, job, score, lifecycle,
operator hold, policy, schedule, acquisition batch or Common Crawl receipt. Existing
capacity and initial catalogue-size limits remain authoritative.

The saved-address handoff creates only missing first-collection candidates, checks
permanent board retirements and leaves existing validation attempts/holds untouched.
Addresses without a supported canonical board identity remain held separately;
they are not counted as validated boards. Discovery patterns and exact historical
coverage receipts remain unchanged, and the running Common Crawl scan resumes.

After deployment, seed the eight verified launch boards and hand off saved addresses:

```sh
node --import tsx scripts/seed_public_ats_boards.ts --platform=homerun --platform=softgarden --platform=dvinci --platform=flatchr --apply
node --import tsx scripts/catalogue_expanded_ats_backlog.ts --apply
```

## Live read-only verification

| Provider | Employer / board | Listings |
| --- | --- | ---: |
| Homerun | 013 Poppodium | 1 |
| Homerun | Homerun | 5 |
| Softgarden, classic | softgarden e-recruiting GmbH | 5 |
| Softgarden, modern | ABEKING & RASMUSSEN | 38 |
| d.vinci | ads-tec | 19 |
| d.vinci | ADA Cosmetics | 10 |
| Flatchr | Flatchr | 7 |
| Flatchr | ABE | 4 |

Every board returned distinct posting IDs and a full sample description. These
counts are publisher listings, not suitable jobs or imported Dashboard cards.
The [sanitized verification receipt](audit-evidence/ats-additional-public-2026-11-10.json)
contains no raw source bodies, tokens or candidate data.

The disposable PostgreSQL integration check applies the real additive migration,
rejects unreserved and wrong-ID batches for all seven newly added providers,
accepts exact durable reservations, and proves preservation of a pre-existing
board and job with scores and interview lifecycle. It never targets `career_db`.

Source contracts were checked against public live career sites and the vendor
references: [Homerun XML feeds](https://help.homerun.co/en/articles/5013627-how-to-generate-an-xml-feed),
[Softgarden career API](https://dev.softgarden.de/career-websites-api/jobs-api/jobboard-api/executing-a-job-search/),
[d.vinci publishing interfaces](https://www.dvinci.de/en/standard-schnittstelle/), and
[Flatchr listings documentation](https://developers.flatchr.io/en/docs/QuickStart/Annonces/Recuperer_l_ensemble_de_vos_annonces/).
The authenticated vendor APIs are distinct from the credential-free career-site
feeds/pages used here.
