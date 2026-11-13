# Background discovery of supported ATS boards

This worker visits public web pages, follows links across websites, and saves
destinations recognized by the Dashboard's existing ATS board parsers. It can
discover an employer through a directory, follow the employer's careers link,
and find that employer's supported ATS board. It does not extract jobs from
custom employer pages, run JavaScript, render browser pages, invoke an AI model,
or query Common Crawl. It follows HTML links and known ATS URLs embedded in
scripts and widgets, plus the bounded Sequoia public company directory described
below; sitemap traversal is outside this version.

A [database-free local probe](evidence/ats-web-discovery-pilot-2026-10-20.json)
recognized Linear's Ashby board from its employer careers page within a six-request
pass. A separate 48-request directory exploration reached employer websites but
had not found a supported board when its budget ended. These checks establish
transport, traversal, and recognition; incremental coverage and useful job yield
still need measurement against the production inventory. Neither probe published
discoveries or ran on M70.

## What gets saved and collected

The crawler keeps a dedicated SQLite database containing its URL queue, visit
and retry state, per-site request windows, robots rules, and board discoveries.
Each board retains its exact provider identity, the discovered URL, its original
source page, and first/last encounter dates. URL fragments and advertising
tracking parameters are removed; identity-bearing query parameters and path case
are retained. Employer identity is not inferred from a directory listing.

Without `--publish`, it never opens the Dashboard database. The output represents
discovery candidates, not validated boards, imported jobs, or additional coverage
beyond the existing production inventory.

With `--publish`, a separate batch of at most three candidates per pass is handed
to the existing mechanisms:

- Existing boards, including parked boards and permanently retired boards, are
  recognized without changing their schedules, status, or retry state.
- Providers governed by first-collection admission enter its waiting inventory
  using an insert that skips existing candidates. Existing evidence, holds, and
  validation dates are preserved. That admission worker owns feed validation.
- Other API providers use the existing board validator before registration.
  Browser providers enter the established weekly first-crawl path. No browser
  is launched by discovery.
- Temporary validation or database errors remain in the crawler's retry queue.
  A terminal validation failure retains its evidence as rejected and creates no
  schedulable board.

The handoff batch has its own limit because the existing provider validators
make their own requests. Its requests are **not** included in the crawler's
60-request/32-MiB pass budget. Handoff never starts job collection directly,
changes collection concurrency, updates jobs/scores, or changes Common Crawl
receipts, cursors, or source selection.

## Starting a bounded local experiment

Run with the repository's Node 24 runtime:

```bash
node --max-old-space-size=256 --import tsx scripts/crawl_ats_boards.ts \
  --seeds-file docs/examples/ats-web-discovery-seeds.txt \
  --max-requests 20 --max-seconds 120
```

The sample starting pages include an association membership directory and two
employer careers pages. They are transport/discovery examples, not a curated
list of employers or a claim that their boards are absent from production.
Use `--seed https://example.org/members` for additional starting pages. Reuse
the same `--state` path to resume. Its default is
`data/runtime/ats-web-discovery/state.sqlite`, outside the tracked release.

Inspect saved counts without networking or opening the Dashboard database:

```bash
node --import tsx scripts/crawl_ats_boards.ts --status
```

To validate and hand off discoveries in an environment configured for the
Dashboard database:

```bash
node scripts/with-env.mjs node --max-old-space-size=256 --import tsx \
  scripts/crawl_ats_boards.ts --publish
```

That command also resumes a bounded crawl pass. `--publish-limit` controls its
separate handoff batch and accepts 1-20 candidates. Runtime files belong on a
local filesystem supporting SQLite locking, not a network filesystem. Keep
the database and any `-wal`/`-shm` companions together during recovery. Only one
worker can own a state file; an interrupted worker's lease expires after two
minutes. A successful page and its outgoing discoveries commit together, so a
failed transaction cannot acknowledge a page while losing the discoveries.

## Startup and VC portfolio discovery

