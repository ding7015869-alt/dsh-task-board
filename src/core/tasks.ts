/**
 * Task board domain model: task lifecycle statuses, the task record shape,
 * and the pure transition functions the controller and tests share.
 * Framework-free (no cordis, no runtime imports) so the state machine is
 * unit-testable in isolation.
 */
import type { FreezeSnapshot } from './freeze-snapshot.ts'
import type { TaskHandover, TaskHandoverInput } from './handover.ts'

/** Task lifecycle status, one per kanban column. */
export type TaskStatus = 'backlog' | 'todo' | 'running' | 'done' | 'failed'

/**
 * One real execution attempt: the run's own id, the dsh session that ran it
 * (filled once the session is created), and the settled outcome once the
 * session's turn ended.
 */
export interface ExecutionRecord {
  /** Execution attempt id (uuid). */
  id: string
  /** The dsh session that ran this attempt; absent until creation resolves. */
  sessionId: string | undefined
  /** When the run started (ms epoch). */
  startedAt: number
  /** When the run settled; absent while still running. */
  endedAt: number | undefined
  /** Outcome once settled. */
  result: 'succeeded' | 'failed' | 'cancelled' | undefined
  /** Human failure text when the run failed (prompt rejection or agent error). */
  error: string | undefined
  /**
   * Session id of the DSH session that issued the run/rerun action (issue #6
   * audit origin). Client-asserted, not a trust boundary; absent when the run
   * was triggered by cron (source unknown).
   */
  initiatedBy?: string
  /** Freeze instant captured from the card snapshot when the run opened. */
  frozenAt?: number
  /** Freeze source session captured from the card snapshot when the run opened. */
  frozenBy?: string
  /**
   * Rework-round marker: the run opened while the card carried unconsumed
   * rework notes, so its prompt composes the modification notes instead of
   * the bare task prompt (stamped by {@link startExecution} for every
   * dispatcher, not only the rework action).
   */
  rework?: boolean
}

/**
 * One modification requirement a settled card was rejected with (the
 * rework/reject flow). Appended by the Host ledger's `rework` action; the
 * note stays unconsumed until an execution that carries it actually queues
 * its prompt into a session, so a launch that fails before prompting keeps
 * the note alive for the next execution.
 */
export interface ReworkNote {
  /** The modification requirement text (trimmed, bounded by the protocol gate). */
  note: string
  /** When the card was rejected with this note (ms epoch). */
  at: number
  /** When the note was consumed by a launched execution (ms epoch); absent while pending. */
  consumedAt?: number
}

/**
 * Maximum number of execution records retained per task. Older settled runs
 * are trimmed when a new execution starts so per-action ledger cost stays
 * bounded regardless of how often a task ran before.
 */
export const EXECUTION_HISTORY_LIMIT = 20

/**
 * Trim an execution list to at most {@link EXECUTION_HISTORY_LIMIT} records,
 * most recent last. A running (unsettled) execution is never trimmed: the
 * Host monitor and restart recovery depend on the active record, and a task
 * cannot start a new run while one is still open.
 */
export function retainRecentExecutions(executions: readonly ExecutionRecord[]): ExecutionRecord[] {
  if (executions.length <= EXECUTION_HISTORY_LIMIT) return [...executions]
  const open = executions.filter(execution => execution.endedAt === undefined)
  const settled = executions.filter(execution => execution.endedAt !== undefined)
  const keepSettled = Math.max(EXECUTION_HISTORY_LIMIT - open.length, 0)
  return [...settled.slice(Math.max(settled.length - keepSettled, 0)), ...open]
}

/**
 * A scheduled-run rule attached to a task. The Host scheduler triggers the
 * task when `nextRunAt` is due and persists the rule in the Host ledger.
 */
export interface ScheduleRule {
  /** Whether the schedule is armed. */
  enabled: boolean
  /** 5-field cron expression: `分 时 日 月 周`. */
  cron: string
  /** Next due instant (ms epoch); maintained by the scheduler/controller. */
  nextRunAt: number | undefined
  /** Instant of the latest scheduled trigger (ms epoch). */
  lastTriggeredAt: number | undefined
}

