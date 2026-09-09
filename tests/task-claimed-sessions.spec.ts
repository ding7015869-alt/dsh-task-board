/**
 * Claimed-session predicate (taskClaimedSessionIds): which sessions are
 * "task cards" for the session-row menu's "add as task card" visibility —
 * every NON-archived task claims its newest execution session, all its
 * retained execution sessions, and its freeze provenance session; archived
 * tasks release their sessions.
 */
import { describe, expect, it } from 'vitest'
import {
  createTask, taskClaimedSessionIds,
  type ExecutionRecord, type TaskRecord,
} from '../src/core/tasks.ts'

const NOW = 1_700_000_000_000

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: id.toUpperCase(), description: '', prompt: id }, NOW, id), ...overrides }
}

function execution(id: string, sessionId: string | undefined, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id,
    sessionId,
    startedAt: NOW - 60_000,
    endedAt: NOW - 30_000,
    result: 'succeeded',
    error: undefined,
    ...overrides,
  }
}

describe('taskClaimedSessionIds', () => {
  it('claims the newest and all retained execution sessions of non-archived tasks', () => {
    const claimed = taskClaimedSessionIds([
      task('t1', { status: 'done', executions: [execution('e1', 's1'), execution('e2', 's2')] }),
    ])
    expect(claimed.has('s1')).toBe(true)
    expect(claimed.has('s2')).toBe(true)
    expect(claimed.size).toBe(2)
  })

  it('claims sessions of still-running tasks too', () => {
    const claimed = taskClaimedSessionIds([
      task('t1', { status: 'running', executions: [execution('e1', 's-live', { endedAt: undefined, result: undefined })] }),
    ])
    expect(claimed.has('s-live')).toBe(true)
  })

  it('claims the freeze snapshot provenance session', () => {
    const claimed = taskClaimedSessionIds([
      task('t1', { freeze: { goal: 'g', progress: 'p', next: 'n', frozenAt: NOW - 10_000, frozenBy: 'src-sess' } }),
    ])
    expect(claimed.has('src-sess')).toBe(true)
    expect(claimed.size).toBe(1)
  })

  it('releases sessions of archived tasks so a new card may claim them', () => {
    const claimed = taskClaimedSessionIds([
      task('t1', { status: 'done', archivedAt: NOW, executions: [execution('e1', 's1')], freeze: { goal: 'g', progress: 'p', next: 'n', frozenAt: NOW - 10_000, frozenBy: 's2' } }),
      task('t2', { status: 'todo', executions: [execution('e2', 's3')] }),
    ])
    expect(claimed.has('s1')).toBe(false)
    expect(claimed.has('s2')).toBe(false)
    expect(claimed.has('s3')).toBe(true)
  })

  it('returns an empty set for a board with no session-bearing tasks', () => {
    const claimed = taskClaimedSessionIds([task('t1'), task('t2', { executions: [execution('e1', undefined)] })])
    expect(claimed.size).toBe(0)
  })
})
