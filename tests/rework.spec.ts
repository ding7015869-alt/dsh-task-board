/**
 * Rework/reject flow tests: the card's rejection-note history and its helpers
 * (append, consume, pending checks), the rework prompt-section composition,
 * the continuation-session selection rule, the store/protocol gates for the
 * new fields, and the Host ledger's rework action (open, guards, park-at-cap,
 * consumption).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTask, hasPendingRework, markConsumedReworkNotes, startExecution, unconsumedReworkNotes,
  withReworkNote, type ExecutionRecord, type TaskRecord,
} from '../src/core/tasks.ts'
import { parseLedger } from '../src/core/store.ts'
import { REWORK_NOTE_MAX_LENGTH, reworkSection } from '../src/core/rework.ts'
import { reworkSessionId, reusableSessionId, sourceSessionId } from '../src/core/session-reuse.ts'
import { parseActionEnvelope } from '../src/protocol.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'

const NOW = 1_700_000_000_000

function makeTask(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: id.toUpperCase(), description: '', prompt: id }, NOW, id), ...overrides }
}

function execution(id: string, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id,
    sessionId: undefined,
    startedAt: NOW - 60_000,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    ...overrides,
  }
}

/** A settled card whose last execution ran in session 's1'. */
function settledTask(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return makeTask(id, {
    status: 'done',
    executions: [execution('e1', { sessionId: 's1', endedAt: NOW - 30_000, result: 'succeeded' })],
    ...overrides,
  })
}

describe('rework note helpers', () => {
  it('appends a rejection note (most recent last) and refreshes updatedAt', () => {
    const one = withReworkNote(settledTask('t'), 'first pass misses the spec', NOW)
    const two = withReworkNote(one, 'still not done', NOW + 10)
    expect(two.reworkNotes).toEqual([
      { note: 'first pass misses the spec', at: NOW },
      { note: 'still not done', at: NOW + 10 },
    ])
    expect(two.updatedAt).toBe(NOW + 10)
  })

  it('reports pending notes and clears the flag once consumed', () => {
    const pending = withReworkNote(settledTask('t'), 'fix it', NOW)
    expect(hasPendingRework(pending)).toBe(true)
    expect(unconsumedReworkNotes(pending).map(note => note.note)).toEqual(['fix it'])
    const consumed = markConsumedReworkNotes(pending, NOW + 1)
    expect(hasPendingRework(consumed)).toBe(false)
    expect(unconsumedReworkNotes(consumed)).toEqual([])
    expect(unconsumedReworkNotes(settledTask('plain'))).toEqual([])
    expect(hasPendingRework(settledTask('plain'))).toBe(false)
  })

  it('stamps every unconsumed note at once and is a no-op when nothing is pending', () => {
    const base = settledTask('t')
    expect(markConsumedReworkNotes(base, NOW)).toBe(base)
    const round1 = withReworkNote(base, 'a', NOW)
    const round2 = withReworkNote(round1, 'b', NOW + 1)
    const consumed = markConsumedReworkNotes(round2, NOW + 2)
    expect(consumed.reworkNotes?.map(note => note.consumedAt)).toEqual([NOW + 2, NOW + 2])
    expect(markConsumedReworkNotes(consumed, NOW + 3)).toBe(consumed)
  })

  it('stamps a uniform rework marker on any execution opened while notes are pending', () => {
    const { execution: stamped } = startExecution(withReworkNote(settledTask('t'), 'fix it', NOW), NOW, 'exec-1')
    expect(stamped.rework).toBe(true)
    const { execution: plain } = startExecution(settledTask('t2'), NOW, 'exec-2')
    expect(plain.rework).toBeUndefined()
  })
})

describe('reworkSection', () => {
  it('exposes the 8192-character note cap', () => {
    expect(REWORK_NOTE_MAX_LENGTH).toBe(8192)
  })

  it('numbers the notes oldest-first under the fixed header', () => {
    expect(reworkSection([{ note: 'trim the padding', at: 1 }])).toBe(
      '验收打回修改要求（任务看板）：验收不通过，共 1 条修改意见，请据此修改（原任务目标与上文会话历史保持不变）：\n1. trim the padding',
    )
    const composed = reworkSection([{ note: 'a', at: 1 }, { note: 'b', at: 2 }])
    expect(composed).toContain('共 2 条修改意见')
    expect(composed.indexOf('1. a')).toBeLessThan(composed.indexOf('2. b'))
  })
})