/**
 * Frozen context snapshot carried by a continuation card (issue #4): the
 * goal/progress/next text (already sanitized by the freeze gates) plus the
 * freeze instant and the redaction warning flag.
 */
export interface TaskFreeze extends FreezeSnapshot {
  /** When the snapshot was frozen (ms epoch, stamped by the create/update use case). */
  frozenAt: number
  /** True when the freeze gates redacted sensitive patterns out of the text. */
  redacted?: boolean
  /**
   * Session id of the DSH session that authored the frozen snapshot (issue #6
   * provenance): stamped by the Host ledger from the create/update action's
   * initiator, or kept from the wire payload when no initiator was asserted.
   */
  frozenBy?: string
}

/** One task on the board. */
export interface TaskRecord {
  /** Stable task id (uuid). */
  id: string
  /** Short display title. */
  title: string
  /** Longer human description shown in the detail view. */
  description: string
  /** The prompt sent to dsh when this task is executed. */
  prompt: string
  /** Current column. */
  status: TaskStatus
  /** Creation instant (ms epoch). */
  createdAt: number
  /** Last mutation instant (ms epoch). */
  updatedAt: number
  /**
   * Execution history retained on the task, most recent last: the latest
   * {@link EXECUTION_HISTORY_LIMIT} attempts, oldest trimmed on append.
   */
  executions: ExecutionRecord[]
  /** Optional scheduled-run rule (absent on tasks without a schedule). */
  schedule?: ScheduleRule
  /**
   * Workspace the execution must run in (a workspace-list id); absent means
   * the recent-workspace fallback at execution time.
   */
  workspaceId?: string
  /**
   * Agent preset the execution session must be composed from (an
   * `agentPreset.list` id); absent means the deployment default.
   */
  mode?: string
  /**
   * Permission preset applied to the execution session through the
   * `/permission <id>` slash command; absent leaves the session default.
   */
  permission?: TaskPermission
  /**
   * Pinned model selection for the execution session (format: "provider/model" or model id);
   * absent falls back to the host default (agent-default-model).
   */
  model?: string
  /**
   * Pinned reasoning-effort level for the execution session's model
   * (e.g. "high"); applied alongside the pinned model through
   * `session.selectModel`. Absent leaves the provider default; only
   * meaningful with a pinned model (the select-model contract carries the
   * effort on the model selection).
   */
  reasoningEffort?: string
  /**
   * Parent task ids (dependency gating, multiple allowed): the task opens for
   * execution only when every EXISTING parent has settled to `done`. Missing
   * parent ids (a deleted task) are ignored, so a removed parent can never
   * wedge its children forever. Child tasks are the derived reverse of this
   * field (see {@link childTasks}) and are never stored.
   */
  parentIds: string[]
  /**
   * Whether later executions continue in the previous execution's session
   * (issue #1419) instead of minting a fresh conversation per run. Absent or
   * false keeps the historical one-session-per-execution behavior; the reuse
   * itself only happens when that session is idle and still present (see
   * {@link reusableSessionId}).
   */
  reuseSession?: boolean
  /**
   * Frozen context snapshot for a continuation card; absent on plain tasks.
   * Sanitized before it enters the ledger (redaction, slash-command taint,
   * 8 KiB per-field cap) by the protocol gate and re-normalized on load.
   */
  freeze?: TaskFreeze
  /**
   * Handover bundle carried by a continuation card (issue #5): the pinned
   * execution triplet plus doc/script references. Sanitized before it
   * enters the ledger by the protocol gate and re-normalized on load; the
   * bundle's triplet overrides the legacy pin fields at execution time.
   */
  handover?: TaskHandover
  /**
   * Human confirmation stamp for an above-default effective permission
   * (ms epoch). Absent while the binding awaits confirmation; any permission
   * or handover change re-arms the gate by clearing it.
   */
  permissionConfirmedAt?: number
  /**
   * When the task was archived (ms epoch). Archived tasks keep their status
   * and execution history, leave the main board, and cannot run until restored;
   * absent means on-board.
   */
  archivedAt?: number
  /**
   * Stable card serial number (shown as "#N" on the card, detail, and
   * dependency lists): minted once by the Host ledger at creation and never
   * reused after the task is deleted, so a number keeps pointing at the same
   * task for its whole lifetime. Absent only on older ledger documents,
   * where the Host backfills numbers in creation order at load time.
   */
  serial?: number
  /**
   * The owning project id (ledger v4): a card groups under exactly one
   * project; a missing or dangling reference is owned by the default project
   * at load time. Grouping only — the card serial stays global and no
   * project field participates in the execution or dispatch gates.
   */
  projectId?: string
  /**
   * Rework/reject history: the modification requirements the card was sent
   * back with, most recent last. The detail view lists every round; an
   * execution that opens while notes are still unconsumed carries them into
   * its prompt (and the launcher marks them consumed once the prompt is
   * queued). Absent on cards that were never rejected.
   */
  reworkNotes?: ReworkNote[]
}

