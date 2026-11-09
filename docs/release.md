# Release checklist

What a release of Topka is made of, in order. Versions follow SemVer (see
[CONTRIBUTING.md](../CONTRIBUTING.md#releases)); `0.1.0` is the first public release. Most of this
is manual: only the checks in [CI coverage](#what-ci-covers-and-what-it-does-not) run by themselves,
so a release is a person following these steps, not a button.

## 1. Bump the version

The version lives in seven `package.json` files: the root and the six workspaces
(`apps/api`, `apps/web`, `apps/worker`, `packages/backend`, `packages/contracts`, `industry`).
They must all carry the same value — `npm sbom` refuses to build the bill of materials while any
workspace package has no `version`. From the repository root:

```bash
V=0.1.0   # the version being released; 0.1.0 is already in the files for the first release
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

## [0.1.0] - 2026-11-04
```

Keep the subsections (`### Added` / `### Changed` / `### Fixed` / `### Removed`) and their entries
as written; a release moves lines, it does not rewrite them. The date is the day of the tag, in
`YYYY-MM-DD`.

## 3. Check the SBOM builds locally (optional)

CI already runs `npm sbom` on every push, and the release workflow builds the real one. To look at it
yourself, from a clean tree:

```bash
npm ci --no-audit --no-fund
npm sbom --sbom-format=cyclonedx > sbom.cyclonedx.json
node -e 'const s=require("./sbom.cyclonedx.json"); console.log(s.bomFormat, s.components.length)'
```

npm names the SBOM's root component after the checkout directory, so run it from a directory named
`topka`. `.gitignore` lists `sbom.cyclonedx.json` and `SHA256SUMS`, so they cannot be committed.

## 4. Tag on `main`

Only from a commit whose `check` workflow is green on `main`:

```bash
git switch main && git pull --ff-only
git tag -s v0.1.0 -m "Topka 0.1.0"    # -s: signed; use -a if you have no signing key configured
git push origin v0.1.0
```

## 5. The release workflow publishes it

Pushing the tag starts `.github/workflows/release.yml`, which:

- fails unless the tag equals `v` + the `version` in `package.json`;
- builds `topka-X.Y.Z.cyclonedx.json` and `topka-X.Y.Z.spdx.json` (SBOMs) and `topka-X.Y.Z.tar.gz`
  (source archive);
- builds the image for `linux/amd64` and `linux/arm64` and pushes `ghcr.io/<owner>/topka:X.Y.Z` and
  `:latest`, recording the pushed digest in `topka-X.Y.Z.image.txt`;
- writes `SHA256SUMS` over every attachment and verifies it;
- signs the image digest with cosign, keyless (a Sigstore certificate issued to this workflow at this
  tag through GitHub's OIDC token: no key or secret exists to leak);
- attests, with `actions/attest`: SLSA build provenance for every file in `SHA256SUMS` and for the
  image digest, and the CycloneDX SBOM for the image and for the source archive. The image's
  attestations are pushed to ghcr.io next to it; all of them are listed under the repository's
  *Attestations*. The workflow then verifies each one with `gh attestation verify` before it
  publishes, and attaches the files' provenance bundle as `topka-X.Y.Z.provenance.sigstore.json`;
- creates the GitHub release with the `## [X.Y.Z]` section of `CHANGELOG.md` as its notes.

Check the release page afterwards: the notes should not contain the next `## [Unreleased]` heading,
and the attachments should download and match (`sha256sum -c SHA256SUMS`). A first push to ghcr.io
creates the package as private: make it public once under the package's settings.

A pull request that changes the workflow or the `Dockerfile` runs the same steps without publishing,
so a broken release is found before a tag needs it. Its image goes to a throwaway registry on the
runner, where cosign signs it with a key made for that run and verifies it (and checks that a key
which did not sign is refused); no transparency log is written, so nothing about a private copy of
the repository reaches Sigstore's public logs. The attestation steps are the one part a pull request
cannot rehearse: GitHub issues attestations only to public repositories (or Enterprise Cloud), so
they first run for real on the first tag pushed to the public repository. Check that run's log for
the "Verify the attestations as a user would" step.

## Verifying a release

What a user runs to check that a download or an image was built by this repository's release
workflow from the tagged source (needs the [GitHub CLI](https://cli.github.com/) 2.49+ or
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 2.4+; `X.Y.Z` is the version):

```bash
# A release file (the source archive, an SBOM, the image note): provenance from this workflow
gh attestation verify topka-X.Y.Z.tar.gz --repo CyrusAurora/topka \
  --signer-workflow CyrusAurora/topka/.github/workflows/release.yml
sha256sum -c SHA256SUMS            # the rest of the attachments, against the attested list

# The image: provenance, then the SBOM attestation
gh attestation verify oci://ghcr.io/cyrusaurora/topka:X.Y.Z --repo CyrusAurora/topka
gh attestation verify oci://ghcr.io/cyrusaurora/topka:X.Y.Z --repo CyrusAurora/topka \
  --predicate-type https://cyclonedx.org/bom

# The image's cosign signature: issued to the release workflow at that tag, by GitHub's OIDC issuer
cosign verify ghcr.io/cyrusaurora/topka:X.Y.Z \
  --certificate-identity https://github.com/CyrusAurora/topka/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Offline, `gh attestation verify topka-X.Y.Z.tar.gz --bundle topka-X.Y.Z.provenance.sigstore.json
--repo CyrusAurora/topka` checks the archive against the bundle attached to the release. Pin the
digest (`ghcr.io/cyrusaurora/topka@sha256:…`, the value in `topka-X.Y.Z.image.txt`) rather than the
tag in a deployment: a tag can be moved, a verified digest cannot.

## 6. Once, after the repository is public

These two settings cannot be prepared while the repository is private, and they are what makes the
"supported versions" and reporting promises in [SECURITY.md](../SECURITY.md) real:

- **Branch protection on `main`**: Settings → Branches → a rule for `main` requiring the two jobs
  of the `Check` workflow (status checks `check` and `docker`, branch up to date before merging) and
  one approving review on a pull request, with stale reviews dismissed on push; force pushes and
  deletion of `main` are refused. "Do not allow bypassing" is left off on purpose: with one
  maintainer, a required review the author cannot give themselves would block every change, so the
  maintainer (repository admin) can merge their own pull request once `check` and `docker` are green.
  Everyone else needs the review. See [decision 0003](decisions/0003-single-maintainer.md).
- **Private vulnerability reporting**: Settings → Code security → enable "Private vulnerability
  reporting". Then send one test report through the Security tab → "Report a vulnerability" and
  confirm it arrives, so the channel is known to work before a real report needs it.

## What CI covers, and what it does not

- `check.yml` (every push and pull request): typecheck, web build and tests, backend tests with the
  85% coverage gate, smoke check, browser E2E, the publication gate, `npm run docs:links` (every
  relative Markdown link resolves) and `npm sbom` (fails while any workspace package lacks a
  `version`); a second job brings the exported tree up with `docker compose` as the README says.
- `codeql.yml` (every push, pull request and weekly): GitHub code scanning with the
  `security-extended` queries for TypeScript/JavaScript. It runs on the public repository; a private
  copy skips it, because code scanning there needs GitHub Advanced Security.
- `release.yml` (tags, and pull requests that touch it): SBOMs, checksums, multi-architecture image,
  cosign signature, provenance and SBOM attestations (a pull request rehearses all but the
  attestations; see above).

What is still not covered, said plainly:

- **The SLSA level is Build L2, not L3.** The provenance is signed and generated by the hosted
  runner, but by a step in the same job that builds, so the build could in principle influence it;
  L3 needs the isolated reusable-workflow generator, which this project does not use.
- **The SBOM is npm's.** It lists the npm dependency tree (`npm sbom`), not the base image's
  operating-system packages.
- **Attestations are untested until the first public tag** (see above): signing is rehearsed on
  every pull request that touches the workflow, attestation is not.
- **Code blocks in the docs are not executed** by CI; the Docker job runs the README quickstart and
  the tutorial was run by hand for 0.1.0.
