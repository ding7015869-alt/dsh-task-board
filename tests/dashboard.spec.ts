/**
 * Dashboard panel math: overview summary, upcoming schedules, and the
 * failed-task list that takes over the failed column.
 */
import { describe, expect, it } from 'vitest'
import {
  failedTasks, latestFailureOf, startOfDayMs, summarizeBoard, summarizeToday, upcomingSchedules,
} from '../src/core/dashboard.ts'
import { createTask, settleExecution, startExecution, withSchedule, withStatus, type TaskRecord } from '../src/core/tasks.ts'

const NOW = 1_700_000_000_000

function task(title: string, id: string): TaskRecord {
  return createTask({ title, description: '', prompt: '' }, NOW, id)
}

function doneTask(id: string, error?: string): TaskRecord {
  let rec = task(`任务 ${id}`, id)
  const { task: running } = startExecution(rec, NOW + 1, `${id}-run`)
  return error === undefined
    ? settleExecution(running, `${id}-run`, 'succeeded', NOW + 2, undefined)
    : settleExecution(running, `${id}-run`, 'failed', NOW + 2, error)
}

function cancelledTask(id: string): TaskRecord {
  let rec = task(`任务 ${id}`, id)
  const { task: running } = startExecution(rec, NOW + 1, `${id}-run`)
  return settleExecution(running, `${id}-run`, 'cancelled', NOW + 2, 'interrupted')
}

describe('summarizeBoard', () => {
  it('counts live tasks per status and tallies settled runs', () => {
    const tasks = [
      task('a', 'a'), // todo
      withStatus(task('b', 'b'), 'backlog', NOW),
      doneTask('c'), // done, 1 succeeded
      doneTask('d', 'boom'), // failed, 1 failed
      cancelledTask('e'), // todo, 1 cancelled
    ]
    const summary = summarizeBoard(tasks)
    expect(summary.counts).toEqual({ backlog: 1, todo: 2, running: 0, done: 1, failed: 1 })
    expect(summary.runs).toEqual({ succeeded: 1, failed: 1, cancelled: 1 })
    expect(summary.successRate).toBe(33) // 1 of 3 settled
  })

  it('leaves the success rate undefined when nothing settled', () => {
    const tasks = [task('a', 'a'), task('b', 'b')]
    expect(summarizeBoard(tasks).successRate).toBeUndefined()
    expect(summarizeBoard([]).successRate).toBeUndefined()
  })

  it('ignores open executions in the tallies', () => {
    const { task: runningTask } = startExecution(task('a', 'a'), NOW + 1, 'run-1')
    const summary = summarizeBoard([runningTask])
    expect(summary.runs).toEqual({ succeeded: 0, failed: 0, cancelled: 0 })
    expect(summary.successRate).toBeUndefined()
    expect(summary.counts.running).toBe(1)
  })
})

describe('summarizeToday', () => {
  // The "midnight" for this suite: everything at or after NOW + 100 is today.
  const WINDOW = NOW + 100

  it('counts created-today tasks per status and tallies today-settled runs', () => {
    const old = doneTask('old') // created at NOW, settled at NOW + 2 (both before the window)
    let fresh = createTask({ title: 'fresh', description: '', prompt: '' }, NOW + 200, 'fresh') // created inside the window
    const { task: freshRunning } = startExecution(fresh, NOW + 210, 'fresh-run')
    fresh = settleExecution(freshRunning, 'fresh-run', 'succeeded', NOW + 220, undefined)
    const summary = summarizeToday([old, fresh], WINDOW)
    // Tiles: only the created-today task shows, in its current status.
    expect(summary.counts).toEqual({ backlog: 0, todo: 0, running: 0, done: 1, failed: 0 })
    // Runs: the old task's pre-window settlement is out; the fresh one is in.
    expect(summary.runs).toEqual({ succeeded: 1, failed: 0, cancelled: 0 })
    expect(summary.successRate).toBe(100)
  })

  it('counts a today-settled run of an OLDER task, but keeps its tiles out', () => {
    let old = task('old', 'old') // created at NOW (< WINDOW)
    const { task: running } = startExecution(old, NOW + 5, 'old-run')
    old = settleExecution(running, 'old-run', 'failed', WINDOW + 5, 'boom') // settled inside the window
    const summary = summarizeToday([old], WINDOW)
    expect(summary.counts).toEqual({ backlog: 0, todo: 0, running: 0, done: 0, failed: 0 })
    expect(summary.runs).toEqual({ succeeded: 0, failed: 1, cancelled: 0 })
    expect(summary.successRate).toBe(0)
  })

  it('excludes open executions and pre-window settlements from the tallies', () => {
    const openOnly = startExecution(task('open', 'open'), NOW + 5, 'open-run').task // still running
    let settledEarly = task('early', 'early')
    const { task: earlyRunning } = startExecution(settledEarly, NOW + 5, 'early-run')
    settledEarly = settleExecution(earlyRunning, 'early-run', 'cancelled', NOW + 50, 'stop') // before the window
    const summary = summarizeToday([openOnly, settledEarly], WINDOW)
    expect(summary.runs).toEqual({ succeeded: 0, failed: 0, cancelled: 0 })
    expect(summary.successRate).toBeUndefined()
  })

  it('is empty when nothing was created or settled in the window', () => {
    const old = doneTask('old')
    const summary = summarizeToday([old], NOW + 10_000)
    expect(summary.counts).toEqual({ backlog: 0, todo: 0, running: 0, done: 0, failed: 0 })
    expect(summary.runs).toEqual({ succeeded: 0, failed: 0, cancelled: 0 })
    expect(summary.successRate).toBeUndefined()
  })
})