/** Statuses a settled task may be archived from. */
export const ARCHIVABLE_STATUSES: readonly TaskStatus[] = ['done', 'failed']


/** Permission presets a task may pin on its execution session (the `/permission <id>` ids). */
export const TASK_PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** One permission preset id. */
export type TaskPermission = typeof TASK_PERMISSIONS[number]

/** Whether an unknown value is a known permission preset id. */
export function isTaskPermission(value: unknown): value is TaskPermission {
  return typeof value === 'string' && (TASK_PERMISSIONS as readonly string[]).includes(value)
}

/** Input for creating a task. */
export interface NewTaskInput {
  title: string
  description: string
  prompt: string
  /** Workspace the execution must run in; empty/absent = the recent workspace. */
  workspaceId?: string
  /** Agent preset the execution session must be composed from; empty/absent = deployment default. */
  mode?: string
  /** Permission preset applied to the execution session; absent = session default. */
  permission?: TaskPermission
  /** Optional pinned model for the execution session; absent = host default. */
  model?: string
  /**
   * Optional pinned reasoning-effort level for the execution session's model
   * (e.g. "high"); applied with the pinned model via `session.selectModel`.
   * Absent/blank = provider default.
   */
  reasoningEffort?: string
  /**
   * Optional parent task ids (dependency gating): multiple allowed; the task
   * stays closed for execution until every existing parent settles to `done`.
   */
  parentIds?: string[]
  /** Reuse the previous execution's session for later runs (issue #1419). */
  reuseSession?: boolean
  /**
   * Optional scheduled-run rule requested at creation time (the new-task
   * dialog): an enable flag plus a 5-field cron expression. The create use
   * case arms it only when enabled and the expression is valid.
   */
  schedule?: { enabled: boolean; cron: string }
  /**
   * Optional frozen context snapshot (goal/progress/next, sanitized by the
   * protocol gate) turning the new task into a continuation card.
   */
  freeze?: FreezeSnapshot & { redacted?: boolean; frozenBy?: string }
  /**
   * Optional handover bundle (pinned triplet + doc/script references,
   * sanitized by the protocol gate) attached at creation.
   */
  handover?: TaskHandoverInput
  /**
   * Optional owning project id (board v4): a blank/absent value lands the
   * card in the default project. Grouping only — it never enters the
   * execution, patrol, or continue-dispatch gates.
   */
  projectId?: string
}

/** The five kanban columns, in display order. */
export const COLUMNS: readonly { status: TaskStatus; label: string }[] = [
  { status: 'backlog', label: '待规划' },
  { status: 'todo', label: '待办' },
  { status: 'running', label: '进行中' },
  { status: 'done', label: '已完成' },
  { status: 'failed', label: '已失败' },
]

