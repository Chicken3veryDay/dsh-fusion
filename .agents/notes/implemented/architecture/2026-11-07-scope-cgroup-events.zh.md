# Agent Note: Event-driven Linux scope quiescence

Status: implemented

[English](2026-11-07-scope-cgroup-events.md) | 中文

## 问题

如[原生包含](../../archived/architecture/2026-08-28-subprocess-native-containment.md)所决定，Linux 句柄通过其临时 user-systemd scope 证明自己的范围为空。`waitForExit()` 过去只靠轮询 `systemctl --user show` 观察该 scope，间隔从 50 ms 开始翻倍，最多 5 s。当后代进程比直接子进程活得更久时，等待会在下一个轮询点返回，最多比最后一个成员退出晚约 1 s，而且每个轮询点都会 fork 一次 `systemctl`。

## 决策

`packages/subprocess/subprocess-local/src/linux-scope.ts` 中的 `SystemdScopeOwner` 仍以 systemctl 轮询为权威，并增加来自内核的唤醒。范围查询同时请求 scope 的 `ControlGroup`。scope 建立后，`CgroupEventsWatch`（`src/cgroup-events.ts`）用非持久的 `fs.watch` 监听 `<cgroup 挂载点>/<ControlGroup>/cgroup.events`。挂载点是固定的统一层级路径 `/sys/fs/cgroup`。

事件只是唤醒，从不是证明。每次事件之后，观察者都会读取 `cgroup.events`：

- 只有在已知 launcher 位于 scope 内（launch 请求已被消费即可证明）时，`populated 0` 才结束等待。最后一个成员退出时内核会清除该标志，这与 systemd 结束 scope 所用的转换相同。请求被消费之前，同样的读数并非最终结论：空的 cgroup 可能是 scope 的初始状态、仅 freezer 的变化（`frozen` 变化也会触发 `cgroup.events` 通知），或 systemd 在委派 scope 中 fork 的 setup helper 在 launcher 附加之前退出。这些情形与文件缺失一样交给 `systemctl`。
- `populated 1` 继续等待且不产生查询；睡眠以相同间隔重新开始，不再翻倍。
- 文件缺失或无法解析时，退回一次 `systemctl show`，由它照旧裁决。

轮询仍以现有间隔与监听并行，因此漏掉或合并的事件不会比以前花费更多。附加监听后会读取一次，以覆盖最近一次查询与监听之间的窗口：标志已为 `populated 0` 时，观察者转而询问 `systemctl`，而不是结束等待，因为尚无成员的 active scope 并不证明范围为空。

cgroup 唤醒从不确认 `signal()`：事件待处理时到来的信号仍会立即得到一次 `systemctl` 查询，事件则保留到下一次睡眠。终止（请求终止后 `TasksCurrent 0` 时执行 `systemctl stop`）以及终端 scope 路径不变。监听器在观察结束或失败时、`cleanup()` 时和 `terminateForHostExit()` 时关闭。因失败的观察而释放的监听器，可由重试的范围等待重新附加；静默或已降级的监听器保持原状。调用方中止不会取消共享观察，因此监听器会一直存在到范围为空。

建立规则已更正。已归档的决策把已加载的 `inactive` 或 `failed` unit 视为范围为空的证明。真实的 systemd 与此相反：`StartTransientUnit` 创建 scope 之后、启动任务运行之前，`systemctl show` 报告 `LoadState=loaded ActiveState=inactive TasksCurrent=[not set]`（systemd 259 上 12 次启动中有 5 次），随后 launcher 进入 scope 并运行目标。读到该状态的范围等待会提前结束、锁定 `stopped`，使目标脱离 `terminate()`、SIGKILL 升级、释放与主机退出的控制。现在，建立尚未确定时，已加载但未启动的 unit 与不存在的 unit 同样对待：launcher 仍在运行且请求未被消费时继续等待，launcher 在未消费请求的情况下退出时结束。unit 已启动（`inactive` 或 `failed` 之外的任何状态）或请求已被消费，则建立 scope，此后 `inactive` 或 `failed` 照旧证明范围为空。

没有统一层级的主机（cgroup v1 或 hybrid，以缺少 `cgroup.controllers` 判断）以及在监听开始前已被回收的 scope 静默使用轮询。其他故障，如 `EACCES`、inotify 耗尽、监听器 `error` 或无法解析的文件，每个 owner 只向 `reportDegraded` 报告一次；运行时把第一次记为 `warn`，之后记为 `debug`。此后由轮询单独观察。

从直接子进程退出到 `waitForExit()` 结束的延迟，每行 10 次运行的中位数，主机处于负载下，后代进程存活：

| 后代进程 | 仅轮询 | 加事件 |
|---|---|---|
| 0.05 s | 68 ms | 49 ms |
| 0.2 s | 390 ms | 199 ms |
| 0.4 s | 802 ms | 399 ms |
| 0.9 s | 1611 ms | 899 ms |
| 2.2 s | 3220 ms | 2199 ms |

启用事件后，等待会在最后一个成员退出后的几毫秒内结束；上表各行包含后代进程自身的剩余存活时间。

## 考虑过的替代方案

**D-Bus `PropertiesChanged` 订阅。** 它需要 D-Bus 客户端依赖，或每个 scope 一个长期运行的 `busctl`/`dbus-monitor` 子进程，而对单个文件的 inotify 监听不需要额外进程。

**把已加载的 `inactive` unit 保留为范围为空的证明。** 这是已归档的决策，对已运行并结束的 unit 成立。对启动任务仍在排队的 unit 不成立，而两者在 `LoadState`、`ActiveState` 与 `TasksCurrent` 上读数相同；只有被消费的请求和 launcher 的存活状态才能区分它们。

**用监听取代轮询。** 丢失事件、`IN_Q_OVERFLOW` 或在转换之后才附加的监听会使 `waitForExit()` 挂起。轮询把最坏情况限制在现有行为。

**附加监听后遇到 `populated 0` 就结束等待。** 在载荷进入 cgroup 之前就处于 active 但为空的 scope 会被提前判定，而现有的 `emptyRange` 规则正是为此而设。只有以事件观察到的转换或 `systemctl` 才能结束等待。

**读取 `/proc/<pid>/cgroup` 获取路径。** 开始监听时直接进程可能已经消失。scope 的 `ControlGroup` 属性随观察者本来就要发出的查询一并返回。

**在 `inspectTaskCount` 中改用 `pids.current` 计数。** 这样可以去掉每次终端采样的阻塞 `spawnSync systemctl`，但 `inspectTaskCount` 仅对 `active` unit 返回计数，而读取 cgroup 文件无法区分正在停用的 scope 与 active scope，结果会不同。阻塞查询保持不变。

## 后果

在 cgroup v2 主机上，`waitForExit()` 不再比最后一个成员的退出晚一个轮询间隔；首次查询之后，退出中的范围只需一次 `fs.watch`，不再反复 fork `systemctl`。cgroup v1 或 hybrid 主机的行为与以前完全相同。固定的 `/sys/fs/cgroup` 挂载点是 systemd 的约定；使用其他挂载点时会静默走轮询路径。测试会注入 cgroup 根目录、监听器、文件读取器和轮询睡眠，`tests/native-containment.spec.ts` 则在禁用轮询计时器的情况下，通过内核事件结束真实 scope 的等待，因此回归会表现为挂起而不是迟到通过。
