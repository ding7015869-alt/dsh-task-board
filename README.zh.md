# dsh-task-board — DSH web GUI 任务看板插件

[English](README.md) | 中文

一个可热插拔的 DeepSeek Harness (DSH) 客户端 GUI 插件：在侧边栏「新会话」下方增加 **任务看板**入口，点击后中间列整体切换为多列看板视图；任务以 DSH 自身的会话机制 **真实执行**（`session.prompt`），执行状态实时回写卡片。

- 不修改 DSH 源码：以 cordis 插件 + 浏览器 DOM 扩展挂载（外挂形态与 `dsh-web-ui/packages/skins/skin-center` 一致）。
- 卸载即恢复原状，其它 managed 段（dsh-skin / skin-center / 个人配置）互不干扰。
- 任务数据本地持久化，刷新页面、重启 DSH 均不丢失。

- 任务数据的权威来源是**宿主侧账本**（不是浏览器标签页）：关掉浏览器后，定时调度、巡逻派发与状态回写照常进行。

## 截图

**多列看板 + 实时仪表盘**——待规划 / 待办 / 进行中 / 已完成四列，外加「已失败」槽位的仪表盘面板。每张卡片带全局 `#N` 编号、项目徽标、定时标识与执行次数；头部实时显示巡逻状态与「在跑执行数 / 并发上限」。

![多列任务看板与仪表盘面板](docs/screenshots/01-board.png)

**新建任务**——标题、描述与执行 Prompt，以及定时、依赖、项目与执行目标（工作区 / 模式 / 权限）三类钉子。

![新建任务对话框](docs/screenshots/02-new-task.png)

**新建任务（下半部）**——cron 定时与常用预设、父子任务多选、所属项目选择，以及工作区 / 模式 / 权限钉子。

![新建任务对话框下半部](docs/screenshots/02b-new-task-lower.png)

**任务详情**——内容与 Prompt、带真实结果与时间的执行记录、执行 / 重新执行、查看会话、带确认的删除，以及手动换列。

![任务详情](docs/screenshots/03-detail.png)

**设置卡**——DSH 原生设置卡中的任务看板卡：启用开关、向 agent 播报、空闲睡眠保护、并发上限、巡逻开关与巡逻间隔，全部即时生效。

![任务看板设置卡](docs/screenshots/04-settings.png)

**归档视图**——已完成 / 已失败卡片可归档移出看板，随时恢复，执行记录与会话 transcript 全程可追溯。

![归档视图](docs/screenshots/05-archive.png)

## 功能