/**
 * Statuses a user may move a card to manually: the parking pools and manual
 * completion. 'running' and 'failed' stay runner-owned; 'done' is reachable
 * by manual move so a card can be settled without an execution.
 */
export const MANUAL_STATUSES: readonly TaskStatus[] = ['backlog', 'todo', 'done']

/** Statuses the runner may move a card to from 'running'. */
export const RUNNER_SETTLE_STATUSES: readonly TaskStatus[] = ['done', 'failed']

/** All valid statuses (closed union guard). */
export const ALL_STATUSES: readonly TaskStatus[] = [
  'backlog', 'todo', 'running', 'done', 'failed',
]

/** Brand an unknown string as a status; undefined when it is not one. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (ALL_STATUSES as readonly string[]).includes(value)
}

/** Whether a manual move target is allowed from the given status. */
export function canMoveManually(from: TaskStatus, to: TaskStatus): boolean {
  return from !== 'running' && (MANUAL_STATUSES as readonly TaskStatus[]).includes(to)
}

/** Normalize one optional execution-target string: trim; blank collapses to undefined. */
export function normalizeTargetId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * Normalize a raw dependency id list: keep non-empty strings, drop
 * duplicates (first occurrence wins), and drop the task's own id so a task
 * can never point at itself.
 */
export function normalizeParentIds(value: readonly string[] | undefined, selfId?: string): string[] {
  if (value === undefined) return []
  const seen = new Set<string>()
  const next: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string' || raw === '') continue
    if (raw === selfId || seen.has(raw)) continue
    seen.add(raw)
    next.push(raw)
  }
  return next
}

/** The existing parent tasks of one task (missing parent ids are dropped). */
export function parentTasks(task: TaskRecord, tasks: readonly TaskRecord[]): TaskRecord[] {
  const byId = new Map(tasks.map(item => [item.id, item] as const))
  const found: TaskRecord[] = []
  for (const parentId of task.parentIds) {
    const parent = byId.get(parentId)
    if (parent !== undefined) found.push(parent)
  }
  return found
}

/**
 * The child tasks of one task: the reverse dependency edge, derived from the
 * other tasks' parentIds (multiple allowed, never stored on the task itself).
 */
export function childTasks(task: TaskRecord, tasks: readonly TaskRecord[]): TaskRecord[] {
  return tasks.filter(item => item.id !== task.id && item.parentIds.includes(task.id))
}

/**
 * The task's parent tasks that have NOT settled to `done` yet: the blocking
 * set of the dependency gate. An empty result means the task is open.
 */
export function pendingParentTasks(task: TaskRecord, tasks: readonly TaskRecord[]): TaskRecord[] {
  return parentTasks(task, tasks).filter(parent => parent.status !== 'done')
}

/**
 * Whether a task is open for execution (manual run, rerun, or scheduled):
 * every existing parent must have settled to `done`. A task without parents
 * is always open; parents that were deleted never block.
 */
export function isTaskOpen(task: TaskRecord, tasks: readonly TaskRecord[]): boolean {
  return pendingParentTasks(task, tasks).length === 0
}

/** Human-facing gate note: the pending parent titles, for errors and UI badges. */
export function taskGateNote(task: TaskRecord, tasks: readonly TaskRecord[]): string | undefined {
  const pending = pendingParentTasks(task, tasks)
  if (pending.length === 0) return undefined
  return pending.map(item => item.title).join(', ')
}

/**
 * Build the persisted freeze snapshot from a sanitized input, stamping the
 * freeze instant (shared by the create and update use cases).
 */
export function freezeOf(
  input: FreezeSnapshot & { redacted?: boolean; frozenBy?: string },
  now: number,
): TaskFreeze {
  return {
    goal: input.goal,
    progress: input.progress,
    next: input.next,
    frozenAt: now,
    ...(input.redacted === true ? { redacted: true } : {}),
    ...(input.frozenBy === undefined || input.frozenBy === '' ? {} : { frozenBy: input.frozenBy }),
  }
}