describe('reworkSessionId', () => {
  it('continues the last settled session without a reuseSession opt-in', () => {
    const task = settledTask('r')
    expect(task.reuseSession).toBeUndefined()
    expect(reworkSessionId(task)).toBe('s1')
    // The opt-out flag that blocks plain reuse does not block a rework round:
    // the fix belongs in the session that did the work.
    const optOut = settledTask('r', { reuseSession: false })
    expect(reworkSessionId(optOut)).toBe('s1')
    expect(reusableSessionId(optOut, new Set(['s1']))).toBeUndefined()
  })

  it('continues the original session even when the roster misses it', () => {
    // The recorded session id is authoritative (the card requirement): no
    // idle-roster check — a session the roster never listed, or an unknown
    // roster right after a restart, must not re-home the round in a new
    // conversation.
    expect(reworkSessionId(settledTask('r', { executions: [execution('e', { sessionId: 's9', endedAt: NOW, result: 'succeeded' })] }))).toBe('s9')
  })

  it('skips the execution record the rework action just opened (service flow)', () => {
    // startExecution appends the new open record to task.executions BEFORE the
    // launcher picks a session — the answer must come from the newest SETTLED
    // execution, not the just-opened one (no session id yet). The regression
    // behind the acceptance failure: both rework rounds minted fresh sessions
    // because the freshly appended record shadowed the settled one.
    const { task } = startExecution(withReworkNote(settledTask('r'), 'again', NOW), NOW + 5, 'e-open')
    expect(task.executions[task.executions.length - 1]!.sessionId).toBeUndefined()
    expect(reworkSessionId(task)).toBe('s1')
  })

  it('reuses the last settled session even with a fresh open record present', () => {
    // The plain-reuse path (issue #1419) had the same shadowing bug: the
    // just-opened record must not block the opt-in card's session reuse.
    const { task } = startExecution(settledTask('r', { reuseSession: true }), NOW + 5, 'e-open')
    expect(reusableSessionId(task, new Set(['s1']))).toBe('s1')
    expect(reusableSessionId(task, new Set(['other']))).toBeUndefined()
  })

  it('never continues from a card that has no settled session', () => {
    expect(reworkSessionId(makeTask('r', { status: 'done' }))).toBeUndefined()
    expect(reworkSessionId(settledTask('r', { executions: [execution('e', { sessionId: undefined, endedAt: NOW, result: 'succeeded' })] }))).toBeUndefined()
    expect(reworkSessionId(settledTask('r', { executions: [execution('e', { sessionId: 's1' })] }))).toBeUndefined()
  })
})

describe('sourceSessionId', () => {
  const sourced = (id: string, overrides: Partial<TaskRecord> = {}) =>
    makeTask(id, { sourceSession: { id: 'src-1', title: '写周报' }, ...overrides })

  it('continues the source session of the card when the idle roster confirms it', () => {
    expect(sourceSessionId(sourced('s'), new Set(['src-1']))).toBe('src-1')
  })

  it('fails closed on an unknown roster, a busy source, or a missing source', () => {
    expect(sourceSessionId(sourced('s'), undefined)).toBeUndefined()
    expect(sourceSessionId(sourced('s'), new Set(['other']))).toBeUndefined()
    expect(sourceSessionId(sourced('s', { sourceSession: undefined }), new Set(['src-1']))).toBeUndefined()
  })

  it('anchors a card ahead of the plain reuse rule (source wins over the previous-run session)', () => {
    const task = sourced('s', {
      reuseSession: true,
      executions: [execution('e1', { sessionId: 'prev-run', endedAt: NOW - 10_000, result: 'succeeded' })],
    })
    expect(sourceSessionId(task, new Set(['src-1', 'prev-run']))).toBe('src-1')
    // Without the source pin, the same card falls through to the reuse rule.
    const plain = makeTask('s', {
      reuseSession: true,
      executions: [execution('e1', { sessionId: 'prev-run', endedAt: NOW - 10_000, result: 'succeeded' })],
    })
    expect(sourceSessionId(plain, new Set(['prev-run']))).toBeUndefined()
    expect(reusableSessionId(plain, new Set(['prev-run']))).toBe('prev-run')
  })
})

