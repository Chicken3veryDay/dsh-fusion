# Agent Note: Event-driven Linux scope quiescence

Status: implemented

English | [中文](2026-11-07-scope-cgroup-events.zh.md)

## Problem

A Linux handle proves its own range empty through its transient user-systemd scope, as [native containment](../../archived/architecture/2026-08-28-subprocess-native-containment.md) decided. `waitForExit()` observed that scope only by polling `systemctl --user show`, starting at 50 ms and doubling to at most 5 s. When a descendant outlived the direct child, the wait returned at the next poll tick, up to about 1 s after the last member exited, and each tick forked `systemctl`.

## Decision

`SystemdScopeOwner` in `packages/subprocess/subprocess-local/src/linux-scope.ts` keeps the systemctl poll as the authority and adds a wake-up from the kernel. The range query also asks for the scope's `ControlGroup`. Once the scope is established, `CgroupEventsWatch` (`src/cgroup-events.ts`) watches `<cgroup mount>/<ControlGroup>/cgroup.events` with a non-persistent `fs.watch`. The mount is the fixed unified-hierarchy path `/sys/fs/cgroup`.

An event is a wake-up, never the proof. The observer reads `cgroup.events` after each event:

- `populated 0` ends the wait once the launcher is known to be inside the scope, which the consumed launch request proves. The observer checks the request before it reads the file: the launcher consumes its request only after entering the scope, so a read that follows observed consumption describes the range after entry, while a read taken before entry can be followed by entry and consumption before the check. The kernel clears the flag when the last member exits, the same transition systemd uses to end a scope. Before the request is consumed the same reading is not final: an empty cgroup can be a scope's initial state, a freezer-only change (`cgroup.events` also notifies for `frozen`), or the setup helper that systemd forks into a delegated scope leaving before the launcher attaches. Those cases fall through to `systemctl` like a missing file.
- `populated 1` keeps waiting with no query; the sleep restarts at the same interval without doubling it.
- A missing, unreadable or unparsable file falls through to one `systemctl show`, which decides as before.

The poll stays armed beside the watch with today's intervals, so a missed or coalesced event costs no more than before. After attaching, one read closes the window between the last query and the watch: a flag already at `populated 0` sends the observer to `systemctl` instead of ending the wait, because an active scope with no members yet is not proof of an empty range.

A cgroup wake never acknowledges a `signal()`: a signal that arrives with an event pending still gets its immediate `systemctl` query, and the event is kept for the next sleep. Termination (`systemctl stop` after `TasksCurrent 0` on a requested termination) and the terminal-scope paths are unchanged. The watcher closes when the observation settles or fails, on `cleanup()`, and on `terminateForHostExit()`. A watcher released by an observation that failed can be attached again by the retried range wait; one that was silent or degraded stays as it was, and after `cleanup()` or `terminateForHostExit()` no wait attaches one again. An aborted caller does not cancel the shared observation, so the watcher lives until the range is empty.

Establishment is corrected. The archived decision treated a loaded `inactive` or `failed` unit as proof of an empty range. Real systemd contradicts that: after `StartTransientUnit` creates the scope and before its start job runs, `systemctl show` reports `LoadState=loaded ActiveState=inactive TasksCurrent=[not set]` (5 of 12 launches on systemd 259), and the launcher then enters the scope and runs the target. A range wait that read that state resolved early, latched `stopped`, and left the target outside `terminate()`, SIGKILL escalation, disposal and host exit. A loaded unit that has not started now counts like an absent one while establishment is pending: the wait continues while the launcher runs with an unconsumed request, and ends when the launcher has exited without consuming it. A unit that has started (any state other than `inactive` or `failed`) or a consumed request establishes the scope, after which `inactive` or `failed` proves the range empty as before.

A query response is combined only with request evidence observed before the query was issued. The manager can answer a query issued while the request still exists with a pre-start state (loaded `inactive` or `failed`, `not-found`, or a missing-unit error) that reaches the owner after the launcher consumed its request and started the target. Promoting establishment from that later consumption and reading the old response as an exited unit resolved the wait, latched `stopped`, and turned termination, escalation and host-exit cleanup into no-ops while the target ran. The owner therefore records whether the request was unconsumed when it issues each query; when the request was consumed while the response was in flight, it discards the response and queries again. The same rule applies to the `TasksCurrent 0` termination check, which counts a consumed request as entry only when it was consumed before the query.

A host without the unified hierarchy (cgroup v1 or hybrid, detected by a missing `cgroup.controllers`) and a scope collected before the watch starts use the poll silently. Any other fault, such as `EACCES`, inotify exhaustion, a watcher `error`, or an unreadable or unparsable file, goes once per owner to `reportDegraded`; the runtime logs the first at `warn` and later ones at `debug`. The fault closes the watch for the rest of that owner's life, and the poll then observes alone.

Latency from direct-child exit to `waitForExit()` settling, medians of 10 runs per row on a loaded host, with a descendant that lives:

| Descendant | Poll only | With events |
|---|---|---|
| 0.05 s | 68 ms | 49 ms |
| 0.2 s | 390 ms | 199 ms |
| 0.4 s | 802 ms | 399 ms |
| 0.9 s | 1611 ms | 899 ms |
| 2.2 s | 3220 ms | 2199 ms |

With events the wait ends within a few milliseconds of the last member's exit; the rows above include the descendant's own remaining lifetime.

## Alternatives considered

**D-Bus `PropertiesChanged` subscription.** It needs a D-Bus client dependency or a long-lived `busctl`/`dbus-monitor` child per scope, against zero extra processes for an inotify watch on one file.

**Keep a loaded `inactive` unit as proof of an empty range.** It is the archived decision, and it holds for a unit that ran and ended. It fails for a unit whose start job is still queued, and the two read the same through `LoadState`, `ActiveState` and `TasksCurrent`; the consumed request and the launcher's liveness tell them apart.

**Replace the poll with the watch.** A dropped event, an `IN_Q_OVERFLOW`, or a watch attached after the transition would hang `waitForExit()`. The poll bounds the worst case at today's behavior.

**End the wait on `populated 0` after attaching.** A scope that is active but empty before its payload entered the cgroup would resolve early, and the existing `emptyRange` rule exists for that case. Only a transition seen as an event, or `systemctl`, ends the wait.

**Read `/proc/<pid>/cgroup` for the path.** The direct process can be gone by the time the watch starts. The scope's `ControlGroup` property rides on the query the observer already makes.

**Count tasks from `pids.current` in `inspectTaskCount`.** It would drop a blocking `spawnSync systemctl` per terminal sample, but `inspectTaskCount` returns a count only for an `active` unit, and a cgroup file read cannot tell a deactivating scope from an active one, so the result would differ. The blocking query stays.

## Consequences

`waitForExit()` no longer overshoots the last member's exit by a poll interval on cgroup v2 hosts, and an exiting range costs one `fs.watch` instead of repeated `systemctl` forks after the first. Hosts on cgroup v1 or hybrid behave exactly as before. The fixed `/sys/fs/cgroup` mount is a systemd convention; a different mount point takes the silent poll path. Tests inject the cgroup root, watcher, file reader and poll sleep, and `tests/native-containment.spec.ts` ends a real scope's wait through the kernel event with the poll timer disabled, so a regression hangs instead of passing late.