/** Create a task from user input. */
export function createTask(input: NewTaskInput, now: number, id: string): TaskRecord {
  return {
    id,
    title: input.title.trim(),
    description: input.description.trim(),
    prompt: input.prompt.trim(),
    status: 'todo',
    createdAt: now,
    updatedAt: now,
    executions: [],
    workspaceId: normalizeTargetId(input.workspaceId),
    mode: normalizeTargetId(input.mode),
    permission: isTaskPermission(input.permission) ? input.permission : undefined,
    model: normalizeTargetId(input.model),
    reasoningEffort: normalizeTargetId(input.reasoningEffort),
    parentIds: normalizeParentIds(input.parentIds, id),
    reuseSession: input.reuseSession === true ? true : undefined,
    projectId: normalizeTargetId(input.projectId),
    ...(input.freeze === undefined ? {} : { freeze: freezeOf(input.freeze, now) }),
    ...(input.handover === undefined ? {} : { handover: { ...input.handover, bundledAt: now } }),
  }
}

/** Clone a task with an updated status and a fresh updatedAt. */
export function withStatus(task: TaskRecord, status: TaskStatus, now: number): TaskRecord {
  return { ...task, status, updatedAt: now }
}

/**
 * Merge a schedule patch into a task's schedule rule (creating it when
 * absent), with a fresh updatedAt. Keys present in the patch overwrite the
 * current value — including explicit `undefined`, which clears a field (used
 * to disarm `nextRunAt`); absent keys keep their current value.
 */
export function withSchedule(
  task: TaskRecord,
  patch: Partial<ScheduleRule>,
  now: number,
): TaskRecord {
  const current = task.schedule
  const schedule: ScheduleRule = {
    enabled: current?.enabled ?? false,
    cron: current?.cron ?? '',
    nextRunAt: current?.nextRunAt,
    lastTriggeredAt: current?.lastTriggeredAt,
  }
  if ('enabled' in patch) schedule.enabled = patch.enabled ?? false
  if ('cron' in patch) schedule.cron = patch.cron ?? ''
  if ('nextRunAt' in patch) schedule.nextRunAt = patch.nextRunAt
  if ('lastTriggeredAt' in patch) schedule.lastTriggeredAt = patch.lastTriggeredAt
  return { ...task, updatedAt: now, schedule }
}

/**
 * Open a fresh execution on a task: move it to 'running' and append a
 * running execution record. Returns the new task and the new execution.
 */
export function startExecution(
  task: TaskRecord,
  now: number,
  executionId: string,
  initiatedBy?: string,
): { task: TaskRecord; execution: ExecutionRecord } {
  const execution: ExecutionRecord = {
    id: executionId,
    sessionId: undefined,
    startedAt: now,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    ...(initiatedBy === undefined || initiatedBy === '' ? {} : { initiatedBy }),
    // Capture the card's freeze provenance on the execution record so the
    // audit trail stays queryable even if the snapshot is replaced later.
    ...(task.freeze === undefined ? {} : {
      frozenAt: task.freeze.frozenAt,
      ...(task.freeze.frozenBy === undefined ? {} : { frozenBy: task.freeze.frozenBy }),
    }),
    // Uniform rework stamp: whichever dispatcher opens this execution
    // (manual run/rerun, cron, patrol, settle-continue, or the rework
    // action itself), it carries the card's pending modification notes into
    // its prompt, so a rework card parked at the cap keeps its notes alive
    // until a slot frees.
    ...(unconsumedReworkNotes(task).length > 0 ? { rework: true } : {}),
  }
  return {
    task: {
      ...task,
      status: 'running',
      updatedAt: now,
      executions: retainRecentExecutions([...task.executions, execution]),
    },
    execution,
  }
}

/**
 * Settle a running execution: record the outcome and move the task into the
 * matching column. No-op (returns the input task) when the execution is not
 * the task's latest or is already settled.
 */
