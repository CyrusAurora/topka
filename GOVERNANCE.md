# Governance

Who decides what, how someone becomes a maintainer, and what the repository owner keeps the final
word on.

## Decision making

Most changes need no process at all: open a pull request, and a maintainer reviews it on its merits.

Larger changes — a new dependency, a schema migration that cannot be undone, a change to the public
API, the scoring rubric, or anything that alters how a self-hosted site behaves by default — should
start as an issue that says what problem it solves and what it would change. The rule is **lazy
consensus**: if no maintainer objects with a reason within seven days, the change may proceed.

Today there is one maintainer, who decides.

## Becoming a maintainer

Anyone who has been working with the project can be nominated:

- five or more merged pull requests, each reviewed and accepted by a current maintainer;
- at least one release's worth of participation — reviewing someone else's change, triaging
  issues, improving documentation, or answering users;
- nomination by a current maintainer, with no objection from the others within seven days.

A new maintainer gets triage and merge rights on the areas they have worked in, and is added to
`MAINTAINERS.md` in the same pull request that grants the rights. `.github/CODEOWNERS` is added,
listing each maintainer's areas, when a second maintainer joins.

## How disagreement is resolved

1. Discuss on the issue or pull request, on the technical merits. Restate the other position before
   arguing against it.
2. If it does not converge, a maintainer writes down the options and the trade-off in the issue and
   asks for a decision within seven days.
3. If maintainers disagree among themselves, the repository owner decides, and the reason is
   recorded in the issue so the same question is not reopened from scratch.

## What the repository owner keeps

Final say on two things:

- **the name and the logo** — whether a use of the Topka name is allowed (see `TRADEMARK.md`);
- **security** — whether an unresolved vulnerability makes a release unshippable.

Nothing else. Code, documentation, features, roadmap and releases are maintainer decisions.

## Releases and support

- At least one release per quarter, on `main`.
- A release moves `## [Unreleased]` in `CHANGELOG.md` into a dated section and tags it `vX.Y.Z`.
- Support is best effort, with no SLA (`SUPPORT.md`).

## Recorded decisions

The license, contributor sign-off and the maintenance promise are recorded in `docs/decisions/`. To
reopen one, open an issue that says what has changed.

## Changing this document

A pull request that edits this file needs the same seven-day lazy-consensus window as any other
change; the final wording is the repository owner's.
