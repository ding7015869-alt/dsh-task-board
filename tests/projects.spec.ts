/**
 * Project-layer tests (ledger v4): the project use cases (create / rename /
 * recolor / delete with card reassignment), the task projectId pass-through
 * (create / update / import / store tolerance), the protocol gates for the
 * four project actions and the widened create/update/import gates, and the
 * dashboard's per-project breakdown. The card serial stays global in all of
 * it: no project transition may move a number.
 */
import { describe, expect, it } from 'vitest'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { parseLedger } from '../src/core/store.ts'
import { applyUpdateTask } from '../src/core/use-cases/task-update.ts'
import {
  applyCreateProject,
  applyDeleteProject,
  applyRenameProject,
  applySetProjectColor,
} from '../src/core/use-cases/project.ts'
import {
  DEFAULT_PROJECT_ID,
  PROJECT_COLORS,
  autoProjectColor,
  defaultProject,
  isProjectColor,
  normalizeProjectList,
  projectOf,
  type ProjectRecord,
} from '../src/core/projects.ts'
import { summarizeByProject } from '../src/core/dashboard.ts'
import { TASK_BOARD_PREV_SCHEMA_VERSION, TASK_BOARD_SCHEMA_VERSION, parseActionEnvelope } from '../src/protocol.ts'

const NOW = 1_700_000_000_000

function project(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return { id, name: id, color: PROJECT_COLORS[0], createdAt: NOW, updatedAt: NOW, ...overrides }
}

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const base = createTask({ title: id.toUpperCase(), description: '', prompt: id }, NOW, id)
  return { ...base, ...overrides }
}

