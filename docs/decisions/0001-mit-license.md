# 0001 — MIT, not Apache-2.0

Status: accepted (0.1.0, 2026-11).

## Decision

Topka stays under the MIT License, the license of the upstream Topka framework it is forked from.
It does not move to Apache-2.0.

## Why

- **The upstream code is MIT and not ours to relicense.** MIT lets us publish our own changes under
  another license, but it does not let us restate the upstream author's code as Apache-2.0. Moving
  would mean a per-file dual license (MIT for upstream-derived files, Apache-2.0 for new ones) with
  REUSE-style headers across the tree, and every contributor deciding which side a new file is on.
- **The benefit does not apply here.** Apache-2.0's main addition over MIT is the express patent
  grant and patent-retaliation clause. The project holds no patents and has no plans to file any.
- **One license is easier to comply with.** Anyone reusing the code keeps one copyright notice
  (`LICENSE`) and the attributions in `NOTICE`; nothing more.

## What we give up

No express patent licence from contributors. A contributor could in principle hold a patent on what
they contributed; MIT's implied licence is weaker than Apache-2.0's explicit one.

## When to revisit

If the project is about to join a foundation that requires Apache-2.0, or a contributor with a
patent portfolio starts contributing substantial code.
