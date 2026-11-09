# 0002 — DCO sign-off as a request, not a CI gate

Status: accepted (0.1.0, 2026-11).

## Decision

No CLA. External contributors are asked to sign off their commits under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) (`git commit -s`), as
`CONTRIBUTING.md` says. CI does not reject unsigned commits.

## Why

The DCO is the lighter and better of the two common mechanisms: it certifies the contributor's
right to submit the change without transferring anything. But a blocking check costs every first-time
contributor a failed run and a rebase, and today there are no outside contributors whose provenance
needs recording. Asking now keeps the habit; enforcing now only adds friction.

## When to revisit

Turn it into a required check when the first substantial outside contribution lands, or when the
project applies to a foundation that requires DCO.
