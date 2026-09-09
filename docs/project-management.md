# 任务看板「项目管理」— 整体规划与 UI 设计（v1 初稿）

> 状态：已评审通过并实现（0.4.0）；本稿为规划留档，实现差异以源码为准
> （色板 token 存全名 `--dsh-tb-project-cN`、项目名上限 200 字符、无 `builtin` 标记，
> 以默认项目固定 id `default` 判定）。对应需求：新建项目、删除项目、项目下任务卡操作、
> 默认项目兜底、仪表盘按项目统计、任务卡编号逻辑不变（全局同一套编号，不按项目走）。

## 1. 目标与范围

在现有「多列看板 + Host 权威账本」之上增加**项目**维度：

- 项目的新建 / 改名 / 换色 / 删除（默认项目不可删）；
- 每张任务卡归属一个项目；未明确归属的卡全部落入**默认项目**；
- 看板可按项目筛选（"项目下进行任务卡操作"= 在选中项目上下文内完成建卡/移动/执行/打回/归档）；
- 仪表盘统计按项目出数（每项目一行：卡片数、状态分布、今日执行成败、成功率）；
- **编号逻辑完全不变**：`#N` 仍是全局单调、删除不复用的串行编号，与项目正交。

**不在本期范围**（明确不做，避免范围蔓延）：

- 项目级并发上限 / 项目级巡逻（派发门控保持全看板一套，见第 7 节）；
- 项目模板（预置执行目标三元组、预设 cron 模板等）；
- 项目归档、项目排序拖拽、多账本。

## 2. 关键设计决策（速览）

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 项目存哪里 | Host 权威账本 `ledger-v2.json` 升 **v4**（与任务同文件、同锁、同原子提交） | 与任务同事务：删项目→挪卡 必须一次提交完成，绝不留孤儿 |
| 默认项目 | 账本级 `defaultProjectId = "default"`（固定字符串 id，非 uuid） | 稳定 id 保证迁移与旧数据回填确定性；名字可改、不可删 |
| 删项目语义 | 该项目下所有卡**移入默认项目**（编号不变、执行史不动），卡永不悬空 | 用户口径「所有卡都应归入某项目」= 不变式，删项目不能产生无主卡 |
| 卡片归属字段 | `TaskRecord.projectId?: string`（可选字段，加载时规范化兜底默认项目） | 旧 v3 账本零改动加载，迁移一次性回填 |
| 编号 | `nextSerial` 保持账本级全局计数器，**不随项目拆分** | 用户明确要求；且 `#N` 是 agent 指卡引用协议（卡片/详情/依赖列表/cron 播报共用） |
| 项目筛选 | 纯**展示维度**：筛选器 + 新建卡默认值，不进入可执行判定 / 巡逻 / 续跑门控 | 派发门控（`checkExecutable`）保持一套全看板语义，行为可预测 |
| 跨项目父子依赖 | 允许（`parentIds` 是全局任务 id，门控逻辑零改动） | 项目是管理视角，不是隔离域；详情里展示父卡项目徽标即可 |
| Host RPC 不可用（v1 localStorage 兜底） | 项目 UI 置灰禁用（项目只存在于 Host 账本） | 兜底路径不引入第二套项目存储 |

## 3. 数据模型

### 3.1 新增 `ProjectRecord`（`src/core/projects.ts`，新文件，纯逻辑区）

```ts
export const DEFAULT_PROJECT_ID = 'default'

/** 8 色固定色板（token 名，非自由色值；CSS 侧映射到主题变量）。 */
export const PROJECT_COLORS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'] as const
export type ProjectColor = typeof PROJECT_COLORS[number]

export interface ProjectRecord {
  /** 稳定 id：默认项目恒为 "default"；用户项目为 uuid。 */
  id: string
  /** 显示名（trim 后 1-32 字符，全账本大小写不敏感唯一）。 */
  name: string
  /** 色板 token；缺省 = 创建时按序自动取色。 */
  color?: ProjectColor
  /** 仅默认项目为 true。 */
  builtin?: boolean
  createdAt: number
  updatedAt: number
}
```

### 3.2 账本文档 v3 → v4（`src/protocol.ts` + `src/host-ledger.ts`）

