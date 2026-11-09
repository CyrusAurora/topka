# 0003 — One maintainer, best-effort: no bus-factor or on-call promise

Status: accepted (0.1.0, 2026-11).

## Decision

The project says plainly that it has one maintainer and that support is best-effort with no SLA
(`README.md`, `SUPPORT.md`, `MAINTAINERS.md`, `GOVERNANCE.md`). It does not promise a bus factor of
three, an on-call rotation, or a neutral-governance timeline. What it does promise is small enough
to keep: a quarterly release, a 7-day acknowledgement target for private security reports, and a
plain statement in the README if maintenance ever stops.

## Why

Enterprise open-source playbooks ask for several maintainers, a rota and a path to neutral
governance. Writing those down with one person behind them would be a rule the project visibly does
not follow, which costs more trust than stating the real situation.

## Consequence for branch protection

`main` requires the `check` and `docker` status checks and one approving review, and refuses force
pushes and deletion (`docs/release.md` §6). A single maintainer cannot approve their own pull
request, so the rule is not enforced for repository admins: the maintainer merges their own change
after CI is green, without a second pair of eyes, and the history says so (no approving review on
those pull requests). External contributions still need the maintainer's review. The admin
exemption is removed when a second maintainer can review.

## When to revisit

When a second maintainer is added (`GOVERNANCE.md` → Becoming a maintainer), the promises in
`SUPPORT.md` and `SECURITY.md`, and the admin exemption from branch protection, are revisited in
the same pull request.