describe('project use cases', () => {
  it('creates a project with an auto-assigned free color and stamps it', () => {
    const projects = [project('a', { color: PROJECT_COLORS[0] })]
    const next = applyCreateProject(projects, 'b', 'Second', undefined, NOW)
    expect(next).toHaveLength(2)
    const created = next.find(item => item.id === 'b')
    expect(created?.color).toBe(PROJECT_COLORS[1])
    expect(created?.name).toBe('Second')
    expect(created?.createdAt).toBe(NOW)
  })

  it('accepts an explicit palette color and trims the name', () => {
    const next = applyCreateProject([], 'p', '  Web  ', PROJECT_COLORS[7], NOW)
    expect(next[0].name).toBe('Web')
    expect(next[0].color).toBe(PROJECT_COLORS[7])
  })

  it('wraps around the palette when every slot is taken', () => {
    const full = PROJECT_COLORS.map((color, index) => project(`full-${index}`, { color }))
    // All eight slots are taken: the ninth project wraps to slot one.
    expect(autoProjectColor(full)).toBe(PROJECT_COLORS[0])
    const next = applyCreateProject(full, 'extra', 'Extra', undefined, NOW)
    expect(next[next.length - 1].color).toBe(PROJECT_COLORS[0])
  })

  it('rejects the reserved default id, a duplicate id, and a duplicate name', () => {
    const projects = [project('a', { name: 'Alpha' })]
    expect(() => applyCreateProject(projects, DEFAULT_PROJECT_ID, 'Take Over', undefined, NOW)).toThrow('reserved')
    expect(() => applyCreateProject(projects, 'a', 'Other', undefined, NOW)).toThrow('id already exists')
    expect(() => applyCreateProject(projects, 'b', 'alpha', undefined, NOW)).toThrow('name already exists')
  })

  it('rejects a blank or over-long project name', () => {
    expect(() => applyCreateProject([], 'p', '   ', undefined, NOW)).toThrow('name is required')
    expect(() => applyCreateProject([], 'p', 'x'.repeat(201), undefined, NOW)).toThrow('name is required')
  })

  it('renames a project (including the default one) with a fresh updatedAt', () => {
    const projects = [project(DEFAULT_PROJECT_ID, { name: 'Default' })]
    const renamed = applyRenameProject(projects, DEFAULT_PROJECT_ID, 'Inbox', NOW + 5_000)
    expect(renamed[0].name).toBe('Inbox')
    expect(renamed[0].updatedAt).toBe(NOW + 5_000)
    expect(() => applyRenameProject(projects, 'missing', 'Nope', NOW)).toThrow('project not found')
  })

  it('refuses a rename that collides with another project name', () => {
    const projects = [project('a', { name: 'Alpha' }), project('b', { name: 'Beta' })]
    expect(() => applyRenameProject(projects, 'a', 'beta', NOW)).toThrow('name already exists')
    // Renaming a project to its own (trimmed) name is a no-op, not a collision.
    expect(applyRenameProject(projects, 'a', '  Alpha  ', NOW)[0].name).toBe('Alpha')
  })

  it('recolors a project and rejects unknown color tokens', () => {
    const projects = [project('a')]
    const recolored = applySetProjectColor(projects, 'a', PROJECT_COLORS[4], NOW)
    expect(recolored[0].color).toBe(PROJECT_COLORS[4])
    expect(() => applySetProjectColor(projects, 'a', 'rgb(0,0,0)', NOW)).toThrow('unknown project color')
  })

  it('deletes a project and reassigns its cards to the default project, serials untouched', () => {
    const projects = [project(DEFAULT_PROJECT_ID), project('work')]
    const cards = [
      task('kept', { projectId: 'other' }),
      task('loose', { serial: 7 }), // unowned card: already default-owned
      task('moved', { projectId: 'work', serial: 12, executions: [{ id: 'e1', sessionId: undefined, startedAt: NOW, result: 'succeeded', endedAt: NOW + 1_000, error: undefined }] }),
    ]
    const result = applyDeleteProject(projects, cards, 'work', NOW + 1_000)
    expect(result.projects.map(item => item.id)).toEqual([DEFAULT_PROJECT_ID])
    const moved = result.tasks.find(item => item.id === 'moved')
    expect(moved?.projectId).toBe(DEFAULT_PROJECT_ID)
    // The card keeps its serial and its execution history.
    expect(moved?.serial).toBe(12)
    expect(moved?.executions).toHaveLength(1)
    expect(moved?.updatedAt).toBe(NOW + 1_000)
    // Cards owned by other projects are untouched; a card that never had an
    // owner stays unowned here (load-time backfill and the display layer
    // attribute it to the default project).
    expect(result.tasks.find(item => item.id === 'kept')?.projectId).toBe('other')
    expect(result.tasks.find(item => item.id === 'loose')?.projectId).toBeUndefined()
    // The default project is reserved: it cannot be deleted.
    expect(() => applyDeleteProject(result.projects, result.tasks, DEFAULT_PROJECT_ID, NOW)).toThrow('default project cannot be deleted')
    expect(() => applyDeleteProject(result.projects, result.tasks, 'work', NOW)).toThrow('project not found')
  })
})