The `startup-vc` source pack adds public starting pages for
[a16z](https://jobs.a16z.com/jobs),
[Sequoia](https://jobs.sequoiacap.com/companies),
[Index Ventures](https://www.indexventures.com/companies/),
[Y Combinator](https://www.ycombinator.com/jobs), and
[Wellfound](https://wellfound.com/jobs). These directories supply employer and
ATS destinations. Their copied job listings do not become Dashboard jobs, and
the directories are not registered as ATS providers.

```bash
node --import tsx scripts/crawl_ats_boards.ts --source-pack startup-vc \
  --state /tmp/startup-vc-discovery.sqlite --max-requests 20 --max-seconds 120
```

Company profiles receive preference over individual directory job pages. YC
and Wellfound job links also expose a company profile route, allowing discovery
to reach the employer without entering their application account flows.
Wellfound's public company metadata supplies its employer website when that
website is absent from ordinary HTML links. All destinations still pass the
existing URL safety, robots, depth, deduplication and request-budget controls.
No page JavaScript executes, and missing metadata does not imply an empty or
closed employer board.

Sequoia's company page loads its directory through a public JSON search endpoint.
Discovery obtains an anonymous session from the public company page, then reads
21 companies per request and follows the endpoint's opaque continuation cursor.
Only the companies' published website URLs are used; provider labels, company
names and domains never substitute for a verified ATS URL. Session cookies and
CSRF tokens remain in memory for a single crawl pass and are sent only to that
exact Sequoia endpoint. Bootstrap and API requests use the normal safe transport,
robots checks, pacing, host allowance, byte budget and resource guards. No login
or browser is needed. Malformed JSON, incomplete responses and expired sessions
remain retryable, rather than becoming empty or closed boards.

Each continuation is saved as an ordinary frontier URL at the same link depth as
its preceding directory page. Employer websites use the next link depth. This
allows the complete directory to resume across bounded passes without exhausting
the default five-link distance just by paging through companies.

[Public HTML checks on November 13, 2026](evidence/ats-startup-vc-discovery-2026-11-13.json)
established these access paths. A database-free, depth-zero live pass visited all
seven starting pages in 12 requests and retained 12 ATS board candidates. This
measures starting-page discovery only, not complete directory coverage.

| Directory | Observed discovery path and limit |
| --- | --- |
| a16z | Job-list HTML contains direct supported ATS application links; company profiles expose employer websites and careers links. |
| YC | Job-list HTML links to company/job pages; company profiles expose employer websites. |
| Wellfound | Public job links lead to company profiles; public company JSON exposes the employer website. |
| Index | Public company directory links to profiles, which expose employer websites. Its JavaScript job-search catalogue is not collected. |
| Sequoia | Public company-directory API traversed all 10 pages across two bounded passes; the source reported 209 companies. A separate crawl from its published Sierra website found two supported Ashby board identities on Sierra's careers page. |

The [completed integration audit](ATS_STARTUP_VC_DISCOVERY_AUDIT_2026-11-13.md)
records live pagination/resume evidence and the final validation results. The
directory is a source of employer routes; the reported company total and ATS
candidates are not counts of newly admitted production boards.

The M70 service includes the source pack alongside its existing operator seed
file. The existing activation markers and stopped-timer behavior still apply;
adding the pack does not activate a disabled worker. A release deployment is
required to update an already-running M70 worker. Existing saved frontier work,
board retirement/holds, job states and scores are preserved. Discoveries are
candidates until the ordinary validation/admission handoff accepts them; counts
are not claims of new employers or suitable jobs beyond production inventory.

## Default work limits

| Limit | Behavior |
| --- | --- |
| One request in flight | No discovery concurrency with itself |
| 1 second globally, 5 seconds per site | Intervals persist across passes and restarts |
| 20 requests per origin per 24 hours | Includes robots and redirect requests; excess work waits |
| 60 requests / 5 minutes per crawl pass | Progress stays saved when a budget is reached |
| 2 MiB per page; 512 KiB per robots response | Wire and decoded body sizes are bounded |
| 32 MiB per crawl pass | Failed transfers conservatively consume their full allowance |
| 500,000 queued/retry URLs; at most 500 links selected per page | Limits pending exploration; completed history does not consume queue slots; omitted links at queue capacity are counted |
| Five links from a starting page | Additional depth requires changing `--max-depth` |
| Seven days between successful page visits | Failed pages retain independent retry times |
| 512 MiB SQLite main-file ceiling | Further writes fail without acknowledging unsaved page results |

Queue capacity counts never-visited pages and pending retries, including future
retry holds. A successful page visit frees its queue slot before its outgoing
links are admitted, in the same transaction. Visited pages, robots-blocked pages,
and ignored pages remain saved separately from that capacity calculation. Their
existing revisit dates, robots rules, per-host holds and deduplication identities
remain authoritative; no saved URL or board is deleted to make room. A due
revisit can run directly from retained history. If it fails, its retry remains
saved even when that temporarily takes pending work above the admission limit;
newly encountered links may be omitted and counted until completed work frees
capacity. Omitted links are not a second saved queue; later revisits may find
them again.

`--status` reports pending URLs, retained history, the default queue limit and
available queue slots separately. A crawl pass reports its configured limit.
`--max-urls` overrides pending capacity without changing request, CPU, memory,
depth or disk limits. The 512 MiB main-file ceiling still bounds retained
history; queue turnover does not imply unlimited storage or automatic pruning.
Opening older state initializes only the derived pending counter and its
transactional maintenance. Existing URL, host, board, retry and metric records
are preserved. Read-only status can inspect older state without upgrading it.

Careers and directory links receive priority. Every fifth successfully fetched
HTML page gives preference to sites with fewer recent requests, allowing the
crawler to explore beyond familiar employers. Assets, social sites, common
account/action URLs, and links marked `nofollow` are skipped. Known ATS
destinations are recorded without fetching their catalogues.

The worker reads and caches robots rules, honors allow/disallow and crawl-delay,
and checks a page redirect's destination rules before fetching that page. Robots
redirects are followed for up to five hops. Unavailable robots due to network or
server errors defer work; 401/403 deny crawling, while 404/410 permit it. HTTP 429
and server failures back off, retaining Retry-After holds. The transport validates
and pins public IP addresses, including redirect destinations, and rejects local
or private targets. Discovery uses explicit manual redirects so a redirected
request cannot bypass these crawl rules and request accounting.

On Linux, a pass pauses when the one-minute load exceeds 85% of the host's logical
CPU count or available memory drops below 1 GiB. System load is compared with the
host CPU count because it covers the whole host, while the service's CPU quota
limits only the crawler. The CLI requires 1 GiB of free disk
space before starting. These are admission checks, not a measured performance
guarantee; systemd enforces the CPU and memory limits below. A bounded pilot still
needs to establish useful new boards per page/request and collection yield.

## M70 installation and activation boundary

The repository supplies an opt-in service and timer. They are **not enabled by
deploying a release**. Activation requires the existing production gate, a
separate `/etc/career-dashboard/web-discovery-enabled` marker, and an operator
seed file at `/etc/career-dashboard/web-discovery-seeds.txt`.

The service uses 50% of one logical CPU at most, a 256-MiB Node heap, a 512-MiB
cgroup memory limit, and the lowest ordinary process/I/O priority. Its timer
resumes bounded passes 15 seconds after the previous pass, with up to five
seconds of jitter and one-second scheduling accuracy. State
lives beneath the existing persistent Dashboard runtime directory rather than
inside a release checkout. Seed selection and activation are deliberate release
operations; this feature does not change an operator's existing on/off choices.

Release activation stops discovery before swapping code, and resumes its timer
only if it was previously active. Rollback removes the units when the old
release lacks them. Automatic maintenance records and stops both timer and
service before draining work, then restores previously active units after
health checks. A stopped discovery timer remains stopped.

## Yielding to Dashboard visitors

On M70, the web service passively records the duration of actual job-list and
job-search requests in `data/runtime/dashboard-responsiveness.json`. It saves
only process/timing information, without job data or request parameters. Atomic
file writes run asynchronously; user responses never await telemetry storage.
There are no synthetic requests or additional database queries for this guard.

Discovery checks that file at most once a second while running. It pauses if a
request has been active for 1.5 seconds, or if a completed request took at least
1.5 seconds or returned a server error. Slow/failed responses retain a one-minute
recovery window. CPU/memory pauses and Dashboard-pressure pauses also retain a
one-minute backoff in crawler state, across worker restarts. The faster timer
cannot bypass that hold, and candidate handoff is skipped during it.

Missing, malformed, or dead-process telemetry pauses discovery until the web
service establishes a valid sample. Web startup initializes healthy idle telemetry
without waiting for a visitor, including after unattended reboots. A healthy idle sample remains valid
while its web process is alive, so an unused Dashboard needs no polling. The
guard is enabled only when `DASHBOARD_RESPONSIVENESS_FILE` is configured; local
database-free experiments do not require a running Dashboard.

The guard observes server response preparation, not browser rendering or network
delivery. It checks between crawler operations rather than cancelling a request
already in flight. It limits interference; it is not a guarantee of unchanged
latency under every workload. Crawl request/byte/host limits, saved URLs, board
identities, retry holds, and score authority are unchanged.

The current M70 operator resource overrides allow one CPU core at most and use
Linux idle CPU scheduling, with the existing 512-MiB memory limit. Those host
settings live outside release checkouts and survive application deployment.
