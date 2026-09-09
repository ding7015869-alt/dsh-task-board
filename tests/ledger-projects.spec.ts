/**
 * Host ledger project tests (ledger v4): the v2/v3 to v4 migration (project
 * seeding + task projectId backfill with serials untouched), create/import
 * stamping, the delete-project card reassignment, and the corrupt-recovery
 * default-project seed.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { DEFAULT_PROJECT_ID, PROJECT_COLORS, type ProjectRecord } from '../src/core/projects.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'

const NOW = 1_700_000_000_000

function makeTask(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const task = createTask({ title: id.toUpperCase(), description: '', prompt: id }, NOW, id)
  return { ...task, ...overrides }
}

function input(title: string) {
  return { title, description: '', prompt: title }
}

function project(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return { id, name: id, color: PROJECT_COLORS[0], createdAt: NOW, updatedAt: NOW, ...overrides }
}

function seed(dir: string, document: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ledger-v2.json'), JSON.stringify(document))
}

function schedulerDocument(): Record<string, unknown> {
  return { timeZone: 'UTC', ledgerId: 'test-ledger' }
}

describe('HostTaskLedger project migration (v4)', () => {
  let dir: string
  let ledger: HostTaskLedger | undefined

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-projects-'))
  })

  afterEach(() => {
    if (ledger !== undefined) ledger.dispose()
    ledger = undefined
  })

  it('upgrades a v3 document: seeds the default project and backfills unowned cards, serials untouched', () => {
    const sub = join(dir, 'v3')
    seed(sub, {
      schemaVersion: 3,
      revision: 5,
      tasks: [makeTask('a', { serial: 1 }), makeTask('b', { serial: 2, createdAt: NOW + 1_000 })],
      nextSerial: 3,
      scheduler: schedulerDocument(),
      recentRequests: [],
    })
    const upgraded = new HostTaskLedger(sub, () => NOW, {})
    try {
      const state = upgraded.state()
      expect(state.projects.map(item => item.id)).toEqual([DEFAULT_PROJECT_ID])
      expect(state.projects[0].name).toBe('Default')
      const byId = new Map(state.tasks.map(task => [task.id, task]))
      expect(byId.get('a')?.projectId).toBe(DEFAULT_PROJECT_ID)
      expect(byId.get('b')?.projectId).toBe(DEFAULT_PROJECT_ID)
      // The migration never touches the numbering layer.
      expect(byId.get('a')?.serial).toBe(1)
      expect(byId.get('b')?.serial).toBe(2)
      expect(state.nextSerial).toBe(3)
    } finally {
      upgraded.dispose()
    }
  })

  it('upgrades a v2 legacy document the same way', () => {
    const sub = join(dir, 'v2')
    seed(sub, {
      schemaVersion: 2,
      revision: 0,
      tasks: [makeTask('legacy', { createdAt: NOW })],
      scheduler: schedulerDocument(),
      recentRequests: [],
    })
    const upgraded = new HostTaskLedger(sub, () => NOW, {})
    try {
      const state = upgraded.state()
      expect(state.projects.map(item => item.id)).toEqual([DEFAULT_PROJECT_ID])
      expect(state.tasks[0].projectId).toBe(DEFAULT_PROJECT_ID)
      // The legacy document had no counter: the serial is backfilled from
      // creation order and the mint point follows it.
      expect(state.tasks[0].serial).toBe(1)
      expect(state.nextSerial).toBe(2)
    } finally {
      upgraded.dispose()
    }
  })

  it('keeps a v4 project list and backfills dangling task references on load', () => {
    const sub = join(dir, 'v4')
    seed(sub, {
      schemaVersion: 4,
      revision: 9,
      tasks: [
        makeTask('kept', { serial: 4, projectId: 'work' }),
        makeTask('lost', { serial: 5, projectId: 'ghost' }),
        makeTask('bare', { serial: 6 }),
      ],
      projects: [project(DEFAULT_PROJECT_ID), project('work', { color: PROJECT_COLORS[2] })],
      nextSerial: 7,
      scheduler: schedulerDocument(),
      recentRequests: [],
    })
    const loaded = new HostTaskLedger(sub, () => NOW, {})
    try {
      const state = loaded.state()
      expect(state.projects.map(item => item.id)).toEqual([DEFAULT_PROJECT_ID, 'work'])
      const byId = new Map(state.tasks.map(task => [task.id, task]))
      expect(byId.get('kept')?.projectId).toBe('work')
      expect(byId.get('lost')?.projectId).toBe(DEFAULT_PROJECT_ID)
      expect(byId.get('bare')?.projectId).toBe(DEFAULT_PROJECT_ID)
      expect(state.nextSerial).toBe(7)
    } finally {
      loaded.dispose()
    }
  })

  it('seeds the default project when a corrupt document is quarantined', () => {
    const sub = join(dir, 'corrupt')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'ledger-v2.json'), '{not json')
    const recovered = new HostTaskLedger(sub, () => NOW, {})
    try {
      const state = recovered.state()
      expect(state.tasks).toHaveLength(0)
      expect(state.projects.map(item => item.id)).toEqual([DEFAULT_PROJECT_ID])
      expect(state.nextSerial).toBe(1)
    } finally {
      recovered.dispose()
    }
  })
})

describe('HostTaskLedger project actions', () => {
  let dir: string
  let ledger: HostTaskLedger | undefined

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-project-actions-'))
  })

  afterEach(() => {
    if (ledger !== undefined) ledger.dispose()
    ledger = undefined
  })

  it('creates a project with the next free color and stamps created tasks to it', () => {
    ledger = new HostTaskLedger(join(dir, 'create'), () => NOW, {})
    const created = ledger.applyRequest('p1', { kind: 'create-project', id: 'work', name: 'Work' })
    const project = created.state.projects.find(item => item.id === 'work')
    expect(project?.color).toBe(PROJECT_COLORS[1]) // c1 belongs to the default project

    const owned = ledger.applyRequest('p2', { kind: 'create', id: 't1', input: { ...input('T1'), projectId: 'work' } })
    expect(owned.state.tasks.find(task => task.id === 't1')?.projectId).toBe('work')

    // A dangling pin lands in the default project; the serial is still minted.
    const dangling = ledger.applyRequest('p3', { kind: 'create', id: 't2', input: { ...input('T2'), projectId: 'ghost' } })
    expect(dangling.state.tasks.find(task => task.id === 't2')?.projectId).toBe(DEFAULT_PROJECT_ID)
    expect(dangling.state.tasks.find(task => task.id === 't2')?.serial).toBe(2)
    expect(dangling.state.nextSerial).toBe(3)
  })

  it('renames and recolors projects', () => {
    ledger = new HostTaskLedger(join(dir, 'rename'), () => NOW, {})
    ledger.applyRequest('p1', { kind: 'create-project', id: 'work', name: 'Work' })
    const renamed = ledger.applyRequest('p2', { kind: 'rename-project', projectId: 'work', name: 'Streaming' })
    expect(renamed.state.projects.find(item => item.id === 'work')?.name).toBe('Streaming')
    const recolored = ledger.applyRequest('p3', { kind: 'set-project-color', projectId: 'work', color: PROJECT_COLORS[6] })
    expect(recolored.state.projects.find(item => item.id === 'work')?.color).toBe(PROJECT_COLORS[6])
    // The default project may be renamed too.
    const defaultRenamed = ledger.applyRequest('p4', { kind: 'rename-project', projectId: DEFAULT_PROJECT_ID, name: 'Inbox' })
    expect(defaultRenamed.state.projects.find(item => item.id === DEFAULT_PROJECT_ID)?.name).toBe('Inbox')
  })

  it('rejects a duplicate name, a reserved id, and an unknown color', () => {
    ledger = new HostTaskLedger(join(dir, 'reject'), () => NOW, {})
    ledger.applyRequest('p1', { kind: 'create-project', id: 'work', name: 'Work' })
    expect(() => ledger!.applyRequest('p2', { kind: 'create-project', id: 'other', name: 'work' })).toThrow('name already exists')
    expect(() => ledger!.applyRequest('p3', { kind: 'create-project', id: DEFAULT_PROJECT_ID, name: 'Takeover' })).toThrow('reserved')
    expect(() => ledger!.applyRequest('p4', { kind: 'set-project-color', projectId: 'work', color: 'hotpink' })).toThrow('unknown project color')
  })

  it('deletes a project and reassigns its cards to the default project, serials and history intact', () => {
    ledger = new HostTaskLedger(join(dir, 'delete'), () => NOW, {})
    ledger.applyRequest('p1', { kind: 'create-project', id: 'work', name: 'Work' })
    const r1 = ledger.applyRequest('p2', { kind: 'create', id: 'a', input: { ...input('A'), projectId: 'work' } })
    const r2 = ledger.applyRequest('p3', { kind: 'create', id: 'b', input: { ...input('B'), projectId: 'work' } })
    expect(r1.state.tasks.find(task => task.id === 'a')?.serial).toBe(1)
    expect(r2.state.tasks.find(task => task.id === 'b')?.serial).toBe(2)

    const deleted = ledger.applyRequest('p4', { kind: 'delete-project', projectId: 'work' })
    expect(deleted.state.projects.map(item => item.id)).toEqual([DEFAULT_PROJECT_ID])
    const a = deleted.state.tasks.find(task => task.id === 'a')
    const b = deleted.state.tasks.find(task => task.id === 'b')
    expect(a?.projectId).toBe(DEFAULT_PROJECT_ID)
    expect(b?.projectId).toBe(DEFAULT_PROJECT_ID)
    // The reassignment only moves the pin and the stamp: the serials survive.
    expect(a?.serial).toBe(1)
    expect(b?.serial).toBe(2)
    expect(deleted.state.nextSerial).toBe(3)

    // The default project is reserved: it cannot be deleted, and a second
    // delete of the already-gone project is refused as well.
    expect(() => ledger!.applyRequest('p5', { kind: 'delete-project', projectId: DEFAULT_PROJECT_ID })).toThrow('default project cannot be deleted')
    expect(() => ledger!.applyRequest('p6', { kind: 'delete-project', projectId: 'work' })).toThrow('project not found')
  })

  it('stamps imported cards to the project and backfills dangling pins', () => {
    ledger = new HostTaskLedger(join(dir, 'import'), () => NOW, {})
    ledger.applyRequest('p1', { kind: 'create-project', id: 'work', name: 'Work' })
    const rows = [
      makeTask('in-1', { serial: 9, projectId: 'work' }),
      makeTask('in-2', { serial: 10, projectId: 'ghost' }),
    ]
    const result = ledger.applyRequest('p2', { kind: 'import', sourceId: 'other-host', tasks: JSON.parse(JSON.stringify(rows)) })
    const byId = new Map(result.state.tasks.map(task => [task.id, task]))
    expect(byId.get('in-1')?.projectId).toBe('work')
    expect(byId.get('in-2')?.projectId).toBe(DEFAULT_PROJECT_ID)
    // The import never touches the numbering layer.
    expect(byId.get('in-1')?.serial).toBe(9)
    expect(byId.get('in-2')?.serial).toBe(10)
  })
})