describe('store rework normalization', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: id.toUpperCase(),
    description: '',
    prompt: id,
    status: 'done',
    createdAt: NOW,
    updatedAt: NOW,
    executions: [],
    ...extra,
  })

  it('keeps valid notes in order and drops the bad entries on their own', () => {
    const rows = parseLedger(JSON.stringify([row('a', {
      reworkNotes: [
        { note: 'good', at: 1 },
        { note: 'also good', at: 2, consumedAt: 3 },
        { note: 7, at: 1 },
        { note: 'no time', at: 'x' },
        'junk',
        { note: 'bad consumed', at: 4, consumedAt: 'nope' },
      ],
    })]))
    expect(rows[0]?.reworkNotes).toEqual([
      { note: 'good', at: 1 },
      { note: 'also good', at: 2, consumedAt: 3 },
      { note: 'bad consumed', at: 4 },
    ])
  })

  it('yields an absent reworkNotes when nothing valid remains', () => {
    expect(parseLedger(JSON.stringify([row('b', { reworkNotes: [{ at: 1 }] })]))[0]?.reworkNotes).toBeUndefined()
    expect(parseLedger(JSON.stringify([row('c', { reworkNotes: 'not an array' })]))).toEqual([])
  })

  it('clears a non-true execution rework flag and keeps a true one', () => {
    const rows = parseLedger(JSON.stringify([row('d', {
      executions: [
        { id: 'e1', startedAt: 1, rework: false },
        { id: 'e2', startedAt: 2, rework: true },
        { id: 'e3', startedAt: 3 },
      ],
    })]))
    expect(rows[0]?.executions.map(entry => entry.rework)).toEqual([undefined, true, undefined])
  })

  it('drops a row whose execution rework flag is not a boolean', () => {
    expect(parseLedger(JSON.stringify([row('e', { executions: [{ id: 'e1', startedAt: 1, rework: 'yes' }] })]))).toEqual([])
  })
})