- **侧边栏入口**：侧边栏列（旧版 `[data-pane="sidebar"]`，DSH 0.1.0-rc.6 AppFrame 布局为 `[class*="sidebarCol"]`）内、新会话按钮下方注入「任务看板」入口行（宽栏显示图标+文字，折叠 rail 显示纯图标，随 DSH 皮肤 token 自适应）。
- **会话行菜单入口**：会话列表里每个会话行的「…」菜单（三个点按钮）注入**「添加为任务卡」**项，**仅当该会话未被未归档任务卡占用**时显示（`taskClaimedSessionIds`：任务的最近一次执行会话、全部保留的执行会话、冻结快照的来源会话——已归档任务释放其会话，项随之重新出现）。点击经模块级请求总线（`new-task-request.ts`）发出新建任务请求，以**会话标题预填标题**打开「新建任务」对话框（只预填标题，描述 / Prompt / 钉住项留空）。对话框渲染在 **body 级独立 React 根**（`session-new-task-overlay.tsx`）——点击侧边栏行会把中间列还给会话视图，看板面板里的对话框副本会不可见。注入行是纯 DOM，由与侧边栏入口同款的自修复 MutationObserver 维护；会话身份从行 React fiber 读取（shell 把会话 id 留在 React state 而非 DOM 属性上），读不到 fiber 的行直接跳过、绝不猜测。observer 重扫对稳定行严格 no-op——重写未变化的标签会记录新的 mutation 并喂给自己的回调（该行只在标签值真正变化时才触碰 DOM）。
- **多列看板**：四个卡片列——待规划 / 待办 / 进行中 / 已完成——外加「已失败」槽位的**仪表盘**面板；卡片显示标题、描述、状态、更新时间、执行次数；顶部支持搜索过滤、归档视图（已完成/已失败任务可归档，归档后移出看板，可随时恢复，执行记录与会话 transcript 保留可追溯）、新建任务、返回会话。待规划是停放列：新任务默认进「待办」，卡片可拖拽或手动「移到待规划/待办/已完成」停放到这里——它是看板的闲置池，不是描述/上下文展示区。
- **仪表盘面板（已失败槽位）**：第五个网格槽位不再是卡片列，而是一块实时概览：各状态数量磁贴、已结算执行统计（成功/失败/取消 + 成功率）、至多 3 条已启用的下次定时（附下次运行时间）、失败任务列表（至多 5 条，按最近活动排序，显示错误摘要 + 相对时间）。概览带一个**今日/总计维度切换**（默认今日）——今日从宿主机本地 0 点起切片（磁贴统计 0 点后创建的任务，执行统计 0 点后结算的执行；未结算执行不计入），总计为累计口径；概览下方的「下次定时」「失败任务」两节不受影响。每条失败行保留两个快捷操作——「重新执行」（经宿主 rerun）与「移入待办」（重新排队）；整行点击打开任务详情；头部胶囊显示失败数量。失败任务在其它入口（详情、手动移动、归档）依然可达。
- **卡片会话按钮**：每张卡片右上角有放大镜按钮，直接跳到该任务最近一次执行的会话（任务卡片的上下文详情）；还没有会话可跳时，回退为打开任务详情。
- **任务详情**：点卡片主体打开详情（标题/描述/执行 Prompt/执行记录），**不会**一点就执行；详情内提供「执行 / 重新执行」「删除（带确认）」「查看会话（跳转到执行 transcript）」以及手动移到待规划/待办/已完成。
- **真实执行**：点「执行」后，插件通过客户端 runtime 连接工作区会话（`workspaces.connectWorkspace`，空白会话复用或 host 新建），把任务标题设为会话名，以任务 Prompt 调用 `session.prompt([{ type: 'text', text }], 'queue')` 驱动真实 agent；随后订阅该会话快照，轮次真实结束后把卡片置为 已完成/已失败 并记录执行结果。执行会话会出现在会话列表，可点进对话查看真实 transcript。
- **任务级执行目标**：任务可钉住「在哪跑、怎么跑」——**工作区**（执行会话落在指定工作区）、**模式**（会话以指定 agent 预设组合，趁会话仍为空白时走 `agentPresets.select` 切换）、**权限**（经 `/permission <id>` 斜杠命令应用的沙箱预设：read-only / workspace-write / danger-full-access）。留空即回退运行时默认（最近工作区 / 部署预设 / 会话默认）。钉不住的目标会在发 Prompt **之前**失败，任务绝不会悄悄按没要求过的设置运行。
- **状态回写**：卡片状态（进行中 → 完成/失败）由真实会话状态驱动；刷新页面/重启后，遗留的 running 任务会按会话现状自动对账（reconcile）。
- **定时任务**：新建任务与详情面板均可配置定时执行——启用开关 + 5 段 cron 表达式（分 时 日 月 周，支持 `*` / `*/n` / `a-b` / 逗号列表）+ 常用预设（每天 09:00、每小时、每 10 分钟、每周一 09:00）；启用即计算并持久化「下次运行时间」，卡片显示定时标识；到点自动走真实执行链路（同手动执行），执行会话照常可跳转。
- **依赖门控（多父节点 / 多子节点）**：任务可声明任意多个**父任务**（`parentIds`；子任务由反向依赖边派生，不落库）。任务要「开启」必须其**现存**父任务全部 已完成（done）——否则卡片挂「等待 N 个父任务」徽标，「执行 / 重新执行」保持禁用。门控由宿主侧强制：手动 run/rerun 被拒时报 `dependency-gate` 错误（列出未结清父任务）；到点的定时触发被跳过并在下一个 tick 重试，直到父任务结清（门控期间「下次运行时间」不顺延，父任务 done 后自动补发）。父任务在新建任务对话框与详情面板中设置（父任务多选 + 派生子任务多选，反向边原子改写；清空即移除全部边）。删除父任务会在同一事务里剥掉子任务中的悬空 id——被删父任务绝不阻塞（fail-open）。
- **项目管理（项目分组）**：任务卡可归入**项目**管理，经顶部工具栏管理——项目切换器（按单个项目或「全部项目」筛选看板）与项目管理器（新建 / 改名 / 换色 / 删除，8 色调色板自动分配给新项目）。存在一个固定的**默认项目**（id 恒为 `default`，可改名、不可删除），所有未明确归属的任务卡都归它所有；删除项目时只有该项目名下的卡被**移入默认项目**——卡片编号（`#N`，全局同一套序列）与执行历史绝不被触碰。每张卡片以小徽标显示所属项目；新建任务对话框可选所属项目（复制任务继承源卡的项目），详情面板有「所属项目」下拉可直接改派。仪表盘新增**按项目统计**（每个项目一行：在板卡片数 / 归档数 / 已结算执行成功率，仅「全部项目」口径下显示；点击行即把看板钻取进该项目）与项目筛选下拉（位于今日/总计切换旁）。项目分组是**纯展示维度**：不进入派发门控（巡逻 / 并发上限 / 依赖判定）、编号生成与执行链路，且持久化在宿主账本（schema v4），关浏览器后项目照常生效。
- **设置卡**：host 半边注册 `task-board` 设置命名空间，DSH 自带的设置界面因此渲染一张原生**任务看板卡**，含六个实时字段——`enabled`（插件总开关，同时控制浏览器半边与宿主播报，默认开）、`announceToAgent`（是否注入 `plugin:task-board` 系统提示词段，默认关）、`preventIdleSleep`（会话运行或定时已启用时的空闲系统睡眠保护，默认关——不承诺拦截合盖、手动睡眠、休眠或关机）、`maxConcurrency`（全看板并发上限，整数 ≥ 1，默认 1）、`patrolEnabled`（定时巡逻，默认关）与 `patrolIntervalMs`（巡逻扫描间隔，整数 ≥ 1000 ms，默认 30000）。卡片把编辑暂存后以**一次原子、带 revision 栅栏的写入**提交；设置改动**无需重启 DSH** 即生效（播报段在值变化时重新注册），被拒的草稿会把宿主返回的原因显示出来，绝不静默丢弃。
- **系统提示词注入**：host 半边（`src/index.ts`）通过 `SystemPrompt.section` 注册 `plugin:task-board` 段（order 200），向每个 agent 声明本插件存在、能力与限制——插件在组合中**且** `announceToAgent` 开启时（默认关；在设置卡里切换，无需重启）注入，插件移出组合即消失，agent 无需任何外部文档就能知道如何与本看板协作。
- **看板自动化（并发上限 + 定时巡逻）**：全看板「同时最多几个任务在执行」的上限（设置项 `maxConcurrency`，默认 1，可热调）——到顶时手动「执行 / 重新执行」被硬拒（报 `concurrency-gate` 错误），到点的 cron 触发被**顺延**（下次运行时间不滚动，下个调度 tick 自动重试，绝不丢弃）。可选的定时巡逻（设置项 `patrolEnabled`，默认关闭；`patrolIntervalMs` 默认 30000）是宿主侧定时器，周期性扫描看板新任务并派发进空闲槽位：任务被派发必须**同时满足全部**判定条件——状态在「待办」（「待规划」停放池绝不被巡逻拾起）、未归档、自身没有未结执行、全部现存父任务已完成、高于会话默认的权限已被用户确认、且看板有空闲槽位。已启用 cron 的任务归 cron 调度器所有、巡逻不碰；巡逻绝不自动确认权限——未确认的高权限卡片会被跳过而非启动。看板头部显示实时徽标：巡逻开/关 + 在跑执行数/并发上限。**父任务结清（成功/失败/取消）后，宿主立即把刚变成可执行的「待办」子任务（有父任务）自动派进空闲槽位——settle 驱动的自动续跑，默认常开、与巡逻开关无关；新建的独立「待办」不会因创建而自动开跑**。它只是新增的触发源，不绕过上面任何一条判定条件；手动把父任务置「已完成」、确认权限后同样即时续跑；宿主重启后的首个调度 tick 会补齐宕机间隙。

