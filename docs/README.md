# Documentation index

Everything below is in English except the tutorial and the README, which exist in both languages.

Start here:

- [Tutorial](tutorial.en.md) ([简体中文](tutorial.md)) — from zero to a card on screen in about 30
  minutes, no API key, no GPU (offline demo data, then two real sources), with the output to expect at
  every step and a table of the usual snags.
- The project README, in [Chinese](../README.md) (primary: the UI and the generated content are
  Chinese-first) and [English](../README.en.md).

Project:

- [Contribution guide](../CONTRIBUTING.md) — setup, commands, migration and PR conventions.
- [Governance](../GOVERNANCE.md) — who decides what, how a maintainer is added, what the owner keeps.
- [Maintainers](../MAINTAINERS.md) — who reviews which area today.
- [Support](../SUPPORT.md) — what help exists and what it does not promise.
- [Trademark and name use](../TRADEMARK.md) — the licence covers the code, not the name.
- [Security policy](../SECURITY.md) — supported versions, private reporting, scope.
- [Threat model](threat-model.md) — trust boundaries and what is in scope for an attacker.
- [Upstream & third-party notices](../NOTICE) — Topka attribution and bundled asset licenses.
- [Decision records](decisions/README.md) — why MIT and not Apache-2.0, why DCO is a request and
  not a gate, why the maintenance promise is one maintainer and best-effort.
- [Release checklist](release.md) — bumping versions, the SBOM, tagging and publishing a release.

Architecture & operation:

- [Architecture](architecture.md) — data flow, process layout, invariants, directory map.
- [Self-hosting](self-hosting.md) — the end-to-end deployment guide (Docker compose, BYOK,
  HTTPS, migrations, upgrades, backups, troubleshooting). Replaces the earlier `self-host.md`
  and `deploy.md`.
- [Configuration](configuration.md) — configuration reference for every surface.

Customization:

- [Adapt it to a different industry](customize.md) — the `industry/` pack, step by step.
- [Sources](sources.md) — the six source kinds, filters, caps, external push endpoint.
- [Selection & calibration](selection.md) — the editorial rubric and how to recalibrate it.
- [Model leaderboard](leaderboard.md) — `/leaderboard` and the Codex reset monitor.

Extension:

- [Plugins](plugins.md) — add extra code to a running site via `TOPKA_PLUGINS`.

Maintenance:

- [Secret scan](ci-secret-scan.md) — keep real credentials out of the diff and CI.

