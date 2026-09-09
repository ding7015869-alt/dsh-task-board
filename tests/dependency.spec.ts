/**
 * Dependency-gate tests: parentIds normalization, the pure gate helpers,
 * bidirectional edge maintenance in the update/delete use cases, store and
 * protocol validation, and the Host ledger's run/schedule enforcement.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  childTasks, createTask, isTaskOpen, normalizeParentIds, pendingParentTasks, taskGateNote, type TaskRecord,
} from '../src/core/tasks.ts'
import { parseLedger } from '../src/core/store.ts'
import { parseActionEnvelope } from '../src/protocol.ts'
import { applyCreateTask } from '../src/core/use-cases/task-create.ts'
import { applyDeleteTask } from '../src/core/use-cases/task-delete.ts'
import { applyUpdateTask } from '../src/core/use-cases/task-update.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'

const NOW = 1_700_000_000_000

function makeTask(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const task = createTask({ title: id.toUpperCase(), description: '', prompt: id }, NOW, id)
  return { ...task, ...overrides }
}

describe('normalizeParentIds', () => {
  it('dedups, drops blanks, and keeps first-seen order', () => {
    expect(normalizeParentIds(['a', '', 'a', 'b', 'a'])).toEqual(['a', 'b'])
  })

  it('excludes the task itself', () => {
    expect(normalizeParentIds(['self', 'a'], 'self')).toEqual(['a'])
  })

  it('is undefined-friendly (older input shapes)', () => {
    expect(normalizeParentIds(undefined)).toEqual([])
    expect(normalizeParentIds(undefined, 'x')).toEqual([])
  })
})

describe('createTask', () => {
  it('defaults to an empty parent list', () => {
    expect(createTask({ title: 'T', description: '', prompt: 'P' }, NOW, 't1').parentIds).toEqual([])
  })

  it('stores a normalized parentIds list on creation', () => {
    const task = createTask({ title: 'T', description: '', prompt: 'P', parentIds: ['p1', 'p1', 'p2'] }, NOW, 't1')
    expect(task.parentIds).toEqual(['p1', 'p2'])
  })

  it('normalizes a self-reference away', () => {
    const task = createTask({ title: 'T', description: '', prompt: 'P', parentIds: ['self', 'p1'] }, NOW, 'self')
    expect(task.parentIds).toEqual(['p1'])
  })
})

describe('gate helpers', () => {
  const parent = makeTask('p1', { status: 'done' })
  const pendingParent = makeTask('p2', { status: 'todo' })
  const child = makeTask('c1', { parentIds: ['p1', 'p2'] })

  it('derives parents and the reverse child edge', () => {
    const tasks = [parent, pendingParent, child]
    expect(childTasks(parent, tasks).map(task => task.id)).toContain('c1')
    expect(childTasks(pendingParent, tasks).map(task => task.id)).toContain('c1')
    expect(childTasks(child, tasks)).toEqual([])
  })

  it('is closed while any existing parent has not settled to done', () => {
    expect(pendingParentTasks(child, [parent, pendingParent, child])).toEqual([pendingParent])
    expect(isTaskOpen(child, [parent, pendingParent, child])).toBe(false)
    expect(taskGateNote(child, [parent, pendingParent, child])).toBe('P2')
  })

  it('is open when every parent is done', () => {
    const doneParent = makeTask('p2', { status: 'done' })
    const open = makeTask('c1', { parentIds: ['p1', 'p2'] })
    expect(isTaskOpen(open, [parent, doneParent, open])).toBe(true)
    expect(taskGateNote(open, [parent, doneParent, open])).toBeUndefined()
  })

  it('ignores parents that no longer exist (fail-open)', () => {
    const orphan = makeTask('c1', { parentIds: ['ghost'] })
    expect(isTaskOpen(orphan, [orphan])).toBe(true)
    expect(taskGateNote(orphan, [orphan])).toBeUndefined()
  })

  it('is open with no parents at all', () => {
    const bare = makeTask('c1')
    expect(isTaskOpen(bare, [bare])).toBe(true)
  })
})

describe('applyUpdateTask dependency edges', () => {
  it('rewrites the child set on the child tasks in one transition', () => {
    const a = makeTask('a')
    const b = makeTask('b')
    const c = makeTask('c')
    const next = applyUpdateTask([a, b, c], 'a', { childIds: ['b', 'c'] }, NOW + 1)
    const [na, nb, nc] = next
    expect(na.parentIds).toEqual([])
    expect(nb.parentIds).toEqual(['a'])
    expect(nc.parentIds).toEqual(['a'])
    expect(nb.updatedAt).toBe(NOW + 1)
    // The untouched reference check: no edge change, no new row.
    const noChange = applyUpdateTask([a, b, c], 'a', { childIds: [] }, NOW + 1)
    expect(noChange[1]).toBe(b)
    expect(noChange[2]).toBe(c)
  })

  it('removes a child edge when the set no longer lists it', () => {
    const a = makeTask('a')
    const b = makeTask('b', { parentIds: ['a'] })
    const c = makeTask('c', { parentIds: ['a'] })
    const next = applyUpdateTask([a, b, c], 'a', { childIds: ['b'] }, NOW + 1)
    expect(next[1].parentIds).toEqual(['a'])
    expect(next[2].parentIds).toEqual([])
  })

  it('clears the whole child set on null', () => {
    const a = makeTask('a')
    const b = makeTask('b', { parentIds: ['a', 'x'] })
    const next = applyUpdateTask([a, b], 'a', { childIds: null }, NOW + 1)
    expect(next[1].parentIds).toEqual(['x'])
  })

  it('replaces the task parentIds and clears on null', () => {
    const p1 = makeTask('p1', { status: 'done' })
    const p2 = makeTask('p2')
    const t = makeTask('t', { parentIds: ['p1'] })
    const set = applyUpdateTask([p1, p2, t], 't', { parentIds: ['p2'] }, NOW + 1)
    expect(set[2].parentIds).toEqual(['p2'])
    const cleared = applyUpdateTask([p1, p2, t], 't', { parentIds: null }, NOW + 1)
    expect(cleared[2].parentIds).toEqual([])
  })

  it('excludes the task itself from a replaced set', () => {
    const t = makeTask('t', { parentIds: ['t'] })
    const next = applyUpdateTask([t], 't', { parentIds: ['t', 'p1'] }, NOW + 1)
    expect(next[0].parentIds).toEqual(['p1'])
  })

  it('does not leak the edge keys onto the task row', () => {
    const p1 = makeTask('p1')
    const t = makeTask('t')
    const next = applyUpdateTask([p1, t], 't', { parentIds: ['p1'], childIds: ['p1'] }, NOW + 1)
    const row = next[1] as TaskRecord & Record<string, unknown>
    expect(row).not.toHaveProperty('childIds')
    expect(row.parentIds).toEqual(['p1'])
  })
})

describe('applyCreateTask / applyDeleteTask edges', () => {
  it('creates tasks carrying parents', () => {
    const parent = makeTask('p1', { status: 'done' })
    const result = applyCreateTask([parent], { title: 'child', description: '', prompt: 'c', parentIds: ['p1', 'p1'] }, NOW, 'c1')
    expect(result.task?.parentIds).toEqual(['p1'])
    expect(result.tasks).toHaveLength(2)
  })

  it('strips the deleted id from every other task parent list', () => {
    const p1 = makeTask('p1')
    const c1 = makeTask('c1', { parentIds: ['p1', 'keep'] })
    const c2 = makeTask('c2', { parentIds: ['p1'] })
    const other = makeTask('o', { parentIds: ['keep'] })
    const result = applyDeleteTask([p1, c1, c2, other], 'c1', 'p1', NOW + 1)
    expect(result.tasks.map(task => task.id)).toEqual(['c1', 'c2', 'o'])
    const [nc1, nc2, nother] = result.tasks
    expect(nc1.parentIds).toEqual(['keep'])
    expect(nc2.parentIds).toEqual([])
    expect(nother).toBe(other)
    expect(nc1.updatedAt).toBe(NOW + 1)
  })
})

describe('parseLedger dependency normalization', () => {
  const row = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    title: id.toUpperCase(),
    description: '',
    prompt: id,
    createdAt: NOW,
    updatedAt: NOW,
    status: 'todo',
    executions: [],
    ...extra,
  })

  it('defaults a missing parentIds to an empty list', () => {
    const [task] = parseLedger(JSON.stringify([row('a')]))
    expect(task.parentIds).toEqual([])
  })

  it('normalizes a persisted parentIds list', () => {
    const [task] = parseLedger(JSON.stringify([row('a', { parentIds: ['a', '', 'b', 'b'] })]))
    expect(task.parentIds).toEqual(['b'])
  })

  it('drops a row with a malformed parentIds shape', () => {
    expect(parseLedger(JSON.stringify([row('a', { parentIds: 5 })]))).toEqual([])
    expect(parseLedger(JSON.stringify([row('a', { parentIds: ['ok', 3] })]))).toEqual([])
  })
})

describe('protocol dependency validation', () => {
  it('accepts a create input with parentIds', () => {
    const envelope = parseActionEnvelope({
      requestId: 'r1',
      action: {
        kind: 'create',
        id: 'c1',
        input: { title: 'child', description: '', prompt: 'c', parentIds: ['p1', 'p2'] },
      },
    })
    expect(envelope?.action.kind === 'create' && (envelope.action as { input: { parentIds?: unknown } }).input.parentIds).toEqual(['p1', 'p2'])
  })

  it('rejects a create input with a malformed parentIds', () => {
    expect(parseActionEnvelope({
      requestId: 'r2',
      action: { kind: 'create', id: 'c1', input: { title: 't', description: '', prompt: 'p', parentIds: 'nope' } },
    })).toBeUndefined()
    expect(parseActionEnvelope({
      requestId: 'r3',
      action: { kind: 'create', id: 'c1', input: { title: 't', description: '', prompt: 'p', parentIds: [1] } },
    })).toBeUndefined()
  })

  it('accepts an update patch with parentIds / childIds (array or null)', () => {
    const set = parseActionEnvelope({
      requestId: 'r4',
      action: { kind: 'update', taskId: 'a', patch: { parentIds: ['p1'], childIds: ['c1'] } },
    })
    expect(set?.action.kind === 'update' && 'parentIds' in set.action.patch).toBe(true)
    const clear = parseActionEnvelope({
      requestId: 'r5',
      action: { kind: 'update', taskId: 'a', patch: { parentIds: null, childIds: null } },
    })
    expect(clear?.action.kind === 'update').toBe(true)
  })

  it('rejects an update patch with a malformed edge key', () => {
    expect(parseActionEnvelope({
      requestId: 'r6',
      action: { kind: 'update', taskId: 'a', patch: { parentIds: 7 } },
    })).toBeUndefined()
    expect(parseActionEnvelope({
      requestId: 'r7',
      action: { kind: 'update', taskId: 'a', patch: { childIds: ['ok', 3] } },
    })).toBeUndefined()
  })
})

describe('HostTaskLedger dependency gate', () => {
  let dir: string
  let ledger: HostTaskLedger

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-dep-'))
    ledger = new HostTaskLedger(dir, () => NOW, {})
  })

  afterEach(() => {
    // Every gate assertion must leave the ledger usable for the next test:
    // settle any open execution so later tests do not trip the running guard.
    for (const task of ledger.state().tasks) {
      for (const execution of task.executions) {
        if (execution.endedAt === undefined) ledger.settle(task.id, execution.id, 'succeeded')
      }
    }
  })

  it('refuses a run while a parent task has not settled to done', () => {
    ledger.applyRequest('d1', { kind: 'create', id: 'parent', input: { title: 'Parent', description: '', prompt: 'p' } })
    ledger.applyRequest('d2', {
      kind: 'create',
      id: 'child',
      input: { title: 'Child', description: '', prompt: 'c', parentIds: ['parent'] },
    })
    expect(() => ledger.applyRequest('d3', { kind: 'run', taskId: 'child' })).toThrow('dependency-gate')
    // The rejected request is not recorded (no partial state).
    expect(ledger.state().tasks.find(task => task.id === 'child')?.status).toBe('todo')
  })

  it('opens a run after every parent has settled', () => {
    const { run } = ledger.applyRequest('d4', { kind: 'run', taskId: 'parent' })
    expect(run?.task.id).toBe('parent')
    ledger.settle('parent', run!.execution.id, 'succeeded')
    const { run: childRun } = ledger.applyRequest('d5', { kind: 'run', taskId: 'child' })
    expect(childRun?.task.id).toBe('child')
    // Rerun of a gated task is gated the same way (parent now done -> open).
    expect(childRun?.task.status).toBe('running')
  })

  it('skips a due occurrence while gated and retries once the parent settles', () => {
    ledger.applyRequest('d6', { kind: 'create', id: 'gated-parent', input: { title: 'Gated Parent', description: '', prompt: 'gp' } })
    ledger.applyRequest('d7', {
      kind: 'create',
      id: 'gated-child',
      input: { title: 'Gated Child', description: '', prompt: 'g', parentIds: ['gated-parent'], schedule: { enabled: true, cron: '0 9 * * *' } },
    })
    const due = ledger.state().tasks.find(task => task.id === 'gated-child')!.schedule!.nextRunAt!
    // The parent is still todo -> the due occurrence is skipped (undefined).
    expect(ledger.openScheduled('gated-child', due, NOW + 1000)).toBeUndefined()
    // Settle the parent to done; the gate now opens and the occurrence runs.
    const { run: parentRun } = ledger.applyRequest('d8', { kind: 'run', taskId: 'gated-parent' })
    ledger.settle('gated-parent', parentRun!.execution.id, 'succeeded')
    const opened = ledger.openScheduled('gated-child', due, NOW + 2000)
    expect(opened?.task.id).toBe('gated-child')
    expect(opened?.task.status).toBe('running')
  })

  it('deleting a parent task cannot wedge its children (fail-open)', () => {
    ledger.applyRequest('d9', { kind: 'create', id: 'orphan-child', input: { title: 'Orphan Child', description: '', prompt: 'o', parentIds: ['parent'] } })
    // Parent 'parent' settled to done in an earlier test: open.
    const { run } = ledger.applyRequest('d10', { kind: 'run', taskId: 'orphan-child' })
    expect(run?.task.id).toBe('orphan-child')
    ledger.settle('orphan-child', run!.execution.id, 'succeeded')
    // Now remove a fresh parent and prove the dangling id never wedges.
    ledger.applyRequest('d11', { kind: 'create', id: 'doomed', input: { title: 'Doomed', description: '', prompt: 'd' } })
    ledger.applyRequest('d12', { kind: 'create', id: 'late-child', input: { title: 'Late Child', description: '', prompt: 'l', parentIds: ['doomed', 'parent'] } })
    ledger.applyRequest('d13', { kind: 'delete', taskId: 'doomed' })
    const late = ledger.state().tasks.find(task => task.id === 'late-child')!
    expect(late.parentIds).toEqual(['parent'])
    // 'parent' is done -> the surviving edge is satisfied, the run opens.
    expect(ledger.applyRequest('d14', { kind: 'run', taskId: 'late-child' }).run?.task.id).toBe('late-child')
  })
})
