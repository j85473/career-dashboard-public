# ATS posting isolation and provider collection recovery

Cornerstone's exact-posting parser raised ordinary errors for missing structured
data, conflicting route/title identity and missing employer evidence. The detail
consumer counted those errors against the shared provider circuit. One bad
posting could therefore stop unrelated employers, leaving thousands of details
waiting behind repeated two-hour cooldowns.

The parser boundary now classifies these as posting response failures. They stay
pending for their existing posting retry, without recording a provider failure.
Body-read and transport failures remain outside that boundary and retain shared
protection. Exact posting HTTP 403, 404 and 410 are posting availability failures.
Employer identity and complete evidence are still required before publication.

Capacity-mode validation now gives the provider with the oldest last validation
turn the next eligible candidate; providers never attempted go first. Within a
provider, the oldest due candidate still goes first. Pilot selection, retry dates,
review holds, retirements, capacity limits and the leased single validator remain
authoritative. No existing candidate, score, board or saved crawl is reset.

HGV's Symphony catalogue had two independently verified variations: a record
whose employer field is null and a record whose public URL points to HGV's own
Oracle requisition. HGV's public configuration and exact API responses confirm
the reviewed organization, numeric organization ID, portal and detail route.
The missing employer is supplied only for that reviewed HGV organization/portal;
conflicting employer names still fail. The Oracle variant must match the exact
reviewed host, career site and requisition. It uses HGV's public Symphony detail
route with the published Symphony ID, while retaining the source URL. The route
was verified live to serve that exact posting. No arbitrary upstream domain is
accepted, and existing Symphony posting IDs remain unchanged.

## Validation

- Full source reads on November 11: HGV 59 pages / 1,172 distinct postings;
  Victoria's Secret 67 pages / 1,335 distinct postings. Both completed without
  identity or pagination failures after the correction. These are publisher
  listings, not suitable-job or imported-card counts.
- Regression cases repeat invalid Cornerstone evidence and unavailable postings,
  then successfully enrich a different employer using the same simulated
  circuits. A failed response body still records a transport failure.
- Symphony tests retain exact organization, portal, employer, domain, requisition
  and posting checks, including hostile and conflicting upstream addresses.
- The actual provider-selection SQL ran in a dedicated disposable PostgreSQL
  database, proving provider rotation, oldest-within-provider order and
  preservation of future retries, size review and retired candidates.
- Node 24; production build used an intentionally unusable database connection.
- Final unit suite: 3,167 passed, 10 skipped, zero failed. TypeScript, ESLint on
  changed TypeScript files and whitespace validation also passed.

## Operational recovery scope

After activating the correction, release only Cornerstone's detail circuit whose
last failure is the verified posting-evidence error. Bring forward only unclaimed,
still-pending retries explicitly deferred by that false provider circuit, on
active boards without operator holds. Posting-local failures retain normal
retries, and genuine provider/network failures retain circuit protection.
Normal admission then starts the waiting providers under existing limits.

This release is based on the running production commit. The separate local
embedded-Ashby change is outside this release.
