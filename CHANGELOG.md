# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.0] - 2026-11-25

The first release of Topka: a self-hosted daily brief. Tell it what to watch; every morning at 8 it
picks up to three items from your own sources, each linked to the original.

- **Your own daily issue**: one issue a day per reader, finalised at 08:00 in the reader's time zone.
  When nothing clears the bar, the issue is shorter or empty, never padded. Every issue stays in
  Archive.
- **Projects**: describe what you want to follow in Chat, or pick a pack (AI models, embodied AI and
  robotics, open source and developers, semiconductors and compute) in the wizard, then choose the
  sources to watch.
- **Your sources**: RSS, web list pages, JSON feeds, X searches and page watch for pages without a
  feed. Corrections and withdrawals are kept: when a source changes or removes an article, you see the
  earlier version and the change.
- **Leads from outside your sources**: paste a link, or let directory feeds turn up leads; a lead
  becomes an update only when one of your sources publishes the same link.
- **Bring your own key**: any OpenAI-compatible model, a free OpenRouter model or local Ollama. A
  reader can add their own key when the operator allows it; budgets and a receipt ledger cap what
  model calls cost.
- **Starts without a key**: `docker compose up` with demo data and a demo model for Chat. Try it
  online first at <https://cyrusaurora.github.io/topka/>.
- **Chinese and English**: the whole interface, including admin, in both languages.
- **Admin**: sources, content, runs, selection benchmark and settings; alerts to a webhook when
  collection fails or a budget trips.
- **Adapt it to another industry** by editing one folder, `industry/` (docs/customize.md).
- **Signed releases**: release files and the image carry SLSA Build L3 provenance, GitHub
  attestations and SBOMs (docs/release.md).

[Unreleased]: https://github.com/CyrusAurora/topka/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/CyrusAurora/topka/releases/tag/v1.0.0
