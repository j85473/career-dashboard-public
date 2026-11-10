# Discovery before collector activation

Common Crawl discovery now includes Cornerstone, Hireology, Polymer, Homerun,
Softgarden, d.vinci and Flatchr. Thirteen hosted-domain patterns cover their
known vendor-hosted boards, public feeds and career-page aliases. Employer-owned
custom domains still require separate discovery; Common Crawl coverage proves
exhaustion of its published archives for these exact patterns, not a census of
every employer on the internet.

The exhaustive audit uses a discovery registry separate from the schedulable
collector registry. Both direct-file and CDX/Athena paths save these candidates
as `awaiting_adapter`. They do not create ATS company rows, first-collection
reservations, ingestion batches or job cards. Public source addresses identify
unverified candidates; they are not accepted employer names or guessed tenant
IDs. Configuration and full employer/job validation belong to later adapters.

The existing managed audit reads all published archive indexes, recent first
in direct-file mode. Each new platform/pattern/index combination earns its own
completion receipt, including zero-result ranges. Prior provider receipts,
saved scans, jobs, scores and operator controls remain intact. Blocks and their
candidates commit together before scratch files are deleted. The existing
mounted-drive, free-space, pacing, lock and restart controls still apply.

After deploying, start the managed worker with:

```sh
sudo systemctl start career-dashboard-discovery-audit.service
```

The worker automatically includes the new patterns without resetting completed
history. Inspect its journal and `ats:discovery:audit:status`; candidate counts
under `awaiting_adapter` are discovery inventory, not collected employers or new
jobs. Completion requires every exact receipt for the run's archive catalog.

When a collector is implemented, its registry entry takes precedence. Its saved
source-address candidates must then be explicitly resolved into the collector's
canonical board identities and normal first-collection admission. Merely adding
the adapter does not silently admit or replay the retained discovery inventory.