## 目录结构

```
package.json / tsconfig.json / tsconfig.build.json / vitest.config.ts / tsdown.config.ts
build/tsdown.client.ts / build/web-platform.ts     # 内置的 dsh client bundle 预设 + 浏览器平台种子表
cordis.patch.yml                                   # bundle patch：把 ui-task-board 行插入 profile 清单
scripts/dsh-task-board.js                          # 一键挂载 / 卸载 / 状态 CLI
src/index.ts / src/invariant.ts                    # host 半边：配置 schema、SystemPrompt 段、宿主接线
src/host-service.ts                                # 宿主调度 tick（cron）、巡逻、settle 驱动续跑、状态流
src/host-ledger.ts                                 # 宿主权威账本（单主锁、原子 revision 栅栏提交）
src/host-runner.ts                                 # 真实执行：接入会话、重命名、session.prompt、观察结算
src/host-routes.ts / src/http.ts / src/loopback.ts # 宿主 HTTP 面 + 环回保护
src/power-inhibitor.ts                             # 可选的空闲睡眠保护（preventIdleSleep）
src/protocol.ts                                    # host <-> browser 线上协议（动作、快照、schema 版本）
src/dsh-home.ts / src/mount-once.ts / src/host/run-guarded.ts # 宿主工具（dsh home、单次挂载、受护执行）
src/core/*.ts                                      # 两侧共享纯逻辑：tasks / schedule / store / dashboard / projects /
                                                   # executability / handover / rework / session-reuse / freeze-snapshot
src/core/use-cases/*.ts                            # 纯账本迁移（新建 / 更新 / 删除 / 归档 / 定时 / 项目）
src/client/index.ts                                # apply(ctx)：runtime 服务、设置卡、DOM 挂载
src/client/board/*.tsx                             # React 看板视图（列 / 卡片 / 详情 / 弹窗 / 仪表盘 / 项目）
src/client/sidebar-entry.ts                        # 侧边栏入口注入（自愈式 MutationObserver）
src/client/session-menu-entry.ts                   # 会话行「添加为任务卡」菜单行（纯 DOM 注入 + 自修复）
src/client/session-new-task-overlay.tsx            # body 级新建任务模态根（独立于看板面板）
src/client/TaskBoardSettingsCard.tsx               # 原生设置卡（六个实时字段）
src/client/locales.ts                              # zh / en UI 字典
src/client/board.module.css                        # 样式（--dsw-* token，随主题 / 皮肤自适应）
tests/*.spec.ts                                    # 275 个自动化测试（账本 / 状态机 / cron / 门控 / 自动化 / UI 冒烟）
docs/screenshots/*.png                             # 上方截图
docs/project-management.md                         # 项目维度设计稿（v1 草稿，0.4.0 已实现）
```

