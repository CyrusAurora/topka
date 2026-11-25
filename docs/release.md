# Release checklist

What a release of Topka is made of, in order. Versions follow SemVer (see
[CONTRIBUTING.md](../CONTRIBUTING.md#releases)); `1.0.0` is the first public release. Most of this
is manual: only the checks in [CI coverage](#what-ci-covers-and-what-it-does-not) run by themselves,
so a release is a person following these steps, not a button.

## 1. Bump the version

The version lives in seven `package.json` files: the root and the six workspaces
(`apps/api`, `apps/web`, `apps/worker`, `packages/backend`, `packages/contracts`, `industry`).
They must all carry the same value — `npm sbom` refuses to build the bill of materials while any
workspace package has no `version`. From the repository root:

<!-- doc-test: run scratch -->
```bash
V=1.0.0   # the version being released
for f in package.json apps/*/package.json packages/*/package.json industry/package.json; do
  sed -i -E "s/^(\s*)\"version\": \"[^\"]*\"/\1\"version\": \"$V\"/" "$f"
done
grep -H '"version"' package.json apps/*/package.json packages/*/package.json industry/package.json
```

The lockfile repeats each workspace's `version`, so refresh it in the same commit with
`npm install --package-lock-only --no-audit --no-fund` (it must change only those `version` lines),
then confirm `npm ci` passes.

Dependabot does not update `docker-compose.yml`. Bump the pinned `rsshub` image there to a recent
dated tag and its digest (both from <https://hub.docker.com/r/diygod/rsshub/tags>), and keep the
tag and the digest from the same build.

## 2. Turn `## [Unreleased]` into the release section

In `CHANGELOG.md`, replace the `## [Unreleased]` heading with the version and today's date, and
start a fresh empty `## [Unreleased]` above it (Keep a Changelog keeps the empty section so the
next change has a home):

```text
## [Unreleased]

## [1.0.0] - 2026-11-25
```

Keep the subsections (`### Added` / `### Changed` / `### Fixed` / `### Removed`) and their entries
as written; a release moves lines, it does not rewrite them. The date is the day of the tag, in
`YYYY-MM-DD`.

## 3. Check the SBOM builds locally (optional)

CI already runs `npm sbom` on every push, and the release workflow builds the real one. To look at it
yourself, from a clean tree:

<!-- doc-test: run repo -->
```bash
npm ci --no-audit --no-fund
npm sbom --sbom-format=cyclonedx > sbom.cyclonedx.json
node -e 'const s=require("./sbom.cyclonedx.json"); console.log(s.bomFormat, s.components.length)'
```

npm names the SBOM's root component after the checkout directory, so run it from a directory named
`topka`. `.gitignore` lists `sbom.cyclonedx.json` and `SHA256SUMS`, so they cannot be committed.

## 4. Tag on `main`

Only from a commit whose `check` workflow is green on `main`:

<!-- doc-test: skip creates and pushes a signed release tag, by hand -->
```bash
git switch main && git pull --ff-only
git tag -s v1.0.0 -m "Topka 1.0.0"    # -s: signed; use -a if you have no signing key configured
git push origin v1.0.0
```

## 5. The release workflow publishes it

Pushing the tag starts `.github/workflows/release.yml`. Its jobs:

- **build** (no OIDC token, so nothing in it can sign): fails unless the tag is `v` + the `version` in
  `package.json` (or `v` + version + `-<label>`, a pre-release); builds `topka-X.Y.Z.cyclonedx.json`
  and `topka-X.Y.Z.spdx.json` (SBOMs) and `topka-X.Y.Z.tar.gz` (source archive); builds the image for
  `linux/amd64` and `linux/arm64` and pushes `ghcr.io/<owner>/topka:X.Y.Z` and `:latest` (a pre-release
  pushes only its own tag), recording the digest in `topka-X.Y.Z.image.txt`; writes and checks
  `SHA256SUMS` over every file, and hands the digests on;
- **provenance-files** and **provenance-image**: SLSA provenance for the files and for the image,
  generated and signed by [slsa-github-generator](https://github.com/slsa-framework/slsa-github-generator)
  (see [Provenance](#provenance-slsa-build-level-3)); the image's is pushed to ghcr.io next to it;
- **attest** (no checkout, no repository code): signs the image digest with cosign, keyless (a
  Sigstore certificate issued to this workflow at this tag), and writes GitHub artifact attestations:
  build provenance for every file in `SHA256SUMS` and for the image, and the CycloneDX SBOM for the
  image and for the source archive;
- **publish**: verifies all of it as a user would (`slsa-verifier`, `gh attestation verify`, and that a
  wrong tag or a changed file is refused), then creates the GitHub release with the `## [X.Y.Z]` section
  of `CHANGELOG.md` as its notes and every file attached, including `topka-X.Y.Z.intoto.jsonl` (the SLSA
  provenance) and `topka-X.Y.Z.provenance.sigstore.json` (the GitHub attestation bundle).

Check the release page afterwards: the notes should not contain the next `## [Unreleased]` heading,
and the attachments should download and match (`sha256sum -c SHA256SUMS`).

A pull request that changes the workflow or the `Dockerfile` runs the build job without publishing,
so a broken build is found before a tag needs it. Its image goes to a throwaway registry on the
runner, where cosign signs it with a key made for that run and verifies it (and checks that a key
which did not sign is refused); no transparency log is written, so nothing about a private copy of
the repository reaches Sigstore's public logs. Provenance and attestations cannot run there: they
need the public repository. Rehearse them with a pre-release (below).

## Provenance: SLSA Build Level 3

[SLSA Build L3](https://slsa.dev/spec/v1.0/levels#build-l3) asks for provenance that is generated by a
hosted build platform, from a build isolated from other builds, and that the build itself cannot
forge. How each holds here:

- **Hosted**: every job runs on a fresh GitHub-hosted runner; no self-hosted machine is involved.
- **Isolated**: the build job runs alone on its runner and shares nothing with the provenance jobs but
  the digests it reports. It has no `id-token` permission, so npm install scripts or a Dockerfile step
  cannot obtain a signing identity.
- **Non-falsifiable**: the provenance is generated and signed in slsa-github-generator's reusable
  workflows, on their own runners, with a Sigstore certificate naming
  `slsa-framework/slsa-github-generator/.github/workflows/generator_…_slsa3.yml@refs/tags/v2.1.0` —
  the builder `slsa-verifier` trusts — and recorded in Sigstore's public transparency log. Nothing in
  this repository's workflow can obtain that identity, so a build step cannot write provenance that
  verifies.

The generator is referenced by its release tag (`@v2.1.0`), not a commit SHA, because it checks the
ref it was called at; it is the one action in the workflows not pinned to a SHA.

The GitHub attestations (`gh attestation verify`) and the cosign signature are signed by this
repository's own release workflow, in a job that runs no repository code. They are kept because
`gh` is easy to use. The L3 claim rests on the generator's provenance, so verify with `slsa-verifier`
when it matters.

## Verifying a release

What a user runs to check that a download or an image was built by this repository's release
workflow from the tagged source. `X.Y.Z` is the version; the tools are
[slsa-verifier](https://github.com/slsa-framework/slsa-verifier) 2.7+, the
[GitHub CLI](https://cli.github.com/) 2.49+ and
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 3.0+ (the signature is stored
as an OCI referrer in the Sigstore bundle format, which cosign 2 does not find).

<!-- doc-test: skip needs a published release (X.Y.Z is a placeholder); the release workflow's publish job runs these checks on every tag -->
```bash
# SLSA Build L3 provenance (the generator's): a release file, then the image
slsa-verifier verify-artifact topka-X.Y.Z.tar.gz --provenance-path topka-X.Y.Z.intoto.jsonl \
  --source-uri github.com/CyrusAurora/topka --source-tag vX.Y.Z
slsa-verifier verify-image ghcr.io/cyrusaurora/topka@sha256:<digest from topka-X.Y.Z.image.txt> \
  --source-uri github.com/CyrusAurora/topka --source-tag vX.Y.Z
sha256sum -c SHA256SUMS            # the rest of the attachments, against the attested list

# GitHub attestations (signed by the release workflow): a file, the image, the image's SBOM
gh attestation verify topka-X.Y.Z.tar.gz --repo CyrusAurora/topka \
  --signer-workflow CyrusAurora/topka/.github/workflows/release.yml
gh attestation verify oci://ghcr.io/cyrusaurora/topka:X.Y.Z --repo CyrusAurora/topka
gh attestation verify oci://ghcr.io/cyrusaurora/topka:X.Y.Z --repo CyrusAurora/topka \
  --predicate-type https://cyclonedx.org/bom

# The image's cosign signature: issued to the release workflow at that tag, by GitHub's OIDC issuer
cosign verify ghcr.io/cyrusaurora/topka:X.Y.Z \
  --certificate-identity https://github.com/CyrusAurora/topka/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

`slsa-verifier` checks the provenance signature against the generator's identity, the file's digest
against the provenance's subjects, and the source repository and tag; add `--print-provenance` to see
the whole statement. Offline, `gh attestation verify topka-X.Y.Z.tar.gz --bundle
topka-X.Y.Z.provenance.sigstore.json --repo CyrusAurora/topka` checks the archive against the bundle
attached to the release. Pin the digest (`ghcr.io/cyrusaurora/topka@sha256:…`, the value in
`topka-X.Y.Z.image.txt`) rather than the tag in a deployment: a tag can be moved, a verified digest
cannot.

## Rehearsing a release

To try the whole pipeline (provenance, attestations, publishing) without making a release, push a
pre-release tag on `main` and remove it afterwards:

<!-- doc-test: skip pushes a tag and starts the real release workflow on the public repository -->
```bash
git tag -a v1.1.0-rc.1 -m "pipeline rehearsal"     # the package.json version + "-<label>"
git push origin v1.1.0-rc.1
gh run watch "$(gh run list --workflow release.yml --branch v1.1.0-rc.1 --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
# download the files and run the commands under "Verifying a release" with X.Y.Z = 1.1.0-rc.1, then:
gh workflow run release-cleanup.yml -f tag=v1.1.0-rc.1
```

A pre-release is marked as such on GitHub, is not "latest", and its image carries only its own tag.
The cleanup workflow (`.github/workflows/release-cleanup.yml`) deletes the release, the tag and the
image versions its run pushed (the image, its platform manifests, signature and attestations); it
refuses a tag without a `-<label>`, a full release, and any image version in the run's time window
carrying another tag. Entries in Sigstore's transparency log are permanent; they name the tag and
digest, nothing else.


## 6. Repository settings

Applied to `CyrusAurora/topka` once, when the repository is created. They are what makes the
"supported versions" and reporting promises in [SECURITY.md](../SECURITY.md) real.

- **Branch protection on `main`**: force pushes and deletion are refused, history stays linear, and
  review conversations must be resolved. No review or status check is required: the maintainer
  pushes to `main` (fast-forward, never forced) after the full check suite passes locally, and
  watches the `Check` run afterwards. Contributors open pull requests, and `Check` runs on each.

  <!-- doc-test: skip changes repository settings with an admin token -->
  ```bash
  gh api -X PUT repos/CyrusAurora/topka/branches/main/protection --input - <<'JSON'
  {"required_status_checks":null,"enforce_admins":false,"required_pull_request_reviews":null,
   "restrictions":null,"allow_force_pushes":false,"allow_deletions":false,
   "required_conversation_resolution":true,"required_linear_history":true}
  JSON
  ```

- **Private vulnerability reporting**: on
  (`gh api -X PUT repos/CyrusAurora/topka/private-vulnerability-reporting`; reads back
  `{"enabled":true}`).
- **Secret scanning and push protection**: on. **Dependabot**: off.
- **Actions**: default workflow permissions read-only; workflows cannot approve pull requests.
- **Pages**: built by `.github/workflows/pages.yml`, HTTPS enforced; the `github-pages` environment
  deploys from `main` only.
- **CodeQL alerts**: run the dismissal loop in
  [security/codeql-triage.md](security/codeql-triage.md) after the first analysis of `main`.
- **The image**: a package pushed by the release workflow of a public repository is public and linked
  to it (`org.opencontainers.image.source`); check that `docker pull ghcr.io/cyrusaurora/topka:X.Y.Z`
  works with no login.

## What CI covers, and what it does not

- `check.yml` (every push to `main` and every pull request): typecheck, web build and tests, backend
  tests with the 85% coverage gate, smoke check, browser E2E, the publication gate, `npm run docs:links`
  (every relative Markdown link resolves), `npm sbom` (fails while any workspace package lacks a
  `version`), and the docs' code blocks ([doc-blocks.md](doc-blocks.md)); a second job brings the
  exported tree up with `docker compose` as the README says, then follows the README, the tutorial,
  self-hosting and contributing pages block by block on port 3300.
- `codeql.yml` (every push, pull request and weekly): GitHub code scanning with the
  `security-extended` queries for TypeScript/JavaScript. It runs on the public repository; a private
  copy skips it, because code scanning there needs GitHub Advanced Security.
- `release.yml` (tags, and pull requests that touch it): SBOMs, checksums, multi-architecture image,
  SLSA Build L3 provenance, cosign signature, GitHub attestations, all verified before publishing (a
  pull request rehearses the build and the signature; a pre-release tag rehearses everything).

What is not covered:

- **The SBOM is npm's.** It lists the npm dependency tree (`npm sbom`), not the base image's
  operating-system packages.
- **Some doc blocks are skipped**, each with its reason (`node scripts/doc-blocks.ts --list`): lines
  for `.env`, placeholder values, outside calls (live models, real feeds, a 4.7 GB local model), a real
  domain for HTTPS, admin-token commands. Their npm scripts, paths and compose services are still
  checked to exist.
- **The base images are trusted as published**: the provenance covers this repository's build, not
  `node:24-trixie-slim` or `postgres` themselves.