describe('protocol rework gate', () => {
  const importRow = {
    id: 'imp',
    title: 'IMP',
    description: '',
    prompt: 'imp',
    status: 'done',
    createdAt: NOW,
    updatedAt: NOW,
    executions: [] as unknown[],
  }

  const importEnvelope = (tasks: unknown[]) => parseActionEnvelope({ requestId: 'ri', action: { kind: 'import', sourceId: 'src', tasks } })

  it('accepts a bounded non-blank note and trims it', () => {
    const envelope = parseActionEnvelope({ requestId: 'r1', action: { kind: 'rework', taskId: 't', note: '  fix it  ' } })
    expect(envelope?.action).toEqual({ kind: 'rework', taskId: 't', note: 'fix it' })
  })

  it('rejects a missing, blank, non-string, or oversized note', () => {
    expect(parseActionEnvelope({ requestId: 'r2', action: { kind: 'rework', taskId: 't' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r3', action: { kind: 'rework', taskId: 't', note: '   ' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r4', action: { kind: 'rework', taskId: 't', note: 42 } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r5', action: { kind: 'rework', taskId: 't', note: 'x'.repeat(REWORK_NOTE_MAX_LENGTH + 1) } })).toBeUndefined()
  })

  it('accepts a note exactly at the cap', () => {
    const envelope = parseActionEnvelope({ requestId: 'r6', action: { kind: 'rework', taskId: 't', note: 'x'.repeat(REWORK_NOTE_MAX_LENGTH) } })
    expect(envelope?.action.kind === 'rework' ? envelope.action.note.length : undefined).toBe(REWORK_NOTE_MAX_LENGTH)
  })

  it('rejects an extra key on the action', () => {
    expect(parseActionEnvelope({ requestId: 'r7', action: { kind: 'rework', taskId: 't', note: 'n', extra: 1 } })).toBeUndefined()
  })

  it('rejects an import row with a malformed execution flag or note entry', () => {
    expect(importEnvelope([{ ...importRow, executions: [{ id: 'e', startedAt: 1, rework: 'yes' }] }])).toBeUndefined()
    expect(importEnvelope([{ ...importRow, reworkNotes: [{ note: 1, at: 2 }] }])).toBeUndefined()
    expect(importEnvelope([{ ...importRow, reworkNotes: [{ note: 'n', at: 1, consumedAt: 'x' }] }])).toBeUndefined()
  })

  it('accepts valid import rows and carries the true rework flag (the history itself is not imported)', () => {
    const flagged = importEnvelope([{ ...importRow, executions: [{ id: 'e', startedAt: 1, endedAt: 2, result: 'succeeded', rework: true }] }])
    expect(flagged?.action.kind === 'import' ? flagged.action.tasks[0].executions[0].rework : undefined).toBe(true)
    const noted = importEnvelope([{ ...importRow, reworkNotes: [{ note: 'n', at: 1 }] }])
    expect(noted?.action.kind === 'import').toBe(true)
    expect(noted?.action.kind === 'import' ? noted!.action.tasks[0].reworkNotes : 'absent').toBeUndefined()
  })
})

describe('HostTaskLedger rework flow', () => {
  let dir: string
  let ledger: HostTaskLedger

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-rework-'))
    ledger = new HostTaskLedger(dir, () => NOW, { maxConcurrency: 1 })
  })

  afterEach(() => {
    // Every assertion must leave the ledger usable for the next test:
    // settle any open execution so later tests do not trip the running guard.
    for (const task of ledger.state().tasks) {
      for (const execution of task.executions) {
        if (execution.endedAt === undefined) ledger.settle(task.id, execution.id, 'succeeded')
      }
    }
  })

  function settleTask(id: string, outcome: 'succeeded' | 'failed' = 'succeeded'): string {
    const { run } = ledger.applyRequest(`run-${id}`, { kind: 'run', taskId: id })
    ledger.settle(id, run!.execution.id, outcome)
    return run!.execution.id
  }

  it('opens a rework execution and appends the rejection note to the card', () => {
    ledger.applyRequest('cr-a', { kind: 'create', id: 'ok', input: { title: 'OK', description: '', prompt: 'p' } })
    settleTask('ok')
    const { run } = ledger.applyRequest('rw-a', { kind: 'rework', taskId: 'ok', note: 'the report misses the totals' })
    const task = ledger.state().tasks.find(entry => entry.id === 'ok')!
    expect(task.status).toBe('running')
    expect(run?.execution.rework).toBe(true)
    expect(task.reworkNotes).toEqual([{ note: 'the report misses the totals', at: NOW }])
    expect(hasPendingRework(task)).toBe(true)
  })

  it('refuses rework of a card that is not settled yet', () => {
    ledger.applyRequest('cr-b', { kind: 'create', id: 'fresh', input: { title: 'Fresh', description: '', prompt: 'p' } })
    expect(() => ledger.applyRequest('rw-b', { kind: 'rework', taskId: 'fresh', note: 'n' }))
      .toThrow('task is not in a settled state')
    expect(ledger.state().tasks.find(task => task.id === 'fresh')?.reworkNotes).toBeUndefined()
  })

  it('refuses rework of a running card', () => {
    ledger.applyRequest('cr-c', { kind: 'create', id: 'busy', input: { title: 'Busy', description: '', prompt: 'p' } })
    ledger.applyRequest('run-c', { kind: 'run', taskId: 'busy' })
    expect(() => ledger.applyRequest('rw-c', { kind: 'rework', taskId: 'busy', note: 'n' }))
      .toThrow('task is already running or missing')
  })

  it('refuses rework of an archived card', () => {
    ledger.applyRequest('cr-d', { kind: 'create', id: 'gone', input: { title: 'Gone', description: '', prompt: 'p' } })
    settleTask('gone')
    ledger.applyRequest('ar-d', { kind: 'archive', taskId: 'gone' })
    expect(() => ledger.applyRequest('rw-d', { kind: 'rework', taskId: 'gone', note: 'n' }))
      .toThrow('archived task is read-only')
  })

  it('refuses rework while the permission confirmation or a dependency gate is open', () => {
    ledger.applyRequest('cr-e', { kind: 'create', id: 'elev', input: { title: 'Elev', description: '', prompt: 'p', permission: 'danger-full-access' } })
    ledger.applyRequest('mv-e1', { kind: 'move', taskId: 'elev', status: 'done' })
    expect(() => ledger.applyRequest('rw-e1', { kind: 'rework', taskId: 'elev', note: 'n' }))
      .toThrow('confirmation-required')
    ledger.applyRequest('cr-e2', { kind: 'create', id: 'gate-parent', input: { title: 'Gate Parent', description: '', prompt: 'p' } })
    ledger.applyRequest('cr-e3', {
      kind: 'create',
      id: 'gate-child',
      input: { title: 'Gate Child', description: '', prompt: 'p', parentIds: ['gate-parent'] },
    })
    ledger.applyRequest('mv-e4', { kind: 'move', taskId: 'gate-child', status: 'done' })
    expect(() => ledger.applyRequest('rw-e2', { kind: 'rework', taskId: 'gate-child', note: 'n' }))
      .toThrow('dependency-gate')
  })

  it('reworks a failed card the same way (the rejection applies to any settled attempt)', () => {
    ledger.applyRequest('cr-f', { kind: 'create', id: 'boom', input: { title: 'Boom', description: '', prompt: 'p' } })
    settleTask('boom', 'failed')
    expect(ledger.state().tasks.find(task => task.id === 'boom')?.status).toBe('failed')
    const { run } = ledger.applyRequest('rw-f', { kind: 'rework', taskId: 'boom', note: 'retry with the flag' })
    expect(run?.execution.rework).toBe(true)
    expect(ledger.state().tasks.find(task => task.id === 'boom')?.status).toBe('running')
  })

  it('parks at the concurrency cap: the note stays unconsumed until a slot frees', () => {
    ledger.applyRequest('cr-g', { kind: 'create', id: 'filler', input: { title: 'Filler', description: '', prompt: 'p' } })
    ledger.applyRequest('cr-h', { kind: 'create', id: 'parked', input: { title: 'Parked', description: '', prompt: 'p' } })
    ledger.applyRequest('run-g', { kind: 'run', taskId: 'filler' })
    ledger.applyRequest('mv-h', { kind: 'move', taskId: 'parked', status: 'done' })
    // One open execution out of one slot: the rework parks instead of opening.
    const result = ledger.applyRequest('rw-g', { kind: 'rework', taskId: 'parked', note: 'fix the edges' })
    const parked = ledger.state().tasks.find(task => task.id === 'parked')!
    expect(result.run).toBeUndefined()
    expect(parked.status).toBe('todo')
    expect(parked.reworkNotes).toEqual([{ note: 'fix the edges', at: NOW }])
    expect(parked.executions).toEqual([])
    // The slot frees: the next dispatcher (manual run) picks the note up.
    ledger.settle('filler', ledger.state().tasks.find(task => task.id === 'filler')!.executions[0].id, 'succeeded')
    const { run: rerun } = ledger.applyRequest('run-h', { kind: 'run', taskId: 'parked' })
    expect(rerun?.execution.rework).toBe(true)
    expect(rerun?.task.status).toBe('running')
    // The prompt queued: consume the round.
    ledger.consumeRework('parked', rerun!.execution.id)
    expect(ledger.state().tasks.find(task => task.id === 'parked')?.reworkNotes)
      .toEqual([{ note: 'fix the edges', at: NOW, consumedAt: NOW }])
    expect(hasPendingRework(ledger.state().tasks.find(task => task.id === 'parked')!)).toBe(false)
  })

  it('consumeRework is a no-op for non-rework executions and already-consumed cards', () => {
    ledger.applyRequest('cr-i', { kind: 'create', id: 'plain', input: { title: 'Plain', description: '', prompt: 'p' } })
    const plainId = settleTask('plain')
    expect(() => {
      ledger.consumeRework('plain', plainId)
      expect(ledger.state().tasks.find(task => task.id === 'plain')?.reworkNotes).toBeUndefined()
    }).not.toThrow()
    ledger.applyRequest('cr-j', { kind: 'create', id: 'twice', input: { title: 'Twice', description: '', prompt: 'p' } })
    settleTask('twice')
    const first = ledger.applyRequest('rw-j1', { kind: 'rework', taskId: 'twice', note: 'round one' })
    ledger.consumeRework('twice', first.run!.execution.id)
    const revision = ledger.summary().revision
    ledger.consumeRework('twice', first.run!.execution.id)
    expect(ledger.summary().revision).toBe(revision)
    expect(ledger.state().tasks.find(task => task.id === 'twice')?.reworkNotes)
      .toEqual([{ note: 'round one', at: NOW, consumedAt: NOW }])
  })

  it('exposes the rework marker on the runtime view the session monitor polls', () => {
    ledger.applyRequest('cr-k', { kind: 'create', id: 'view', input: { title: 'View', description: '', prompt: 'p' } })
    settleTask('view')
    const { run } = ledger.applyRequest('rw-k', { kind: 'rework', taskId: 'view', note: 'n' })
    const reference = ledger.runtimeView().openExecutions.find(entry => entry.executionId === run!.execution.id)
    expect(reference?.rework).toBe(true)
  })
})
