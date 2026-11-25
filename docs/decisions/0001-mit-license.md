# 0001 — MIT, not Apache-2.0

Status: accepted (2026-11).

## Decision

Topka stays under the MIT License. It does not move to Apache-2.0.

## Why

- **Part of the code carries a third-party MIT copyright** (`LICENSE`) and cannot be relicensed.
  Moving would mean a per-file dual license with REUSE-style headers across the tree.
- **The benefit does not apply here.** Apache-2.0's main addition over MIT is the express patent
  grant and patent-retaliation clause. The project holds no patents and has no plans to file any.
- **One license is easier to comply with.** Anyone reusing the code keeps one copyright notice
  (`LICENSE`); nothing more.

## What we give up

No express patent licence from contributors. A contributor could in principle hold a patent on what
they contributed; MIT's implied licence is weaker than Apache-2.0's explicit one.

## When to revisit

If the project is about to join a foundation that requires Apache-2.0, or a contributor with a
patent portfolio starts contributing substantial code.
