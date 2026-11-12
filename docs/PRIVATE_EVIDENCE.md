# Private candidate evidence

This public source copy excludes the candidate Evidence Inventory, its condensed JSON copy, and the legacy evaluator prompt that embedded that JSON. These files are also excluded from the published Git history and ignored for future commits.

Candidate-specific scoring requires an authorized private copy of `docs/Candidate_Evidence_Inventory_-_Core_v1.md` at that exact local path. Obtain it privately from its owner. Do not substitute an empty file or sample facts for a real scoring run. Preserve the approved bytes when provisioning it.

Public validation exercises the evidence parser using fictional records. Run it with `node --import tsx --test src/lib/__tests__/scoringFoundation.test.ts`. The complete `npm test` suite also exercises candidate-specific scoring and requires privately supplied evidence. The private operational repository retains the canonical evidence checks and owns production deployment. The deployment workflow is restricted to that repository; the public copy has no production deployment credentials.

Never merge history from the private operational repository into this repository. Transfer reviewed source changes without importing private history, then inspect the staged files before pushing. Keep the inventory and derived copies out of commits, pull requests, logs, and build artifacts.
