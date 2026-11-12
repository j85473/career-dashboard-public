# Private candidate evidence

This public copy contains application source and an independently maintained public Git history. The private Evidence Inventory, condensed evidence JSON, and legacy prompt containing embedded evidence are excluded from source snapshots and ignored for future commits.

Candidate-specific scoring requires an authorized private copy of `docs/Candidate_Evidence_Inventory_-_Core_v1.md` at that exact local path. Obtain it privately from its owner and preserve its approved bytes. Never substitute sample facts for real candidate evidence.

Public validation uses fictional evidence. The complete application test suite also exercises candidate-specific scoring and requires privately supplied evidence. Production deployment and canonical evidence checks remain in the private operational repository.

A private GitHub workflow updates this public repository from sanitized source snapshots. It checks the public history and proposed files before creating a commit with only the preceding public commit as its parent. It never merges, fetches, or pushes private history into this repository. See [publication safeguards](PUBLIC_COPY_AUTOMATION.md).