## 为什么这样接（调研结论）

- **侧边栏没有可用的外挂槽位**：侧边栏壳只声明 `sidebar.workspaces` / `sidebar.settings` 两个 single 槽位，且已被 ui-workspace / ui-settings 占用；外部插件无法注册新槽位（声明即占有，重复声明抛错）。因此入口行走 skin 先例的 **DOM 注入**，并用 MutationObserver 自愈（React 重渲染波及该节点时同帧内重新插入，无闪烁）。
- **中间列无法通过槽位替换**：`conversation` 槽位是 single 且已被 ui-conversation 占用。看板视图以 DOM 方式挂在中间列（旧版 `[data-pane="conversation"]`，DSH 0.1.0-rc.6 AppFrame 布局为 `[class*="centerCol"]`；挂载选择器两者都保留）内（React 不管的尾部子节点），通过 `<html data-dsh-taskboard-active>` 属性切换显隐，底下的对话子树保持挂载有状态。
- **账本归宿主所有**：看板的权威来源是宿主侧账本（`~/.dsh/task-board/ledger-v2.json`，tmp+rename+fsync 原子提交，单主锁 `ledger-v2.lock`），经插件自身的宿主路由提供；浏览器经 `HttpTaskBoardHostTransport` 读写。浏览器 `localStorage`（`dsh.taskBoard.v1`，`LocalStorageTaskStore`）只作为宿主 RPC 不可用时的**降级兜底**——该路径下项目 UI 整体隐藏，看板优雅降级，而不是分叉出第二套存储模型。
- **执行走客户端 runtime**：`ctx.sessions.list` 订阅会话状态（`running` / `byId`），`ctx.workspaces.connectWorkspace()` 创建/复用会话，`session.prompt()` 真实驱动 agent，`ctx.sessions.open()` 跳转 transcript。
- **执行目标走同样的 runtime 脸**：工作区钉子把任务指定的 id 传给 `workspaces.connectWorkspace()`（先对照工作区列表校验，失效的钉子就地失败）；模式钉子通过 `api.agentPresets.select` 重组仍为空白状态的执行会话——只有首轮之前合法，所以排在 `session.prompt` 之前执行，`sessions.noteAgentPreset` 让会话列表标签即时更新；权限钉子经 `session.command` 提交 `/permission <id>` 斜杠命令——与壳自带权限选择器同一机制。提交被拒或没有命令认领该行时，在发 Prompt 前失败。
- **后台结算靠列表对账**：未打开的会话没有对话快照窗口（cold），所以执行结算以会话列表为准——每次列表变化都对账 running 任务；结果判定依次取「列表缺失→已取消 / 仍在跑→等待 / 对话快照可见→按 lastAgentError / 原始历史尾部→turn-error 节点证明失败 / 否则按成功」，对账幂等。
- **调度在宿主，不在标签页**：`src/host-service.ts` 每 30s tick 一次（`SCHEDULE_TICK_MS`）；到点的 cron 触发在开执行**之前**就把「下次运行」滚到下一个匹配点，同一 tick 绝不双发，宕机期间错过的触发点**跳过而不补跑**（`skipMissed`）。GUI 标签页不再是调度器——只需 DSH 宿主进程在跑，关掉浏览器不会停掉定时任务。同一个 tick 还负责把在跑执行与真实会话状态对账，并派发 settle 驱动的续跑。
- **一份账本、一个所有者**：宿主账本持有单主锁，同一时刻只有一个 DSH 进程拥有看板；每次变更都是带 revision 栅栏的原子提交，GUI 跟随账本 revision（及其 SSE 流），多标签页因此不可能各写一份、复活已删除任务，或把陈旧副本写回。
- **稳定的卡片编号**：Host 账本给每个任务签发一个全局单调递增的 `serial`（下一个号码由账本持有），以 `#N` 形式显示在卡片、详情头部与依赖行上，方便指派任务时直接引用编号。编号上线前已存在的任务会在下一次 Host 加载时按创建顺序回填；任务删除后编号绝不复用。看板筛选支持 `#N`（`#` 后可带空格）做精确编号匹配。

