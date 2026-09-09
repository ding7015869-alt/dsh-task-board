/**
 * Card-serial tests: the stable "#N" number the Host ledger mints per task —
 * backfill on load for older documents, monotonic minting at create, no reuse
 * after deletion, import carry-over, store/protocol validation, and the
 * board filter's exact `#N` match.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { parseLedger } from '../src/core/store.ts'
import { assignMissingSerials, HostTaskLedger } from '../src/host-ledger.ts'
import { matchesFilter } from '../src/client/board/TaskBoard.tsx'

const NOW = 1_700_000_000_000

function makeTask(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const task = createTask({ title: id.toUpperCase(), description: '', prompt: id }, NOW, id)
  return { ...task, ...overrides }
}

function input(title: string) {
  return { title, description: '', prompt: title }
}

describe('assignMissingSerials', () => {
  it('numbers serial-less tasks in creation order', () => {
    const tasks = [
      makeTask('c', { createdAt: NOW + 2_000 }),
      makeTask('a', { createdAt: NOW }),
      makeTask('b', { createdAt: NOW + 1_000 }),
    ]
    const next = assignMissingSerials(tasks, 1)
    const byId = new Map(tasks.map(task => [task.id, task.serial]))
    expect(byId.get('a')).toBe(1)
    expect(byId.get('b')).toBe(2)
    expect(byId.get('c')).toBe(3)
    expect(next).toBe(4)
  })

  it('keeps valid serials and only fills the gaps after them', () => {
    const tasks = [
      makeTask('old', { createdAt: NOW, serial: 7 }),
      makeTask('new', { createdAt: NOW + 1_000 }),
    ]
    const next = assignMissingSerials(tasks, 7)
    expect(tasks[1].serial).toBe(7 + 1)
    expect(next).toBe(9)
  })

  it('never issues below the start point (no re-issued numbers after deletion)', () => {
    const tasks = [makeTask('fresh', { createdAt: NOW })]
    // nextSerial 41 means 1..40 were already issued (some deleted since).
    const next = assignMissingSerials(tasks, 41)
    expect(tasks[0].serial).toBe(41)
    expect(next).toBe(42)
  })

  it('drops invalid serials (zero / negative / non-integer) and re-mints', () => {
    const tasks = [
      makeTask('zero', { createdAt: NOW, serial: 0 }),
      makeTask('neg', { createdAt: NOW + 1_000, serial: -3 }),
      makeTask('float', { createdAt: NOW + 2_000, serial: 1.5 }),
    ]
    const next = assignMissingSerials(tasks, 1)
    expect(tasks[0].serial).toBe(1)
    expect(tasks[1].serial).toBe(2)
    expect(tasks[2].serial).toBe(3)
    expect(next).toBe(4)
  })

  it('re-mints duplicated serials so no two cards wear the same number', () => {
    const tasks = [
      makeTask('first', { createdAt: NOW, serial: 5 }),
      makeTask('second', { createdAt: NOW + 1_000, serial: 5 }),
    ]
    const next = assignMissingSerials(tasks, 1)
    expect(tasks[0].serial).toBe(5)
    expect(tasks[1].serial).toBe(6)
    expect(next).toBe(7)
  })
})

describe('parseLedger serial normalization', () => {
  it('keeps a valid positive-integer serial', () => {
    const [task] = parseLedger(JSON.stringify([makeTask('t', { serial: 12 })]))
    expect(task.serial).toBe(12)
  })

  it('clears invalid serials instead of dropping the task row', () => {
    const [task] = parseLedger(JSON.stringify([makeTask('t', { serial: 1.5 })]))
    expect(task.serial).toBeUndefined()
  })
})

describe('HostTaskLedger serial minting', () => {
  let dir: string
  let ledger: HostTaskLedger | undefined

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-serial-'))
  })

  afterEach(() => {
    if (ledger !== undefined) ledger.dispose()
    ledger = undefined
  })

  it('backfills serials on an older document that has none', () => {
    const olderDir = join(dir, 'older')
    mkdirSync(olderDir, { recursive: true })
    const tasks = [
      makeTask('newer', { createdAt: NOW + 1_000 }),
      makeTask('older', { createdAt: NOW }),
    ]
    writeFileSync(join(olderDir, 'ledger-v2.json'), JSON.stringify({
      schemaVersion: 3,
      revision: 2,
      tasks: JSON.parse(JSON.stringify(tasks)),
      scheduler: { timeZone: 'UTC', ledgerId: 'older-ledger' },
      recentRequests: [],
    }))
    const legacy = new HostTaskLedger(olderDir, () => NOW, {})
    try {
      const state = legacy.state()
      const byId = new Map(state.tasks.map(task => [task.id, task.serial]))
      // Creation order: "older" gets #1, "newer" gets #2.
      expect(byId.get('older')).toBe(1)
      expect(byId.get('newer')).toBe(2)
      expect(state.nextSerial).toBe(3)
    } finally {
      legacy.dispose()
    }
  })

  it('mints monotonic serials at create and never re-issues after delete', () => {
    ledger = new HostTaskLedger(dir, () => NOW, {})
    const r1 = ledger.applyRequest('s1', { kind: 'create', id: 'a', input: input('A') })
    const r2 = ledger.applyRequest('s2', { kind: 'create', id: 'b', input: input('B') })
    expect(r1.state.tasks[0].serial).toBe(1)
    expect(r2.state.tasks.find(task => task.id === 'b')?.serial).toBe(2)
    ledger.applyRequest('s3', { kind: 'delete', taskId: 'a' })
    const r4 = ledger.applyRequest('s4', { kind: 'create', id: 'c', input: input('C') })
    // #1 was deleted with task "a" — it is not handed out again.
    const created = r4.state.tasks.find(task => task.id === 'c')
    expect(created?.serial).toBe(3)
    expect(r4.state.tasks.find(task => task.id === 'b')?.serial).toBe(2)
    expect(r4.state.nextSerial).toBe(4)
  })

  it('backfills imported rows from the current mint point', () => {
    const importDir = join(dir, 'import-fresh')
    ledger = new HostTaskLedger(importDir, () => NOW, {})
    const imported = JSON.parse(JSON.stringify([makeTask('x', { createdAt: NOW })]))
    const result = ledger.applyRequest('s5', { kind: 'import', sourceId: 'legacy-browser', tasks: imported })
    expect(result.state.tasks[0].serial).toBe(1)
    expect(result.state.tasks[0].id).toBe('x')
  })

  it('keeps a valid serial that rides an import, without re-issuing numbers', () => {
    const importDir = join(dir, 'import')
    mkdirSync(importDir, { recursive: true })
    writeFileSync(join(importDir, 'ledger-v2.json'), JSON.stringify({
      schemaVersion: 3,
      revision: 0,
      tasks: [],
      nextSerial: 10,
      scheduler: { timeZone: 'UTC', ledgerId: 'import-ledger' },
      recentRequests: [],
    }))
    const target = new HostTaskLedger(importDir, () => NOW, {})
    try {
      // The source ledger had already issued serials 1..5 (task #3 rides the
      // import; #1/#2/#4/#5 were deleted there).
      const withSerial = JSON.parse(JSON.stringify([makeTask('kept', { createdAt: NOW, serial: 3 })]))
      const result = target.applyRequest('i1', { kind: 'import', sourceId: 'other-host', tasks: withSerial })
      expect(result.state.tasks[0].serial).toBe(3)
      // The target never drops back below its own mint point (#10).
      expect(result.state.nextSerial).toBe(10)
      const created = target.applyRequest('i2', { kind: 'create', id: 'next', input: input('Next') })
      expect(created.state.tasks[1].serial).toBe(10)
    } finally {
      target.dispose()
    }
  })
})

describe('board filter `#N` serial match', () => {
  it('locates a card exactly by its serial number', () => {
    const task = makeTask('t', { serial: 12 })
    expect(matchesFilter(task, '#12')).toBe(true)
    expect(matchesFilter(task, '#12 ')).toBe(true)
    expect(matchesFilter(task, ' # 12')).toBe(true)
    expect(matchesFilter(task, '#13')).toBe(false)
    expect(matchesFilter(task, '#1')).toBe(false) // prefix, not a match
    expect(matchesFilter(task, '#012')).toBe(true) // numeric value, same card
  })

  it('leaves substring filtering untouched for non-serial queries', () => {
    const task = makeTask('deploy site', { serial: 3, title: 'Deploy the site' })
    expect(matchesFilter(task, 'deploy')).toBe(true)
    expect(matchesFilter(task, 'absent')).toBe(false)
    expect(matchesFilter(task, '')).toBe(true)
  })
})
