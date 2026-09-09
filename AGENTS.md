# AGENTS.md — dsh-task-board

dsh Web GUI 的多列任务看板（UI 类插件）。任务可**真实执行**，不是假状态。
本仓库是该插件的**独立发布仓**（源码源自 dsh-web-ui monorepo 的
`packages/dsh-task-board`，本仓按独立包维护）。

## 构建与测试

```sh
pnpm install
pnpm run build      # tsc 产出类型 + tsdown -> lib/
pnpm run typecheck  # tsc --noEmit
pnpm test           # vitest run
```

- 浏览器 bundle 预设是 `build/tsdown.client.ts`（与 monorepo 的
  `shared/tsdown.client.ts` 同步），平台种子表是 `build/web-platform.ts`；
  升级 dsh SDK 时两者一起更新。
- `tsdown.config.ts` 的 `CLIENT_STORE_ENTRY` 解析顺序：
  `DSH_CLIENT_STORE_ENTRY` 环境变量 > 本仓
  `node_modules/@deepseek-ai/dsh-client-store/src/index.ts` > 其 `lib/index.js`。
- `lib/` 不入库，但 `dsh plugin add link:<dir>` 需要它——改完源码必须重新
  `pnpm run build`。
- 源码落区：宿主面进 `src/host-*.ts`（账本 / 服务 / runner / routes / power），
  两侧共享纯逻辑进 `src/core/`，UI 进 `src/client/`。

## 宿主权威与调度（不要回退成浏览器端）

- 任务账本持久化在宿主侧 `~/.dsh/task-board/ledger-v2.json`（原子
  tmp+rename+fsync 提交，单主锁 `ledger-v2.lock`，`scheduler-v2.json` 存调度
  簿记）；浏览器 `localStorage`（`dsh.taskBoard.v1`）只是宿主 RPC 不可用时的
  降级兜底，且该路径没有项目层。
- 定时调度在宿主侧：`src/host-service.ts` 每 30s tick（`SCHEDULE_TICK_MS`），
  到期 cron 经 `HostTaskLedger.openScheduled` 开执行；触发前先把「下次运行」滚到
  下一个匹配点，同 tick 不双发。**错过的触发点不补跑**（`skipMissed`）。
- 真实执行走宿主会话机制（`src/host-runner.ts`）：接入一个真实 session
  （blank-session 复用或 `session.create`）、重命名为任务标题、以
  `session.prompt` 发任务提示，再监视会话直到本轮 settle。**执行消耗 API
  额度**。

## 看板自动化（并发上限 + 定时巡逻 + settle 驱动续跑）

- 全看板并发上限 `maxConcurrency`（>= 1，默认 1，热调）：到顶时手动 run/rerun
  被硬拒（`concurrency-gate`）；到点的 cron 触发顺延而不丢弃。
- 定时巡逻 `patrolEnabled`（默认关）+ `patrolIntervalMs`（默认 30000，最小
  1000）：宿主侧定时器经 `HostTaskLedger.openPatrolRun` 把新任务派进空闲槽位。
- **settle 驱动自动续跑**（`dispatchContinue`，默认常开，与巡逻开关无关）：
  父任务 settle 后宿主立即把刚变成可执行的 todo **子任务**（`parentIds` 非空）
  派进空闲槽位（initiator `task-board-continue`）。独立新任务绝不因创建而开跑；
  失败的父任务不解阻子任务。
- 可执行判定 `checkExecutable`（`src/core/executability.ts`，返回有序 blocker
  列表）：未归档 → 状态在 `PATROL_STATUSES`（`['todo']`，待规划停放池绝不被拾起）
  → 自身无未结执行 → 全部父任务已结清 → 高于会话默认的权限已被确认（任何派发器
  都**绝不自动确认**）→ 看板有空闲槽位。每个派发器先轻滤，账本在 open 时刻复检
  全量判定。已启用 cron 的任务归调度器所有，巡逻与续跑排除。

## 数据模型

- 当前 `schemaVersion = 4`：v3→v4 新增 `projects: ProjectRecord[]` 与
  `defaultProjectId`（恒为 `"default"`）。解析 / 修复 / 迁移在 `src/core/store.ts`
  （两侧共享）。
- **项目是展示层分组**（二级），与任务同文件 / 同锁 / 同事务。编号 `#N` 是全局
  单调计数器 `nextSerial`，项目绝不触碰；删项目 = 把该项目名下卡片 `projectId`
  改指默认项目（`serial` 与执行史不动）。项目筛选不进 `checkExecutable` /
  巡逻 / 续跑门控。
- 任务可钉住执行目标（`workspaceId` / `mode` / `permission`，均可选）：应用不了
  的目标在发 prompt **之前**失败。
- 协议与动作在 `src/protocol.ts`（`exactKeys` 严格校验 + 64KB 上限 + 请求去重），
  账本动作在 `src/host-ledger.ts`，纯 use-case 在 `src/core/use-cases/`。

## 文档纪律

- 主 README 中英配对（`README.md` + `README.zh.md` + `README.i18n.yaml`）；
  改一侧必须同步另一侧并重录 `README.i18n.yaml` 的两个 blob 哈希。
- 截图放 `docs/screenshots/`，README 用相对路径引用。
- 禁止 emoji（代码、注释、文档、UI 文案、提交信息一致）。

## 提交前检查

```sh
pnpm run typecheck && pnpm test && pnpm run build
```