describe('project normalization and ownership', () => {
  it('normalizes a persisted project list: malformed rows drop, default is guaranteed', () => {
    const repaired = normalizeProjectList([
      project('good', { name: 'Good' }),
      { id: '', name: 'Nope', color: PROJECT_COLORS[1], createdAt: NOW, updatedAt: NOW },
      { id: 'bad-color', name: 'Bad', color: 'not-a-token', createdAt: NOW, updatedAt: NOW },
      project('good'),
      'garbage',
    ], NOW)
    expect(repaired.map(item => item.id)).toEqual([DEFAULT_PROJECT_ID, 'good', 'bad-color'])
    expect(repaired.find(item => item.id === 'bad-color')?.color).toBe(PROJECT_COLORS[0])
    expect(repaired[0].id).toBe(DEFAULT_PROJECT_ID)
  })

  it('attributes a card to its project when known, to the default project otherwise', () => {
    const projects = [project(DEFAULT_PROJECT_ID), project('work')]
    expect(projectOf({ projectId: 'work' }, projects)).toBe('work')
    expect(projectOf({ projectId: 'ghost' }, projects)).toBe(DEFAULT_PROJECT_ID)
    expect(projectOf({}, projects)).toBe(DEFAULT_PROJECT_ID)
  })

  it('stamps a projectId on created tasks (blank collapses to undefined)', () => {
    const withProject = createTask({ title: 'T', description: '', prompt: 'p', projectId: ' work ' }, NOW, 'id')
    expect(withProject.projectId).toBe('work')
    const blank = createTask({ title: 'T', description: '', prompt: 'p', projectId: '   ' }, NOW, 'id')
    expect(blank.projectId).toBeUndefined()
    const absent = createTask({ title: 'T', description: '', prompt: 'p' }, NOW, 'id')
    expect(absent.projectId).toBeUndefined()
  })

  it('reassigns a card through an update patch and clears it with null/blank', () => {
    const [before] = [task('t', { projectId: 'work' })]
    const reassigned = applyUpdateTask([before], 't', { projectId: 'design' }, NOW)
    expect(reassigned[0].projectId).toBe('design')
    // null clears the pin at runtime (wire/store tolerance); the patch type
    // is string-only, so the value is asserted past the type.
    const clearedNull = applyUpdateTask([before], 't', { projectId: null as unknown as string }, NOW)
    expect(clearedNull[0].projectId).toBeUndefined()
    const clearedBlank = applyUpdateTask([before], 't', { projectId: '  ' }, NOW)
    expect(clearedBlank[0].projectId).toBeUndefined()
  })

  it('keeps a valid projectId and clears a bad one in persisted rows (store tolerance)', () => {
    const [kept] = parseLedger(JSON.stringify([task('t', { projectId: 'work' })]))
    expect(kept.projectId).toBe('work')
    const [cleared] = parseLedger(JSON.stringify([{ ...task('t'), projectId: 42 }]))
    expect(cleared).toBeUndefined() // non-string pin drops the row in the shape gate
    const [blank] = parseLedger(JSON.stringify([task('t', { projectId: '' })]))
    expect(blank.projectId).toBeUndefined()
  })
})