```ts
// v4 文档（新增两处，其余字段与 v3 相同）
interface LedgerDocument {
  schemaVersion: 4            // 3 -> 4
  revision: number
  projects: ProjectRecord[]   // 新增：至少含默认项目
  defaultProjectId: string    // 新增：恒为 "default"
  tasks: TaskRecord[]
  scheduler: PersistedScheduler
  recentRequests: PersistedRequest[]
  nextSerial: number          // 语义不变：全局串行计数器
}
```

`TaskRecord` 增加一个可选字段（`src/core/tasks.ts`）：

```ts
export interface TaskRecord {
  // ...现有字段全部不变（serial 等）...
  /** 所属项目 id；旧数据缺省，加载时回填 defaultProjectId。 */
  projectId?: string
}

export interface NewTaskInput {
  // ...现有字段不变...
  /** 目标项目；缺省 = 默认项目。 */
  projectId?: string
}
```

`TaskUpdatePatch`（`core/use-cases/task-update.ts`）增加 `projectId?: string`。

### 3.3 迁移与规范化（`src/core/store.ts` + `host-ledger.ts` 加载分支）

- **v3 → v4 一次性迁移**（启动时）：`projects = [defaultProject("默认项目")]`，
  `defaultProjectId = "default"`，全部任务 `projectId = "default"`；`nextSerial` 原样保留
  （`assignMissingSerials` 逻辑不动，编号回填顺序与规则不变）。
- **加载规范化（每次）**：
  - `task.projectId` 缺失或指向不存在项目（防御性，正常路径不会发生）→ 重写为 `defaultProjectId`；
  - `projects` 缺默认项目（毒数据）→ 重新注入；
  - 非法 `color` 值 → 丢弃字段（保留卡/项目本身，不丢行——与 `schedule` 修复策略同口径）。
- **旧版 Host + 新版客户端兼容**：`TaskBoardSnapshot.projects` / `defaultProjectId` 缺省时，
  客户端整体隐藏项目 UI（与 `nextSerial` 缺省不显示编号徽标同模式，已有先例）。

### 3.4 编号策略（不变式，测试锚点）

1. `nextSerial` 是**账本级**单一计数器；项目增删、卡挪项目均**不触碰**该计数器；
2. 删项目 = 改卡的 `projectId` + `updatedAt`，不重建卡，`serial` 原样保留；
3. 删卡仍由现有逻辑保证编号不复用（`nextSerial` 只进不退）；
4. 测试锚点：v3 迁移后、任意项目操作后，`#N` 与创建时一一对应。

## 4. 协议与 Host API（`src/protocol.ts` + `src/host-ledger.ts`）

### 4.1 新增 action（沿用现有 `exactKeys` 严格校验 + 64KB 门 + 请求去重）

```ts
export type TaskBoardAction =
  // ...现有 12 个 kind 不变...
  | { kind: 'project-create';  name: string; color?: string }
  | { kind: 'project-rename';  projectId: string; name: string }
  | { kind: 'project-color';   projectId: string; color?: string }
  | { kind: 'project-delete';  projectId: string }
```

- `create` 的 `input` 增加可选 `projectId`（协议门校验：必须是账本内现有项目 id）；
- `update` 的 `patch` 增加可选 `projectId`（同校验；挪项目与现有内容 patch 同事务、
  同 revision、同原子提交）。

### 4.2 Host 侧规则（`apply` 分支 + 纯函数落在 `core/use-cases/`）

| 动作 | 规则 |
| --- | --- |
| `project-create` | name trim 非空、1-32 字符、大小写不敏感唯一，否则拒（协议错误回客户端 toast）；color 必须在 8 色板内，缺省按已用色板轮转取色；mints uuid |
| `project-rename` | 规则同 create 的 name 校验（与**其他**项目名撞名拒）；默认项目**可以**改名（id 不变） |
| `project-color` | 8 色板内合法值或缺省（清除自定义色）；不校验撞色（允许同色） |
| `project-delete` | `projectId === defaultProjectId` → 拒（`project-default` 错误）；否则该项目全部卡 `projectId` 重写为 `defaultProjectId`（bump 各卡 `updatedAt`），卡内其余字段（含 `serial`、`executions`）不动 |
| 卡挪项目（`update`/`create` 的 `projectId`） | 目标项目必须存在；挪动不改编号、不改执行史、不改依赖门控 |

