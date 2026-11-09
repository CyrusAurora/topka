# Governance

Topka is a small project with one maintainer today. This document says who decides what, how
someone becomes a maintainer, and what the repository owner keeps the final word on — plainly, so
that nobody has to guess how the project actually works.

## Decision making

Most changes need no process at all: open a pull request, and a maintainer reviews it on its merits.

Larger changes — a new dependency, a schema migration that cannot be undone, a change to the public
API, the scoring rubric, or anything that alters how a self-hosted site behaves by default — should
start as an issue that says what problem it solves and what it would change. The rule is **lazy
consensus**: if no maintainer objects with a reason within seven days, the change may proceed.

Today there is a single maintainer, so in practice that maintainer decides. This is stated here
rather than dressed up as a committee: pretending to a process the project does not have would be
worse than having a simple one.

## Becoming a maintainer

Anyone who has been working with the project can be nominated. The bar is meant to be reachable,
not ceremonial:

- five or more merged pull requests, each reviewed and accepted by a current maintainer;
- at least one release's worth of participation — reviewing someone else's change, triaging
  issues, improving documentation, or answering users;
- nomination by a current maintainer, with no objection from the others within seven days.

A new maintainer gets triage and merge rights on the areas they have worked in, and is added to
`MAINTAINERS.md` and `.github/CODEOWNERS` in the same pull request that grants the rights. Access
and the written record change together, never one without the other.

## How disagreement is resolved

1. Discuss on the issue or pull request, on the technical merits. Restate the other position before
   arguing against it.
2. If it does not converge, a maintainer writes down the options and the trade-off in the issue and
   asks for a decision within seven days.
3. If maintainers disagree among themselves, the repository owner decides, and the reason is
   recorded in the issue so the same question is not reopened from scratch.

## What the repository owner keeps

Final say on exactly two things, because they cannot be delegated safely:

- **the name and the logo** — whether a use of the Topka name is allowed (see `TRADEMARK.md`);
- **security** — whether an unresolved vulnerability makes a release unshippable.

Nothing else. Code, documentation, features, roadmap and releases are maintainer decisions.

## Releases and support

- One release per quarter, on `main`, even when a quarter's changes are small — a steady cadence is
  the clearest sign a project is alive.
- A release moves `## [Unreleased]` in `CHANGELOG.md` into a dated section and tags it `vX.Y.Z`.
- Support is best-effort with no SLA; `SUPPORT.md` says what that means and what it does not promise.

## Recorded decisions

Decisions that a newcomer would otherwise reopen — the license, contributor sign-off, the size of
the maintenance promise — are written down with their reasons in `docs/decisions/`. Reopening one is
welcome: open an issue that says what has changed since it was taken.

## Changing this document

A pull request that edits this file needs the same seven-day lazy-consensus window as any other
change, and the final wording is the repository owner's, since it is the one document that
constrains them.