describe('protocol gates (v4 + project actions)', () => {
  it('bumps the schema to 4 and remembers the v3 generation', () => {
    expect(TASK_BOARD_SCHEMA_VERSION).toBe(4)
    expect(TASK_BOARD_PREV_SCHEMA_VERSION).toBe(3)
  })

  it('accepts a create with a projectId and rejects a foreign key', () => {
    const accepted = parseActionEnvelope({
      requestId: 'r1',
      action: { kind: 'create', id: 't1', input: { title: 'T', description: '', prompt: 'p', projectId: 'work' } },
    })
    expect(accepted?.action).toMatchObject({ kind: 'create', id: 't1' })
    const rejected = parseActionEnvelope({
      requestId: 'r2',
      action: { kind: 'create', id: 't1', input: { title: 'T', description: '', prompt: 'p', projectId: 'work', stray: 1 } },
    })
    expect(rejected).toBeUndefined()
  })

  it('accepts an update patch that reassigns or clears the project', () => {
    const reassigned = parseActionEnvelope({ requestId: 'r1', action: { kind: 'update', taskId: 't1', patch: { projectId: 'design' } } })
    expect(reassigned?.action).toMatchObject({ kind: 'update', taskId: 't1' })
    const cleared = parseActionEnvelope({ requestId: 'r2', action: { kind: 'update', taskId: 't1', patch: { projectId: null } } })
    expect(cleared?.action).toMatchObject({ kind: 'update', taskId: 't1' })
    const bad = parseActionEnvelope({ requestId: 'r3', action: { kind: 'update', taskId: 't1', patch: { projectId: 7 } } })
    expect(bad).toBeUndefined()
  })

  it('carries a projectId through an import row', () => {
    const row = task('t', { projectId: 'work' })
    const accepted = parseActionEnvelope({ requestId: 'r1', action: { kind: 'import', sourceId: 'other', tasks: [row] } })
    expect((accepted?.action as { kind: string; tasks?: TaskRecord[] } | undefined)?.tasks?.[0].projectId).toBe('work')
    const badPin = { ...row, projectId: 42 }
    const rejected = parseActionEnvelope({ requestId: 'r2', action: { kind: 'import', sourceId: 'other', tasks: [badPin] } })
    expect(rejected).toBeUndefined()
  })

  it('gates the four project actions (exact keys, bounded names, known colors)', () => {
    const created = parseActionEnvelope({ requestId: 'r1', action: { kind: 'create-project', id: 'work', name: 'Work' } })
    expect(created?.action).toMatchObject({ kind: 'create-project', id: 'work', name: 'Work' })
    expect(isProjectColor((created?.action as { color?: string } | undefined)?.color ?? PROJECT_COLORS[0])).toBe(true)

    const renamed = parseActionEnvelope({ requestId: 'r2', action: { kind: 'rename-project', projectId: 'work', name: 'Work Stream' } })
    expect(renamed?.action).toMatchObject({ kind: 'rename-project', projectId: 'work', name: 'Work Stream' })

    const recolored = parseActionEnvelope({ requestId: 'r3', action: { kind: 'set-project-color', projectId: 'work', color: PROJECT_COLORS[5] } })
    expect(recolored?.action).toMatchObject({ kind: 'set-project-color', projectId: 'work', color: PROJECT_COLORS[5] })

    const deleted = parseActionEnvelope({ requestId: 'r4', action: { kind: 'delete-project', projectId: 'work' } })
    expect(deleted?.action).toMatchObject({ kind: 'delete-project', projectId: 'work' })

    // Foreign keys, unknown colors, and over-long names are rejected.
    expect(parseActionEnvelope({ requestId: 'x1', action: { kind: 'create-project', id: 'work', name: 'W', stray: 1 } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'x2', action: { kind: 'set-project-color', projectId: 'work', color: 'red' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'x3', action: { kind: 'rename-project', projectId: 'work', name: 'x'.repeat(201) } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'x4', action: { kind: 'delete-project' } })).toBeUndefined()
  })
})

describe('dashboard per-project breakdown', () => {
  it('summarizes each project: live counts, archived, and the grand total', () => {
    const projects = [project(DEFAULT_PROJECT_ID), project('work')]
    const tasks: TaskRecord[] = [
      task('a', { projectId: 'work', status: 'todo' }),
      task('b', { projectId: 'work', status: 'done' }),
      task('c', { projectId: 'work', status: 'done', archivedAt: NOW }),
      task('d', { status: 'failed' }), // unowned -> default
      task('e', { projectId: 'ghost', status: 'backlog' }), // dangling -> default
    ]
    const rows = summarizeByProject(tasks, projects)
    expect(rows).toHaveLength(2)
    const defaultRow = rows.find(row => row.projectId === DEFAULT_PROJECT_ID)
    expect(defaultRow?.counts).toEqual({ backlog: 1, todo: 0, running: 0, done: 0, failed: 1 })
    expect(defaultRow?.total).toBe(2)
    expect(defaultRow?.archived).toBe(0)
    const workRow = rows.find(row => row.projectId === 'work')
    expect(workRow?.counts).toEqual({ backlog: 0, todo: 1, running: 0, done: 1, failed: 0 })
    expect(workRow?.total).toBe(3)
    expect(workRow?.archived).toBe(1)
  })

  it('unshifts the default project first when it is missing, and keeps a persisted order otherwise', () => {
    const withoutDefault = normalizeProjectList([project('second')], NOW)
    expect(withoutDefault.map(item => item.id)).toEqual([DEFAULT_PROJECT_ID, 'second'])
    const rows = summarizeByProject([], withoutDefault)
    expect(rows[0].projectId).toBe(DEFAULT_PROJECT_ID)
    expect(rows[0].name).toBe('Default')

    // A persisted board that already carries the default project keeps its
    // own order (the ledger mints default first on fresh documents).
    const persisted = normalizeProjectList([project('second'), project(DEFAULT_PROJECT_ID, { name: 'Inbox' })], NOW)
    expect(persisted.map(item => item.id)).toEqual(['second', DEFAULT_PROJECT_ID])
  })
})
