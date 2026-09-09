/**
 * Dashboard panel math: the board summary that takes over the failed column.
 * Pure functions over task records (framework-free) so the aggregates are
 * unit-testable in isolation and the view layer stays thin.
 */
import type { TaskRecord, TaskStatus } from './tasks.ts'
import { projectOf, type ProjectRecord } from './projects.ts'

/** Settled-execution tallies across a task set. */
export interface RunTally {
  succeeded: number
  failed: number
  cancelled: number
}

/** The dashboard overview: live status counts plus settled run tallies. */
export interface DashboardSummary {
  /** Live task count per status, over the given (unarchived) tasks. */
  counts: Record<TaskStatus, number>
  /** Settled executions across the given tasks (open runs excluded). */
  runs: RunTally
  /** Settled runs that succeeded, as a 0-100 percentage; undefined when
   * no execution settled yet. */
  successRate: number | undefined
}

/**
 * Aggregate a task set into the dashboard overview. Pass the visible board
 * set (archived tasks excluded) so the numbers mirror the rendered columns.
 */
export function summarizeBoard(tasks: readonly TaskRecord[]): DashboardSummary {
  const counts: Record<TaskStatus, number> = { backlog: 0, todo: 0, running: 0, done: 0, failed: 0 }
  const runs: RunTally = { succeeded: 0, failed: 0, cancelled: 0 }
  for (const task of tasks) {
    counts[task.status] += 1
    for (const execution of task.executions) {
      if (execution.result === 'succeeded') runs.succeeded += 1
      else if (execution.result === 'failed') runs.failed += 1
      else if (execution.result === 'cancelled') runs.cancelled += 1
    }
  }
  const settled = runs.succeeded + runs.failed + runs.cancelled
  const successRate = settled === 0 ? undefined : Math.round((runs.succeeded / settled) * 100)
  return { counts, runs, successRate }
}

/**
 * Local-midnight boundary for the "today" dimension, in ms epoch: the instant
 * of 00:00 on the wall-clock day that contains `now`, in the Host time zone
 * (`timeZone`, IANA name; absent = the runtime's local zone). This matches
 * the scheduler's Host-local-time-zone cron semantics. Pure + injectable
 * (`now`) so both halves and the tests share the boundary math.
 */
export function startOfDayMs(now: number = Date.now(), timeZone?: string): number {
  const zone = timeZone !== undefined && timeZone.length > 0 ? timeZone : undefined
  const parts = new Intl.DateTimeFormat('en-CA', zone === undefined ? {} : { timeZone: zone })
    .formatToParts(new Date(now))
  const value = (type: string): number => Number(parts.find(part => part.type === type)?.value ?? '1')
  // Wall-clock midnight expressed as a UTC instant (before the offset is out).
  const wallMidnightUtc = Date.UTC(value('year'), value('month') - 1, value('day'))
  // The zone's UTC offset at a candidate instant, probed through its own
  // clock parts (the re-probe at the candidate catches a DST crossing at the
  // day boundary).
  const offsetAt = (utc: number): number => {
    const clock = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', timeZone: zone ?? undefined,
    }).formatToParts(new Date(utc))
    const part = (type: string): number => Number(clock.find(entry => entry.type === type)?.value ?? '0')
    return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - utc
  }
  const candidate = wallMidnightUtc - offsetAt(wallMidnightUtc)
  return wallMidnightUtc - offsetAt(candidate)
}

/**
 * The "today" slice of the dashboard overview: status tiles count tasks
 * CREATED at or after `startMs` (grouped by their current status), and the
 * run tallies count settled executions that ENDED at or after `startMs`
 * (open executions stay excluded, as in {@link summarizeBoard}). Bounded by
 * the execution-history retention limit, exactly like the cumulative view.
 */