### 4.3 Snapshot / SSE（`TaskBoardSnapshot` 扩展）

```ts
export interface TaskBoardSnapshot {
  schemaVersion: 4
  revision: number
  projects: ProjectRecord[]       // 新增（旧 Host 缺省 = 客户端隐藏项目 UI）
  defaultProjectId: string        // 新增
  tasks: TaskRecord[]             // 卡带 projectId
  nextSerial?: number             // 不变
  // scheduler / power / automation / sessionDefaultPermission 均不变
}
```

项目动作同样 bump `revision`，SSE 事件帧结构不变（客户端收到 revision 变化后拉
`/state` 全量快照，与任务动作完全同路径——**不新增任何路由**）。

## 5. UI 设计

### 5.1 总体布局（看板页 wireframe）

看板替换中列的现有布局：`[工具行] + [列区(5 列 + 仪表盘列)]`。项目切换器进工具行，
不新增侧栏（桌面中列宽度有限，左栏会让 5 列 + 仪表盘列过挤；窄屏/移动端天然退化为下拉，
零额外成本）：

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 任务看板  [项目: 全部项目 ▾] [筛选任务(#编号)…]  巡逻·并发chip  归档  +新建  × │
├── 项目切换器展开态 ─────────────────────────────────────────────────────────┤
│  ◉ 全部项目            (23)   ← 虚拟项，不可删                              │
│  ● 默认项目            (12)   [锁]  ← 默认项目徽标，不可删、可改名          │
│  ● dsh 插件维护        (6)    hover: [改名] [删除]                          │
│  ● 电影素材管线        (5)    hover: [改名] [删除]                          │
│  ────────────────────                                                      │
│  + 新建项目…                                                       管理项目 │
└────────────────────────────────────────────────────────────────────────────┘
┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
│ 待规划 (3)    │ 待办 (4)      │ 进行中 (1)    │ 已完成 (8)    │ 仪表盘      │
│ ┌──────────┐  │ ┌──────────┐  │ ┌──────────┐  │             │ ┌──────────┐ │
│ │#42        │  │ │#45       │  │ │#41       │  │             │ │ 今日 ▸ 总计│ │
│ │ 写周报     │  │ │ 出分镜    │  │ │ 跑验收    │  │             │ │ [项目:全部▾]│ │
│ │ ●插件维护  │  │ │ ●电影管线 │  │ │ ●默认项目  │  │             │ │ 12 卡 · 3成功/1失败│ │
│ └──────────┘  │ └──────────┘  │ └──────────┘  │             │ ├──────────┤ │
└──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
```

规则：

- **筛选态**：选中项目 P 后，5 列只渲染 P 的卡（列计数同步变 P 内计数）；
  再次点 P 或点「全部项目」还原。筛选是展示层，**不改变任何门控语义**；
- 新建卡弹窗默认项目 = 当前筛选项目；筛选「全部」时默认 = 默认项目；
- 归档视图同样受项目筛选（归档列内的卡也带项目徽标）。

### 5.2 项目切换器（新组件 `ProjectSwitcher.tsx`）

- 位置：工具行，标题右侧、搜索框左侧；默认收起为 `[● 项目名 | 计数 ▾]` 单 chip；
- 展开：下拉面板（点击外/ESC 收起，同 `NewTaskModal` 的 backdrop 交互口径）；
- 行结构：`色点 + 名称 + 右对齐计数`；hover 出「改名 / 删除」两个文字按钮
  （默认项目与「全部项目」行不出删除）；
- 底部固定「+ 新建项目…」与「管理项目」两个入口（管理项目 = 打开 5.3 的管理弹窗，
  改名/换色在那里做；下拉里的改名走同一条 `project-rename` 动作，输入框就地变）；
- Host 不可用（v1 兜底模式）：整个切换器置灰 + tooltip「Host 不可用，项目功能离线」。

### 5.3 项目管理弹窗（新组件 `ProjectManagerModal.tsx`）

```
┌─ 项目管理 ─────────────────────────────────────────────┐
│ ● 默认项目（默认）  12 卡        [改名____] [删除(禁用)] │  ← 锁定行，置顶
│ ● dsh 插件维护     6 卡  色板◉◉◉○…  [删除]            │
│ ● 电影素材管线     5 卡  色板◉◉◉○…  [删除]            │
│ [+ 新建项目]  名称输入 [____] 色板(自动) [创建]        │
└────────────────────────────────────────────────────────┘
```

- 删除确认（`ConfirmDialog` 复用）：
  「删除项目「X」？其下 N 张任务卡将移入默认项目「Y」。卡片编号与执行记录不变。」
  N=0 时文案简化为「项目下没有任务卡」。
- 改名默认项目 = 改显示名，确认文案提示「编号 #N 引用不受影响」。

### 5.4 新建 / 编辑任务弹窗（`NewTaskModal` / `EditTaskModal`）

- `TaskContentFields` 三字段下方新增一行「项目」下拉（`select`，全项目列表，
  默认项目行标注「（默认）」）；
- 新建：默认值 = 看板当前筛选项目，否则默认项目（见 5.1）；
- 编辑：默认值 = 该卡现归属；改这里 = 挪卡（提交即 `update { projectId }`）；
- 该下拉同时服务「复制为新任务 / 修改并新建副本」路径（副本默认**继承原卡项目**）。

### 5.5 卡片与详情

- **卡片**（`TaskCard.tsx`）：meta 行追加项目徽标 `● 项目名`（色点用项目色，
  名称截断 8 字 + title 全文；默认项目也显示——归属可见性是需求本身）。
  编号徽标 `#N` 位置、样式、定位逻辑（`matchesFilter` 的 `#N` 精确定位）**全部不动**；
- **详情**（`TaskDetail.tsx`）：元信息区加「所属项目：● X」+ 就地换项目下拉
  （与编辑弹窗同一动作，避免两处交互分叉）；父任务列表里每项带父卡项目徽标
  （跨项目依赖可见性）；
- **打回/执行/归档/恢复** 等既有操作零改动（它们作用在卡上，与项目正交）。

### 5.6 仪表盘按项目统计（`Dashboard.tsx` + `core/dashboard.ts`）

现有「今日/总计」维度与新增「项目」维度**正交**（今日 × 全部项目、今日 × 单项目
四种组合都成立）：

```
┌─ 仪表盘 ───────────────────────────────────────────────┐
│ [今日] [总计]      项目: [全部 ▾]  ← 新增项目维度选择   │
│ 概览（当前范围内）                                       │
│  12 卡 · 成功 5 · 失败 1 · 取消 0 · 成功率 83%          │
│ ─ 按项目统计（仅「全部」模式显示）────────────────────  │
│  项目            卡片  进行中  已完成  今日✓/✗  成功率  │
│  默认项目         12     1      7     3/1    75%        │
│  dsh 插件维护      6     0      2     1/0   100%       │
│  电影素材管线      5     1      2     1/0   100%       │
│ ─ 下次定时（当前范围，Top 3）/ 失败任务（当前范围，Top 5）│
└──────────────────────────────────────────────────────────┘
```

- 纯函数：`summarizeByProject(tasks, startMs?) → { projectId, summary: DashboardSummary }[]`
  （复用 `summarizeBoard` / `summarizeToday` 口径：今日按创建时间切、执行按结算时间切、
  受 `EXECUTION_HISTORY_LIMIT` 截断，与全量视图完全同口径）；
- 单项目模式隐藏统计表，概览 tile 直接显示该项目的数；
- 「全部」模式下统计表行可点 → 直接切到该项目的看板筛选（统计→钻取闭环）。

### 5.7 样式与 i18n

- `board.module.css` 新增：`.projectChip .projectDot .projectRow .projectRowHoverAction
  .projectModal .projectTable` 等；色板 8 色映射到 CSS 变量
  `--dsh-tb-project-c1..c8`（亮/暗两套，取色走现有主题 token 习惯，不用 emoji）；
- `locales.ts` 新增键（zh 为 key 源，en 全量对照，沿用现有分组）：

```text
proj.title 项目 / proj.all 全部项目 / proj.defaultTag (默认) / proj.locked 默认项目不可删除
proj.new 新建项目 / proj.manage 项目管理 / proj.deleteConfirm 删除项目「{name}」？其下 {count} 张卡将移入默认项目「{defaultName}」。编号与执行记录不变。
proj.deleteEmptyConfirm 项目「{name}」下没有任务卡，确定删除？
proj.rename 改名 / proj.namePlaceholder 项目名（1-32 字符）/ proj.nameRequired 项目名不能为空
proj.nameTaken 已存在同名项目 / proj.nameTooLong 项目名过长（上限 {max} 字符）
proj.cards {count} 张卡 / proj.noneByProject 该项目下暂无任务
new.project 项目 / detail.project 所属项目 / detail.projectMove 换项目
dash.byProject 按项目统计 / dash.projectCards 卡片 / dash.projectDone 已完成 / dash.projectSuccessRate 成功率
dash.projectScopeHint 统计范围：{name}
board.projectUnavailable Host 不可用，项目功能离线
card.project ● {name}
```

## 6. 控制器与状态（`src/core/controller.ts`）

- 视图状态新增 `selectedProjectId: string | undefined`（undefined = 全部；内存态，
  与 `filter` 字符串同等生命周期，不持久化）；
- 动作方法：`createProject(name, color?)` / `renameProject` / `setProjectColor` /
  `deleteProject(id)`（内部走 `transport.action`，失败回 `hostError` toast，
  与现有任务动作同错误面）；`createTask` 入参带上 `projectId`；
- 快照合并：`projects` 从缺省快照回填（旧 Host 降级隐藏 UI）；
  当前 `selectedProjectId` 指向被删项目 → 归位「全部」（与「选中任务被删」同处理口径）；
- 纯函数区新增：`core/use-cases/project-create.ts` / `project-rename.ts` /
  `project-delete.ts`（各含纯 ledger 转移 + 结果对象，单测直接驱动，沿用现有
  use-case 纪律：纯函数不碰持久化与 notify）。

## 7. 行为语义边界（防误解清单）

1. **派发门控不变**：`checkExecutable`（巡逻/续跑/定时/手动共用）继续以全看板口径判定
   ——并发上限、巡逻、settle 续跑都不按项目拆分。项目只是管理与统计视角；
   若未来要项目级并发，是独立需求，届时再改门控。
2. **跨项目父子依赖允许**：子卡可以在 A 项目、父卡在 B 项目；门控只看父卡
   `status === 'done'`，不看项目。详情页展示父卡项目徽标提供上下文。
3. **执行目标（工作区/预设/权限/模型）与项目无关**：项目不携带执行三元组（本期不做模板）。
4. **agent 播报**（`announceToAgent`）本期文案不加项目维度；项目名进入 prompt 是 v2 候选。
5. **删除项目 ≠ 删除任务**：确认文案必须显式「移入默认项目、编号不变」，防用户误判为删卡。
6. **单主锁不变**：项目与任务同账本同锁（`ledger-v2.lock`），预演实例拒启行为不变。

## 8. 实施计划

### 阶段 1：Core + Host（纯逻辑，全单测可覆盖）

| 文件 | 改动 |
| --- | --- |
| `src/core/projects.ts`（新） | `ProjectRecord` / 色板 / `defaultProject()` / 纯校验（name/color 门） |
| `src/core/use-cases/project-create.ts` 等三个（新） | 纯 ledger 转移：建项目 / 改名 / 删项目（含挪卡回填默认项目） |
| `src/core/tasks.ts` | `TaskRecord.projectId?`、`NewTaskInput.projectId?` |
| `src/core/use-cases/task-create.ts` `task-update.ts` | 带上 `projectId`（update patch 增加字段 + `hasContentPatch` 识别） |
| `src/core/store.ts` | v4 行校验：`projectId` 形状检查 + 规范化回填；`projects` 缺默认项目修复 |
| `src/core/dashboard.ts` | `summarizeByProject`（复用现有口径） |
| `src/protocol.ts` | `schemaVersion=4`；4 个新 action kind + `exactKeys` 门 + `projectId` 入参校验 |
| `src/host-ledger.ts` | v4 文档形态；v3→v4 迁移（一次性）；`apply` 四个 project 分支；挪卡事务 |
| `src/host-service.ts` | snapshot 注入 `projects` / `defaultProjectId` |
| `tests/`（新 3 文件 + 补强） | project 三个 use-case；v3→v4 迁移（含编号不动锚点）；ledger project 动作；`summarizeByProject` 口径；旧 Host 快照缺省回填 |

### 阶段 2：Client UI

| 文件 | 改动 |
| --- | --- |
| `src/client/board/ProjectSwitcher.tsx`（新） | 5.2 切换器 |
| `src/client/board/ProjectManagerModal.tsx`（新） | 5.3 管理弹窗（新建/改名/换色/删除确认） |
| `src/client/board/TaskBoard.tsx` | 工具行接切换器；列/归档渲染加 `projectId` 过滤；新建卡默认项目 |
| `src/client/board/TaskCard.tsx` | meta 行项目徽标 |
| `src/client/board/TaskDetail.tsx` | 所属项目行 + 就地换项目 + 父卡项目徽标 |
| `src/client/board/NewTaskModal.tsx` `EditTaskModal.tsx` | 项目下拉（`TaskForm` 增加字段行） |
| `src/client/board/Dashboard.tsx` | 项目维度选择 + `summarizeByProject` 统计表 + 行点击钻取 |
| `src/core/controller.ts` | `selectedProjectId` + 4 个项目动作方法 + 快照回填/失效归位 |
| `src/client/locales.ts` | 5.7 键，zh/en 双字典 |
| `src/client/board.module.css` | 新类 + 8 色 CSS 变量（亮/暗） |

### 阶段 3：文档 / 验收 / 发布

- `README.md` / `README.zh.md` / `README.i18n.yaml` 三件套同步（双语纪律 + `docs:write-pair`）；
- 包级 `AGENTS.md` 数据模型节补项目账本（`ledger-v2.json` v4 形态）；
- e2e 截图进 `packages/dsh-task-board/docs/e2e/`（切换器、管理弹窗、项目仪表盘、删项目挪卡后编号不变）；
- 门禁：`pnpm typecheck && pnpm test && pnpm docs:check`（本包 node_modules 全手工
  junction，**禁止 pnpm install**，构建/测试直接调 node 跑 tsc/tsdown/vitest）。

### 顺序与回滚

1. 阶段 1 先行合入（schemaVersion=4 一次性迁移，旧账本自动升级；回滚 = 旧代码读 v4
   账本时 `projects` 未知字段被 `parseLedger` 忽略，任务数据无损——需为旧加载分支
   加一个「v4 未知字段容忍」的兼容测试）；
2. 阶段 2 UI 全量（切换器/弹窗/卡片/详情/仪表盘同 PR，避免半成品态）；
3. 版本号：`dsh-task-board` 0.3.18 → 0.4.0（feat 语义，tag 发布走既有纪律）。

## 9. 风险与开放问题（评审拍板项）

| # | 问题 | 本稿取法 | 备选 |
| --- | --- | --- | --- |
| Q1 | 项目切换器放工具行下拉，还是左侧竖栏？ | **工具行下拉**（中列宽度预算；窄屏零成本退化） | 左侧 200px 竖栏（桌面更"项目管理"感，但挤 5 列+仪表盘） |
| Q2 | 默认项目允许改名吗？ | 允许（显示名而已，id 固定） | 锁死（更防误操作，代价小） |
| Q3 | 项目色：自动轮转 8 色板，还是用户必选？ | **自动 + 管理弹窗可手挑** | 纯自动（少一处交互） |
| Q4 | 跨项目父子依赖？ | 允许（管理视角，不隔离） | 限同项目（更严格，门控需加判定） |
| Q5 | 项目级并发/巡逻？ | 明确不做（全看板一套门控） | 做 = 独立需求 + 门控改动，v2 |
| Q6 | agent 播报带项目名？ | 不做，v2 候选 | 开 = prompt 体积 +1 行 |