## 安装

三种方式任选其一：

```sh
### 1）从 npm 安装（已发布包）
dsh plugin --profile web add @linxin666/dsh-client-ui-task-board

### 2）从本仓库的 GitHub Release 安装（预构建 tgz，最新版）
curl -L -O https://github.com/ding7015869-alt/dsh-task-board/releases/latest/download/linxin666-dsh-client-ui-task-board-0.4.0.tgz
dsh plugin --profile web add file:$(pwd)/linxin666-dsh-client-ui-task-board-0.4.0.tgz

### 3）从源码安装（开发调试）
git clone https://github.com/ding7015869-alt/dsh-task-board.git
cd dsh-task-board
pnpm install && pnpm run build
dsh plugin --profile web add link:$(pwd)
```

全家桶聚合包 `@linxin666/dsh-web-ui-all` 可连同本插件与 DSH Web GUI 全家桶一起安装。

安装后**重启 `dsh web`**，侧边栏「新会话」下方出现「任务看板」入口即生效；页面刷新不够，需重启进程。

## 构建

前置：Node ≥ 20，官方 NPM SDK 可访问。类型与运行时 API 全部来自官方 NPM SDK（`@deepseek-ai/*` devDependencies），浏览器 bundle 预设已内置在 `build/`——**无需任何 DSH 源码 checkout**。

