# Agent Note: Event-driven Linux scope quiescence

Status: implemented

English | [中文](2026-11-07-scope-cgroup-events.zh.md)

## Problem

A Linux handle proves its own range empty through its transient user-systemd scope, as [native containment](../../archived/architecture/2026-08-28-subprocess-native-containment.md) decided. `waitForExit()` observed that scope only by polling `systemctl --user show`, starting at 50 ms and doubling to at most 5 s. When a descendant outlived the direct child, the wait returned at the next poll tick, up to about 1 s after the last member exited, and each tick forked `systemctl`.

## Decision

`SystemdScopeOwner` in `packages/subprocess/subprocess-local/src/linux-scope.ts` keeps the systemctl poll as the authority and adds a wake-up from the kernel. The range query also asks for the scope's `ControlGroup`. Once the scope is established, `CgroupEventsWatch` (`src/cgroup-events.ts`) watches `<cgroup mount>/<ControlGroup>/cgroup.events` with a non-persistent `fs.watch`. The mount is the fixed unified-hierarchy path `/sys/fs/cgroup`.

An event is a wake-up, never the proof. The observer reads `cgroup.events` after each event:

- `populated 0` ends the wait. The kernel clears the flag when the last member exits, the same transition systemd uses to end a scope.
- `populated 1` keeps waiting with no query; the sleep restarts at the same interval without doubling it.
- A missing or unparsable file falls through to one `systemctl show`, which decides as before.

The poll stays armed beside the watch with today's intervals, so a missed or coalesced event costs no more than before. After attaching, one read closes the window between the last query and the watch: a flag already at `populated 0` sends the observer to `systemctl` instead of ending the wait, because an active scope with no members yet is not proof of an empty range.

Establishment, "unit absent", `signal()` early wake, termination (`systemctl stop` after `TasksCurrent 0` on a requested termination), and terminal-scope paths are unchanged. The watcher closes when the observation settles or fails, on `cleanup()`, and on `terminateForHostExit()`. An aborted caller does not cancel the shared observation, so the watcher lives until the range is empty.

A host without the unified hierarchy (cgroup v1 or hybrid, detected by a missing `cgroup.controllers`) and a scope collected before the watch starts use the poll silently. Any other fault, such as `EACCES`, inotify exhaustion, a watcher `error`, or an unparsable file, goes once per owner to `reportDegraded`; the runtime logs the first at `warn` and later ones at `debug`. The poll then observes alone.

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

**Replace the poll with the watch.** A dropped event, an `IN_Q_OVERFLOW`, or a watch attached after the transition would hang `waitForExit()`. The poll bounds the worst case at today's behavior.

**End the wait on `populated 0` after attaching.** A scope that is active but empty before its payload entered the cgroup would resolve early, and the existing `emptyRange` rule exists for that case. Only a transition seen as an event, or `systemctl`, ends the wait.

**Read `/proc/<pid>/cgroup` for the path.** The direct process can be gone by the time the watch starts. The scope's `ControlGroup` property rides on the query the observer already makes.

**Count tasks from `pids.current` in `inspectTaskCount`.** It would drop a blocking `spawnSync systemctl` per terminal sample, but `inspectTaskCount` returns a count only for an `active` unit, and a cgroup file read cannot tell a deactivating scope from an active one, so the result would differ. The blocking query stays.

## Consequences

`waitForExit()` no longer overshoots the last member's exit by a poll interval on cgroup v2 hosts, and an exiting range costs one `fs.watch` instead of repeated `systemctl` forks after the first. Hosts on cgroup v1 or hybrid behave exactly as before. The fixed `/sys/fs/cgroup` mount is a systemd convention; a different mount point takes the silent poll path. Tests inject the cgroup root, watcher, file reader and poll sleep, and `tests/native-containment.spec.ts` ends a real scope's wait through the kernel event with the poll timer disabled, so a regression hangs instead of passing late.