export function settleExecution(
  task: TaskRecord,
  executionId: string,
  outcome: 'succeeded' | 'failed' | 'cancelled',
  now: number,
  error: string | undefined,
): TaskRecord {
  const index = task.executions.findIndex(execution => execution.id === executionId)
  if (index === -1) return task
  const execution = task.executions[index]
  if (execution.endedAt !== undefined) return task
  const settled: ExecutionRecord = { ...execution, endedAt: now, result: outcome, error }
  const executions = [...task.executions]
  executions[index] = settled
  const status: TaskStatus = outcome === 'succeeded'
    ? (task.schedule?.enabled ? 'todo' : 'done')
    : outcome === 'failed' ? 'failed'
      : task.status === 'running' ? 'todo' : task.status
  return { ...task, status, updatedAt: now, executions }
}

/**
 * The newest execution that already resolved a session (newest first, oldest
 * last): the session the card's session button jumps to. Undefined until the
 * most recent run's session creation has resolved (or the task never ran).
 */
export function latestSessionIdOf(task: TaskRecord): string | undefined {
  for (let index = task.executions.length - 1; index >= 0; index -= 1) {
    const sessionId = task.executions[index]?.sessionId
    if (sessionId !== undefined) return sessionId
  }
  return undefined
}

/**
 * The set of session ids currently claimed as task-card sessions: every
 * NON-archived task claims its newest execution session (the one the card's
 * session button points at), all retained execution sessions, and its freeze
 * snapshot's provenance session. Archived tasks release their sessions, so a
 * new card may claim the same session again. Drives the session-row menu's
 * "add as task card" visibility (client/session-menu-entry.ts).
 */
export function taskClaimedSessionIds(tasks: readonly TaskRecord[]): ReadonlySet<string> {
  const claimed = new Set<string>()
  for (const task of tasks) {
    if (task.archivedAt !== undefined) continue
    const latest = latestSessionIdOf(task)
    if (latest !== undefined) claimed.add(latest)
    for (const execution of task.executions) {
      if (execution.sessionId !== undefined) claimed.add(execution.sessionId)
    }
    const frozenBy = task.freeze?.frozenBy
    if (frozenBy !== undefined) claimed.add(frozenBy)
  }
  return claimed
}

/** A settled-execution summary string for the detail view. */
export function executionLabel(execution: ExecutionRecord): string {
  if (execution.result === 'succeeded') return 'succeeded'
  if (execution.result === 'failed') return 'failed'
  if (execution.result === 'cancelled') return 'cancelled'
  return 'running'
}

/** The card's rework notes not yet consumed by a launched execution. */
export function unconsumedReworkNotes(task: TaskRecord): readonly ReworkNote[] {
  return (task.reworkNotes ?? []).filter(note => note.consumedAt === undefined)
}

/** Whether the card holds a modification requirement that no execution has consumed yet. */
export function hasPendingRework(task: TaskRecord): boolean {
  return (task.reworkNotes ?? []).some(note => note.consumedAt === undefined)
}

/** Append a rejection note to the card's rework history (most recent last). */
export function withReworkNote(task: TaskRecord, note: string, now: number): TaskRecord {
  return {
    ...task,
    reworkNotes: [...(task.reworkNotes ?? []), { note, at: now }],
    updatedAt: now,
  }
}

/**
 * Mark every unconsumed rework note as consumed at `now` — the moment a
 * launched execution queued its prompt into a session. No-op (returns the
 * input task) when there is nothing left to consume.
 */
export function markConsumedReworkNotes(task: TaskRecord, now: number): TaskRecord {
  if (task.reworkNotes === undefined) return task
  if (!task.reworkNotes.some(note => note.consumedAt === undefined)) return task
  return {
    ...task,
    reworkNotes: task.reworkNotes.map(note => note.consumedAt === undefined ? { ...note, consumedAt: now } : note),
    updatedAt: now,
  }
}