```sh
cd dsh-task-board
pnpm install        # 在仓库根安装依赖
pnpm run build      # tsc 产出类型 + tsdown -> lib/index.js、lib/invariant.js、lib/client.js
pnpm run typecheck  # tsc --noEmit
pnpm test           # vitest：275 个测试（账本 / 状态机 / cron / 门控 / 自动化 / UI 冒烟）
```

`dsh plugin --profile web add link:$(pwd)` 之前必须先 `pnpm run build`：profile 通过 `lib/`（`main` / `exports`）解析包，而 `lib/` 不入库。

## 挂载 / 卸载

本插件采用官方 profile-bundle 形态（package.json 声明 `dsh.bundle.patch` + `dsh.client`，见 `cordis.patch.yml`）。挂载 = 在 web profile 清单（`~/.dsh/profiles/web/package.json`）注册依赖与 bundle 行并安装：

```sh
# 挂载（dependencies + dsh.profile.bundles 注册，pnpm install；重启 GUI 后生效）
node scripts/dsh-task-board.js mount

# 查看状态
node scripts/dsh-task-board.js status

# 卸载（移除注册行；重启 GUI 后恢复原状；任务数据保留）
node scripts/dsh-task-board.js unmount
```

profile 清单中注册的行：

```json
{
  "dependencies": { "@linxin666/dsh-client-ui-task-board": "link:/path/to/dsh-task-board" },
  "dsh": { "profile": { "bundles": [ "...", "@linxin666/dsh-client-ui-task-board" ] } }
}
```

> 注意：profile 层（bundle 行、`dsh.client` 元数据）在 dsh web 进程启动时读取，挂载/卸载后需要**重启 dsh web GUI** 才生效（页面刷新不够）。

## 数据存储位置

- 任务账本由**宿主权威持有**：`~/.dsh/task-board/ledger-v2.json`（`schemaVersion: 4`），以 tmp+rename+fsync 原子提交写入，单主锁 `ledger-v2.lock`；`scheduler-v2.json` 保存调度簿记。
- 账本包含任务、执行记录、全局 `nextSerial` 计数器、调度器状态，以及 **projects** 数组（恒含固定的 `default` 项目）与每个任务可选的 `projectId`（加载时回填 `default`）。项目与任务同文件、同锁、同一次原子提交，「删项目 → 挪卡」是一次事务，绝不产生无主卡。
- 卸载插件后账本保留；如需清除，在 `dsh web` 停止时删除 `~/.dsh/task-board/`。
- 浏览器侧只保留 `dsh.taskBoard.v1`（localStorage）作为宿主 RPC 不可用时的**兜底**（`LocalStorageTaskStore`，接口见 `src/core/store.ts`）；该兜底没有项目层，项目 UI 在此时隐藏。

## 手动验证步骤