export function summarizeToday(tasks: readonly TaskRecord[], startMs: number): DashboardSummary {
  const counts: Record<TaskStatus, number> = { backlog: 0, todo: 0, running: 0, done: 0, failed: 0 }
  const runs: RunTally = { succeeded: 0, failed: 0, cancelled: 0 }
  for (const task of tasks) {
    if (task.createdAt < startMs) continue
    counts[task.status] += 1
  }
  for (const task of tasks) {
    for (const execution of task.executions) {
      if (execution.endedAt === undefined || execution.endedAt < startMs) continue
      if (execution.result === 'succeeded') runs.succeeded += 1
      else if (execution.result === 'failed') runs.failed += 1
      else if (execution.result === 'cancelled') runs.cancelled += 1
    }
  }
  const settled = runs.succeeded + runs.failed + runs.cancelled
  const successRate = settled === 0 ? undefined : Math.round((runs.succeeded / settled) * 100)
  return { counts, runs, successRate }
}

/** One armed schedule with its next due instant. */
export interface UpcomingSchedule {
  task: TaskRecord
  nextRunAt: number
}

/**
 * Armed schedules that already carry a computed next run, soonest first,
 * capped at `limit`. Disabled rules and armed rules without a computed
 * instant are skipped.
 */
export function upcomingSchedules(tasks: readonly TaskRecord[], limit: number): UpcomingSchedule[] {
  const rows: UpcomingSchedule[] = []
  for (const task of tasks) {
    if (task.schedule?.enabled !== true || task.schedule.nextRunAt === undefined) continue
    rows.push({ task, nextRunAt: task.schedule.nextRunAt })
  }
  rows.sort((a, b) => a.nextRunAt - b.nextRunAt)
  return rows.slice(0, limit)
}

/** The task's most recent settled failure (error text + settle instant). */
export function latestFailureOf(task: TaskRecord): { error: string | undefined; endedAt: number | undefined } | undefined {
  for (let i = task.executions.length - 1; i >= 0; i -= 1) {
    const execution = task.executions[i]
    if (execution.result === 'failed') return { error: execution.error, endedAt: execution.endedAt }
  }
  return undefined
}

/** The last activity instant: the newest settled execution, else the record stamp. */
function activityOf(task: TaskRecord): number {
  const last = task.executions[task.executions.length - 1]
  const settled = last?.endedAt
  return settled !== undefined ? Math.max(settled, task.updatedAt) : task.updatedAt
}

/**
 * Failed tasks, most recently active first, capped at `limit`. The dashboard
 * lists them in place of the failed column, each row keeping quick actions.
 */
export function failedTasks(tasks: readonly TaskRecord[], limit: number): TaskRecord[] {
  return tasks
    .filter(task => task.status === 'failed')
    .sort((a, b) => activityOf(b) - activityOf(a))
    .slice(0, limit)
}

/** One row of the dashboard's per-project table (all mode). */
export interface ProjectSummary {
  projectId: string
  name: string
  color: ProjectRecord['color']
  /** Live status counts over the project's ON-BOARD tasks. */
  counts: Record<TaskStatus, number>
  /** All of the project's tasks (archived included). */
  total: number
  /** The project's archived tasks. */
  archived: number
}

/**
 * Per-project breakdown for the dashboard's project dimension: one row per
 * project in board order (the default project first, as the ledger mints it),
 * live status counts over the on-board set plus the archived and grand
 * totals. A card with a missing or dangling `projectId` is attributed to the
 * default project, mirroring the ledger's load-time backfill. Pass the full
 * task set (archived included) so the totals stay honest.
 */
export function summarizeByProject(tasks: readonly TaskRecord[], projects: readonly ProjectRecord[]): ProjectSummary[] {
  return projects.map(project => {
    const counts: Record<TaskStatus, number> = { backlog: 0, todo: 0, running: 0, done: 0, failed: 0 }
    let total = 0
    let archived = 0
    for (const task of tasks) {
      if (projectOf(task, projects) !== project.id) continue
      total += 1
      if (task.archivedAt !== undefined) {
        archived += 1
        continue
      }
      counts[task.status] += 1
    }
    return { projectId: project.id, name: project.name, color: project.color, counts, total, archived }
  })
}