describe('startOfDayMs', () => {
  // 2023-11-14T22:13:20Z, used as the fixed probe instant.
  const PROBE = 1_700_000_000_000

  it('returns the Host-zone midnight for a known instant (Asia/Shanghai = UTC+8)', () => {
    // 22:13Z on the 14th is 06:13 on the 15th in Shanghai; the 15th started
    // at 16:00Z on the 14th.
    expect(startOfDayMs(PROBE, 'Asia/Shanghai')).toBe(1_699_977_600_000)
  })

  it('supports arbitrary IANA zones (UTC)', () => {
    // 22:13Z is still the 14th in UTC; midnight of the 14th is 00:00Z.
    expect(startOfDayMs(PROBE, 'UTC')).toBe(1_699_920_000_000)
  })

  it('handles a negative-offset zone (America/New_York, EST = UTC-5 in November)', () => {
    // 22:13Z is 17:13 EST on the 14th; the 14th started at 05:00Z.
    expect(startOfDayMs(PROBE, 'America/New_York')).toBe(1_699_938_000_000)
  })

  it('slices a previous wall-clock day in the same zone', () => {
    // 23:00 on the 14th in Shanghai is 15:00Z on the 14th; that Shanghai day
    // started at 16:00Z on the 13th.
    expect(startOfDayMs(1_699_974_000_000, 'Asia/Shanghai')).toBe(1_699_891_200_000)
  })

  it('falls back to the runtime-local midnight when no zone is given', () => {
    const boundary = startOfDayMs(PROBE)
    const local = new Date(boundary)
    expect(local.getHours()).toBe(0)
    expect(local.getMinutes()).toBe(0)
    expect(local.getSeconds()).toBe(0)
    expect(boundary).toBeLessThanOrEqual(PROBE)
    expect(PROBE - boundary).toBeLessThan(24 * 3_600_000)
  })
})

describe('upcomingSchedules', () => {
  it('lists armed schedules with a computed next run, soonest first, capped', () => {
    const armed = (id: string, nextRunAt: number): TaskRecord =>
      withSchedule(task(id, id), { enabled: true, cron: '0 9 * * *', nextRunAt }, NOW)
    const disabled = withSchedule(task('off', 'off'), { enabled: false, cron: '0 9 * * *', nextRunAt: NOW + 1 }, NOW)
    const noInstant = withSchedule(task('pending', 'pending'), { enabled: true, cron: '0 9 * * *', nextRunAt: undefined }, NOW)
    const tasks = [armed('b', NOW + 20), disabled, noInstant, armed('a', NOW + 10)]
    const rows = upcomingSchedules(tasks, 3)
    expect(rows.map(row => row.task.id)).toEqual(['a', 'b'])
    expect(rows[0].nextRunAt).toBe(NOW + 10)
  })

  it('caps at the requested limit without reordering the rest', () => {
    const armed = (id: string, nextRunAt: number): TaskRecord =>
      withSchedule(task(id, id), { enabled: true, cron: '0 9 * * *', nextRunAt }, NOW)
    const tasks = [armed('c', NOW + 30), armed('a', NOW + 10), armed('b', NOW + 20)]
    expect(upcomingSchedules(tasks, 2).map(row => row.task.id)).toEqual(['a', 'b'])
  })
})

describe('failedTasks / latestFailureOf', () => {
  it('lists failed tasks by most recent activity, capped', () => {
    const old = doneTask('old', 'boom-old') // settled at NOW + 2
    const fresh = doneTask('new', 'boom-new')
    const fresher = doneTask('newest', 'boom-newest')
    // Nudge activity timestamps apart without touching the settled runs.
    const movedOld = withStatus({ ...old, updatedAt: NOW }, 'failed', NOW)
    const movedFresh = withStatus({ ...fresh, updatedAt: NOW + 5 }, 'failed', NOW + 5)
    const movedFresher = withStatus({ ...fresher, updatedAt: NOW + 6 }, 'failed', NOW + 6)
    const other = task('ok', 'ok') // not failed
    const rows = failedTasks([movedOld, movedFresh, other, movedFresher], 5)
    expect(rows.map(task => task.id)).toEqual(['newest', 'new', 'old'])
  })

  it('caps at the requested limit', () => {
    const rows = failedTasks(
      [doneTask('a', 'e'), doneTask('b', 'e')],
      1,
    )
    expect(rows).toHaveLength(1)
  })

  it('returns nothing when no task is failed', () => {
    expect(failedTasks([task('ok', 'ok')], 5)).toEqual([])
  })

  it('reads the most recent settled failure, not the first', () => {
    let rec = task('retry me', 'retry')
    rec = startExecution(rec, NOW + 1, 'run-1').task
    rec = settleExecution(rec, 'run-1', 'failed', NOW + 2, 'first failure')
    rec = startExecution(rec, NOW + 3, 'run-2').task
    rec = settleExecution(rec, 'run-2', 'succeeded', NOW + 4, undefined)
    // A later failed run supersedes the earlier record.
    rec = startExecution(rec, NOW + 5, 'run-3').task
    rec = settleExecution(rec, 'run-3', 'failed', NOW + 6, 'second failure')
    expect(latestFailureOf(rec)).toEqual({ error: 'second failure', endedAt: NOW + 6 })
  })

  it('is undefined for tasks without settled failures', () => {
    expect(latestFailureOf(task('ok', 'ok'))).toBeUndefined()
    expect(latestFailureOf(doneTask('ok'))).toBeUndefined()
  })
})