1. `pnpm run build` → `node scripts/dsh-task-board.js mount` → **重启 `dsh web`** → 打开 `http://127.0.0.1:3080`。
2. 侧边栏「新会话」下方出现「任务看板」入口行；点击 → 中间列切换为看板：四个卡片列 + 「已失败」槽位的仪表盘面板。
3. 「+ 新建任务」填标题/描述/Prompt → 卡片出现在「待办」；对话框同时提供 工作区/模式/权限 三项钉子，留空即运行时默认。
4. 在对话框或详情里给任务钉上工作区/模式/权限 → 执行 → 执行会话落在指定工作区下，列表行显示指定预设，会话的权限选择器显示指定权限。
5. 点卡片 → 详情可见内容与 Prompt；点「执行」→ 卡片变「进行中」（会话列表出现以任务标题命名的会话）；agent 跑完后卡片落「已完成」或「已失败」，详情执行记录有结果与时间，可「查看会话」跳转到真实 transcript。
6. 仪表盘面板：「已失败」槽位显示仪表盘而非卡片列——各状态数量磁贴、已结算执行统计 + 成功率、至多 3 条下次定时、失败任务列表；失败行的「重新执行」经宿主重跑、「移入待办」把任务重新排队；点整行打开任务详情。
7. 定时任务：详情 →「定时运行」勾选启用，选预设「每 10 分钟」（cron `*/10 * * * *`），卡片出现定时标识；等待下一个整 10 分钟点，观察卡片自动进入「进行中」并最终完成，详情「上次触发」出现时间、执行记录新增一条（会话可跳转）。
8. 依赖门控：新建任务 B，在详情「依赖」区勾选任务 A 为父任务 → B 卡片出现「等待 1 个父任务」徽标，「执行 / 重新执行」禁用；把 A 执行到「已完成」→ 徽标消失、B 可执行（A 详情的「子任务」列表出现 B）；删除 A → B 的悬空边被剥除，B 保持可执行（fail-open）。
9. 项目管理：打开工具栏项目切换器 →「管理项目」→ 新建项目（自动分配色板色）、给默认项目改名（id 恒为 `default`）、尝试删除默认项目（被拒：默认项目不可删）；新建任务 C 并在对话框选择新项目 → 卡片显示项目徽标；详情里把「所属项目」改派到另一项目；仪表盘选「全部项目」→ 按项目统计表列出每项目的在板卡数 / 归档数 / 成功率，点行即把看板钻取进该项目（出现统计范围提示、表格隐藏）；删除项目 → 其名下卡片移入默认项目，`#N` 编号不变；刷新后项目与归属仍在（宿主账本持久化）。
10. 会话行菜单：在会话列表打开一个未被任何未归档任务卡引用的会话的「…」菜单 → 出现「添加为任务卡」项 → 点击 → 「新建任务」对话框以该会话标题预填标题打开；被未归档任务卡引用的会话（其最近/保留执行会话、冻结来源会话）不显示该项；把占用任务归档后，该项重新出现；项标签随 GUI 语言切换更新。
11. 设置卡：设置页中的任务看板卡显示六个字段（`enabled`、`announceToAgent`、`preventIdleSleep`、`maxConcurrency`、`patrolEnabled`、`patrolIntervalMs`）及其实效值；把 `maxConcurrency` 改成 2 并保存 → 看板头部徽标即时更新，无需重启；打开 `announceToAgent` → 下一个 agent 的系统提示词里出现 `plugin:task-board` 段（关闭后消失）；输入非法值（如 `maxConcurrency` 填 `0`）→ 保存被阻止并标红该字段，写入被拒时显示宿主返回的原因而不是静默丢弃。
12. 刷新页面/重启 DSH → 任务仍在；卸载插件 → GUI 恢复原状。

## 验收对照

