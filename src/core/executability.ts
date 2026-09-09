/**
 * The board's executability gate: the set of conditions every task must
 * satisfy before ANY dispatcher may start a run for it. Dispatchers (manual
 * run, cron scheduler, patrol) pre-filter cheaply, then the host ledger
 * re-checks the full gate at the moment of opening an execution, so a task
 * starts only when every condition holds at open time.
 *
 * The gate is deliberately pure and side-effect free: it takes the ledger
 * document's tasks plus the board-wide open-execution count and returns the
 * ordered list of failing conditions, never a boolean.
 */
import { pendingParentTasks, type TaskRecord, type TaskStatus } from './tasks.ts'
import { requiresPermissionConfirmation, type TaskPermission } from './handover.ts'

/** The statuses the patrol dispatcher picks up: new work lands in 待办. */
export const PATROL_STATUSES: readonly TaskStatus[] = ['todo']

/** The execution initiator stamp for runs opened by the board's patrol. */
export const PATROL_INITIATOR = 'task-board-patrol'

/**
 * The execution initiator stamp for the settle-driven auto-continuation: a
 * newly eligible task dispatched into a slot a settled run just freed.
 */
export const CONTINUE_INITIATOR = 'task-board-continue'

/** One failing executability condition, in check order. */
export type ExecutionBlocker =
  | 'archived'
  | 'status'
  | 'running'
  | 'parents-pending'
  | 'permission-unconfirmed'
  | 'concurrency-full'

/** The gate's verdict: executable only when every condition holds. */
export interface ExecutableCheck {
  /** True when no condition is blocking. */
  executable: boolean
  /** The failing conditions in check order; empty when executable. */
  blocked: readonly ExecutionBlocker[]
}

/** Everything the gate needs to judge one task, read at the ledger level. */
export interface ExecutabilityContext {
  /** The ledger's current tasks (for the parent dependency check). */
  tasks: readonly TaskRecord[]
  /** The session default permission the confirmation gate compares against. */
  sessionDefaultPermission: TaskPermission
  /** Board-wide open executions (tasks carrying an execution without endedAt). */
  openExecutions: number
  /** The board's concurrency cap (>= 1). */
  maxConcurrency: number
}

/** Count the tasks carrying at least one open (unsettled) execution. */
export function openExecutionCount(tasks: readonly TaskRecord[]): number {
  let count = 0
  for (const task of tasks) {
    if (task.executions.some(execution => execution.endedAt === undefined)) count += 1
  }
  return count
}

/**
 * Judge one task against every executability condition; all must hold:
 * 1. not archived
 * 2. status in the allowed set (patrol: `todo`)
 * 3. no open execution of its own
 * 4. every existing parent settled to done
 * 5. an elevated effective permission already confirmed by the user
 * 6. a concurrency slot is free board-wide
 * @param task - the task under judgment.
 * @param statuses - the statuses the dispatcher is allowed to start from.
 * @param ctx - the board-wide context read at open time.
 * @returns the verdict with the ordered list of failing conditions.
 */
export function checkExecutable(
  task: TaskRecord,
  statuses: readonly TaskStatus[],
  ctx: ExecutabilityContext,
): ExecutableCheck {
  const blocked: ExecutionBlocker[] = []
  if (task.archivedAt !== undefined) {
    blocked.push('archived')
  } else if (!statuses.includes(task.status)) {
    blocked.push('status')
  }
  if (task.executions.some(execution => execution.endedAt === undefined)) blocked.push('running')
  if (pendingParentTasks(task, ctx.tasks).length > 0) blocked.push('parents-pending')
  if (requiresPermissionConfirmation(task, ctx.sessionDefaultPermission)) {
    blocked.push('permission-unconfirmed')
  }
  if (ctx.openExecutions >= ctx.maxConcurrency) blocked.push('concurrency-full')
  return { executable: blocked.length === 0, blocked }
}
