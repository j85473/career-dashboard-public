# Automatic public source updates

The private operational repository owns development and deployment. Its public-copy workflow runs after pushes to `main`, after successful M70 deployment workflows, and on manual dispatch. Publication runs independently of production deployment. Every run checks out the latest private `main`, so a delayed deployment event cannot publish an older source version.

The publisher reads tracked files from one private source commit and creates a sanitized file snapshot. It clones only the public repository into a separate directory, audits that public history, and creates an ordinary commit whose only parent is the preceding public commit. It never merges private branches, copies a `.git` directory, force-pushes, or pushes private refs. Identical snapshots create no new commit.

## Evidence controls

- Exclude the EI, condensed JSON, legacy embedded-evidence prompt, agent state, interview-prep folders, runtime exports, and environment secrets.
- Reject known historical EI blobs even if renamed. Include current excluded evidence blobs in that check.
- Reject EI headings, candidate evidence table rows, and bulk candidate evidence identifiers in other files.
- Replace the candidate-specific parser integration test with a reviewed fictional fixture. A changed integration-test format stops publication for review.
- Require exact reviewed hashes for binary files. New or changed binary files stop publication.
- Automatically include new code files in established source directories. Hold new documents, data files, and other unreviewed paths out until explicitly added to the publication policy.
- Recheck every staged file and the public commit's parent before pushing. The workflow publishes no snapshot artifact and logs no source file bodies.

Public workflow files come only from a reviewed validation template. Production workflows, credentials, and the publisher's workflow are not copied into the public repository's Actions directory.

## Access and maintenance

`PUBLIC_COPY_DEPLOY_KEY` is a private-repository Actions secret. Its matching write-enabled deploy key belongs only to `j85473/career-dashboard-public`. The publisher uses anonymous HTTPS to clone public history, then loads the dedicated key only for the final non-forced push. GitHub host keys come from GitHub's HTTPS metadata endpoint and SSH host checking stays enabled.

The publication policy is `.github/public-copy-policy.json`. Review a held document or changed binary before adding its path or hash. Never add an EI path or private evidence fingerprint to an allowlist. The EI remains tracked and usable in the private operational repository.

Run `node --test tests/unit/publicCopyMirror.test.mjs` to test the safeguards. To prepare a local update, commit the intended source first, clone the public repository separately, then run `node scripts/public-copy/sync.mjs PRIVATE_CHECKOUT PUBLIC_CHECKOUT`. That command prepares and commits the public snapshot but does not push it. Inspect the resulting public diff before a manual push.

Publication failure leaves the previous public revision in place. It does not change the private source, production files, database, existing scores, or deploy workflow.