- 挂载后侧边栏出现「任务看板」入口；点击切换看板，点会话项返回对话视图
- 会话行菜单：未被未归档任务卡占用（其最近执行会话 / 保留执行会话 / 冻结来源会话）的会话，「…」菜单出现「添加为任务卡」项；点击在 body 级打开「新建任务」对话框（标题预填为会话标题）；被占用的会话不显示该项，占用任务归档后重新出现
- 「已失败」槽位的仪表盘面板：各状态数量磁贴、已结算执行统计 + 成功率、至多 3 条下次定时、失败任务列表（至多 5 条）带「重新执行」/「移入待办」快捷操作，点整行打开任务详情
- 新建任务（标题+描述/Prompt）；刷新/重启后任务仍在（宿主权威账本 `~/.dsh/task-board/ledger-v2.json`）
- 点卡片开详情（内容 + 执行记录）；详情内有「执行」「删除」按钮
- 执行真实启动会话（会话列表可见 transcript）；卡片状态随真实执行进度变化；详情可跳转到执行会话
- 删除有确认环节，删除后本地存储同步移除
- 定时任务：cron 配置/预设/校验、下次运行时间、到点自动真实执行、状态回写、定时卡片标识、重启后调度恢复（宿主侧调度——浏览器可关闭；宕机期间错过的触发点跳过而不补跑）
- 依赖门控：有未结清父任务的任务显示「等待 N 个父任务」徽标且「执行 / 重新执行」禁用；宿主侧拒绝 run/rerun（`dependency-gate` 错误点名未结清父任务）并跳过到点定时触发，直到全部父任务完成；删除父任务解除其子任务阻塞（悬空 id fail-open）；新建对话框与详情面板均可多选父任务/子任务
- 项目管理：任务卡按项目分组，经工具栏管理（切换器 + 管理器：新建 / 改名 / 换色 / 删除，8 色调色板，默认项目不可删、兜底所有未分类卡）；新建对话框选所属项目（复制任务继承源项目），详情「所属项目」下拉改派；仪表盘「按项目统计」表（在板 / 归档 / 成功率，仅「全部项目」口径，点行钻取）+ 项目筛选；删项目把名下卡移入默认项目，`#N` 编号与执行史不变；项目分组是纯展示维度（不进派发门控），宿主账本（schema v4）持久化
- 看板自动化：单次看板并发上限（设置项 `maxConcurrency`，默认 1）——到顶时手动「执行 / 重新执行」被硬拒（`concurrency-gate` 错误），到点的定时触发被顺延而不丢弃（下次运行时间不滚动，等下一 tick）；定时巡逻（设置项 `patrolEnabled` 默认关闭、`patrolIntervalMs` 默认 30000）由宿主侧定时器周期扫描新任务，只在**全部**判定条件满足时向空闲槽位自动派发——状态在「待办」（待规划停放池绝不被拾起）、未归档、自身无未结执行、全部父任务已完成、高于会话默认的权限已被人工确认、且看板有空闲槽位；已启用 cron 的任务归定时调度器所有，巡逻不碰；巡逻绝不自动确认权限；看板头部徽标实时显示巡逻开/关与在跑执行数/并发上限。**父任务结清后其「待办」子任务立即自动续跑（settle 驱动，默认常开、与巡逻开关无关；仅限有父任务的子任务，独立新任务不会因创建而开跑；手动置父任务完成/确认权限后同样即时续跑，宿主重启后首 tick 补齐宕机间隙）**
- 任务级执行目标：工作区/模式/权限 钉子刷新后仍在，驱动执行会话；钉不住的钉子（工作区缺失、预设被锁、权限命令无人认领）在发 Prompt 前失败，执行记录可见原因
- 设置卡：DSH 原生设置卡暴露六个实时字段（`enabled`、`announceToAgent`、`preventIdleSleep`、`maxConcurrency`、`patrolEnabled`、`patrolIntervalMs`）；编辑先暂存再以一次原子 revision 栅栏写入提交，无需重启 DSH 即生效；非法或被拒的草稿会阻止保存并显示原因
- 一键挂载/卸载；卸载后 GUI 恢复原状，其它 managed 段不受影响
- README + 覆盖存储读写/状态流转/执行触发/cron 解析/调度器/依赖门控（宿主门控 + 定时跳过 + 删除 fail-open）/看板自动化（并发上限 + 巡逻派发 + settle 驱动自动续跑 + 全条件判定）/会话行「添加为任务卡」菜单项（占用判定 + 新建任务预填 + 纯 DOM 自修复，无变异反馈循环）的自动化测试

## 许可

[BSD 3-Clause License](LICENSE)。
