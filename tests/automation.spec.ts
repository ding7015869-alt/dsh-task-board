/**
 * Board automation tests: the pure executability gate (a task is executable
 * only when EVERY condition holds), the board-wide concurrency cap in the
 * Host ledger (manual-run refusal, cron deferral, patrol dispatch), and the
 * live automation snapshot surface on the Host service.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { checkExecutable, CONTINUE_INITIATOR, openExecutionCount, PATROL_INITIATOR, PATROL_STATUSES } from '../src/core/executability.ts'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'

const NOW = 1_700_000_000_000

function makeTask(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: id.toUpperCase(), description: '', prompt: id }, NOW, id), ...overrides }
}

function openExecution(): ExecutionRecord {
  return { id: 'exec-open', sessionId: undefined, startedAt: NOW, endedAt: undefined, result: undefined, error: undefined }
}

describe('checkExecutable (the all-conditions gate)', () => {
  const clean = makeTask('a')
  const context = {
    tasks: [clean],
    sessionDefaultPermission: 'read-only' as const,
    openExecutions: 0,
    maxConcurrency: 1,
  }

  it('executes only when every condition holds', () => {
    const check = checkExecutable(clean, PATROL_STATUSES, context)
    expect(check.executable).toBe(true)
    expect(check.blocked).toEqual([])
  })

  it('patrols only the todo pool; the backlog parking pool is never picked up', () => {
    expect(PATROL_STATUSES).toEqual(['todo'])
    const parked = makeTask('b', { status: 'backlog' })
    const check = checkExecutable(parked, PATROL_STATUSES, { ...context, tasks: [parked] })
    expect(check.blocked).toEqual(['status'])
  })

  it('blocks an archived task first', () => {
    const task = makeTask('a', { archivedAt: NOW })
    const check = checkExecutable(task, PATROL_STATUSES, { ...context, tasks: [task] })
    expect(check.blocked[0]).toBe('archived')
    expect(check.executable).toBe(false)
  })

  it('counts its own open execution as running', () => {
    const task = makeTask('a', { executions: [openExecution()] })
    expect(openExecutionCount([task])).toBe(1)
    expect(openExecutionCount([task, makeTask('b')])).toBe(1)
    const check = checkExecutable(task, PATROL_STATUSES, { ...context, tasks: [task], openExecutions: 1 })
    expect(check.blocked).toContain('running')
  })

  it('waits for pending parents', () => {
    const parent = makeTask('p', { status: 'todo' })
    const child = makeTask('c', { parentIds: ['p'] })
    const check = checkExecutable(child, PATROL_STATUSES, { ...context, tasks: [parent, child] })
    expect(check.blocked).toContain('parents-pending')
    // The same child is open once the parent settles to done.
    const doneParent = makeTask('p', { status: 'done' })
    const open = checkExecutable(child, PATROL_STATUSES, { ...context, tasks: [doneParent, child] })
    expect(open.executable).toBe(true)
  })

  it('never auto-confirms an unconfirmed elevated permission', () => {
    const task = makeTask('a', { permission: 'danger-full-access' })
    const check = checkExecutable(task, PATROL_STATUSES, { ...context, tasks: [task] })
    expect(check.blocked).toContain('permission-unconfirmed')
    const confirmed = makeTask('a', { permission: 'danger-full-access', permissionConfirmedAt: NOW })
    expect(checkExecutable(confirmed, PATROL_STATUSES, { ...context, tasks: [confirmed] }).executable).toBe(true)
  })

  it('blocks when the board-wide cap is full', () => {
    const busy = makeTask('b', { executions: [openExecution()] })
    const check = checkExecutable(clean, PATROL_STATUSES, {
      ...context,
      tasks: [clean, busy],
      openExecutions: 1,
      maxConcurrency: 1,
    })
    expect(check.blocked).toEqual(['concurrency-full'])
  })

  it('reports the failing conditions in check order', () => {
    const task = makeTask('a', { status: 'failed', executions: [openExecution()] })
    const check = checkExecutable(task, PATROL_STATUSES, {
      ...context,
      tasks: [task],
      openExecutions: 1,
      maxConcurrency: 1,
    })
    expect(check.blocked).toEqual(['status', 'running', 'concurrency-full'])
  })
})

describe('HostTaskLedger concurrency cap', () => {
  let dir: string
  let ledger: HostTaskLedger

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-cap-'))
    ledger = new HostTaskLedger(dir, () => NOW, { maxConcurrency: 2 })
  })

  afterEach(() => {
    for (const task of ledger.state().tasks) {
      for (const execution of task.executions) {
        if (execution.endedAt === undefined) ledger.settle(task.id, execution.id, 'succeeded')
      }
    }
  })

  it('clamps the cap to a usable integer (>= 1)', () => {
    expect(ledger.maxConcurrency).toBe(2)
    ledger.setMaxConcurrency(0)
    expect(ledger.maxConcurrency).toBe(1)
    ledger.setMaxConcurrency(1.5)
    expect(ledger.maxConcurrency).toBe(1)
    ledger.setMaxConcurrency(3)
    expect(ledger.maxConcurrency).toBe(3)
  })

  it('refuses a manual run at the cap and opens a slot after a settle', () => {
    ledger.setMaxConcurrency(2)
    ledger.applyRequest('cap1', { kind: 'create', id: 'a1', input: { title: 'A1', description: '', prompt: 'a' } })
    ledger.applyRequest('cap2', { kind: 'create', id: 'a2', input: { title: 'A2', description: '', prompt: 'a' } })
    const first = ledger.applyRequest('cap3', { kind: 'run', taskId: 'a1' }).run!
    const second = ledger.applyRequest('cap4', { kind: 'run', taskId: 'a2' }).run!
    expect(ledger.openExecutionsCount()).toBe(2)
    // The cap rejects a task without its own open execution; a task that is
    // already running hits the own-execution gate first (check order).
    ledger.applyRequest('cap5', { kind: 'create', id: 'a3', input: { title: 'A3', description: '', prompt: 'a' } })
    expect(() => ledger.applyRequest('cap6', { kind: 'run', taskId: 'a3' })).toThrow('concurrency-gate')
    expect(() => ledger.applyRequest('cap7', { kind: 'run', taskId: 'a1' })).toThrow('task is already running or missing')
    ledger.settle('a1', first.execution.id, 'succeeded')
    const retry = ledger.applyRequest('cap6', { kind: 'rerun', taskId: 'a1' }).run
    expect(retry?.task.id).toBe('a1')
    ledger.settle('a1', retry!.execution.id, 'succeeded')
    ledger.settle('a2', second.execution.id, 'succeeded')
  })

  it('defers a due cron trigger at the cap without dropping it', () => {
    ledger.setMaxConcurrency(1)
    ledger.applyRequest('def1', {
      kind: 'create',
      id: 'cron-a',
      input: { title: 'Cron A', description: '', prompt: 'c', schedule: { enabled: true, cron: '*/5 * * * *' } },
    })
    ledger.applyRequest('def2', { kind: 'create', id: 'filler', input: { title: 'Filler', description: '', prompt: 'f' } })
    const filler = ledger.applyRequest('def3', { kind: 'run', taskId: 'filler' }).run!
    const due = ledger.state().tasks.find(task => task.id === 'cron-a')!.schedule!.nextRunAt!
    // At the cap: deferred (no commit), nextRunAt stays put.
    expect(ledger.openScheduled('cron-a', due, NOW + 5000)).toBeUndefined()
    expect(ledger.state().tasks.find(task => task.id === 'cron-a')!.schedule!.nextRunAt).toBe(due)
    // Free the slot: the same trigger now opens.
    ledger.settle('filler', filler.execution.id, 'succeeded')
    const opened = ledger.openScheduled('cron-a', due, NOW + 10000)
    expect(opened?.task.id).toBe('cron-a')
    ledger.settle('cron-a', opened!.execution.id, 'succeeded')
  })
})

describe('HostTaskLedger patrol dispatch', () => {
  let dir: string
  let ledger: HostTaskLedger

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-patrol-'))
    ledger = new HostTaskLedger(dir, () => NOW, { maxConcurrency: 2 })
  })

  afterEach(() => {
    for (const task of ledger.state().tasks) {
      for (const execution of task.executions) {
        if (execution.endedAt === undefined) ledger.settle(task.id, execution.id, 'succeeded')
      }
    }
  })

  it('opens a run for a clean todo task and stamps the patrol initiator', () => {
    ledger.applyRequest('pat1', { kind: 'create', id: 'pt1', input: { title: 'PT1', description: '', prompt: 'p' } })
    const opened = ledger.openPatrolRun('pt1', NOW + 1000)
    expect(opened?.task.id).toBe('pt1')
    expect(opened?.task.status).toBe('running')
    expect(opened?.execution.initiatedBy).toBe(PATROL_INITIATOR)
    ledger.settle('pt1', opened!.execution.id, 'succeeded')
  })

  it('skips a task that has no open slot or has settled', () => {
    expect(ledger.openPatrolRun('ghost', NOW + 1)).toBeUndefined()
    ledger.applyRequest('pat2', { kind: 'create', id: 'pt2', input: { title: 'PT2', description: '', prompt: 'p' } })
    const opened = ledger.openPatrolRun('pt2', NOW + 1)
    expect(opened).toBeDefined()
    ledger.settle('pt2', opened!.execution.id, 'succeeded')
    // Already-running and already-settled tasks never patrol again.
    expect(ledger.openPatrolRun('pt2', NOW + 2)).toBeUndefined()
  })

  it('never touches cron-owned, archived, gated, unconfirmed, or capped tasks', () => {
    ledger.applyRequest('pat3', {
      kind: 'create',
      id: 'cron-p',
      input: { title: 'Cron P', description: '', prompt: 'c', schedule: { enabled: true, cron: '0 9 * * *' } },
    })
    expect(ledger.openPatrolRun('cron-p', NOW + 3)).toBeUndefined()

    ledger.applyRequest('pat4', { kind: 'create', id: 'arch-p', input: { title: 'Arch P', description: '', prompt: 'a' } })
    // Only settled tasks are archivable: run and settle first.
    const archRun = ledger.applyRequest('pat4b', { kind: 'run', taskId: 'arch-p' }).run!
    ledger.settle('arch-p', archRun.execution.id, 'succeeded')
    ledger.applyRequest('pat5', { kind: 'archive', taskId: 'arch-p' })
    expect(ledger.openPatrolRun('arch-p', NOW + 4)).toBeUndefined()

    ledger.applyRequest('pat6', { kind: 'create', id: 'par-p', input: { title: 'Par P', description: '', prompt: 'p' } })
    ledger.applyRequest('pat7', {
      kind: 'create',
      id: 'ch-p',
      input: { title: 'Ch P', description: '', prompt: 'c', parentIds: ['par-p'] },
    })
    expect(ledger.openPatrolRun('ch-p', NOW + 5)).toBeUndefined()

    ledger.applyRequest('pat8', { kind: 'create', id: 'perm-p', input: { title: 'Perm P', description: '', prompt: 'p', permission: 'danger-full-access' } })
    expect(ledger.openPatrolRun('perm-p', NOW + 6)).toBeUndefined()

    ledger.applyRequest('pat9', { kind: 'create', id: 'filler1', input: { title: 'F1', description: '', prompt: 'f' } })
    ledger.applyRequest('pat10', { kind: 'create', id: 'filler2', input: { title: 'F2', description: '', prompt: 'f' } })
    const f1 = ledger.applyRequest('pat11', { kind: 'run', taskId: 'filler1' }).run!
    const f2 = ledger.applyRequest('pat12', { kind: 'run', taskId: 'filler2' }).run!
    ledger.applyRequest('pat13', { kind: 'create', id: 'full-p', input: { title: 'Full P', description: '', prompt: 'f' } })
    expect(ledger.openPatrolRun('full-p', NOW + 7)).toBeUndefined()
    // Free one slot: the patrol opens exactly one more task.
    ledger.settle('filler1', f1.execution.id, 'succeeded')
    const opened = ledger.openPatrolRun('full-p', NOW + 8)
    expect(opened?.task.id).toBe('full-p')
    ledger.settle('filler2', f2.execution.id, 'succeeded')
    ledger.settle('full-p', opened!.execution.id, 'succeeded')
  })
})

describe('HostTaskLedger continue dispatch (settle-driven auto-continuation)', () => {
  let dir: string
  let ledger: HostTaskLedger

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-continue-'))
    ledger = new HostTaskLedger(dir, () => NOW, { maxConcurrency: 1 })
  })

  afterEach(() => {
    for (const task of ledger.state().tasks) {
      for (const execution of task.executions) {
        if (execution.endedAt === undefined) ledger.settle(task.id, execution.id, 'succeeded')
      }
    }
  })

  it('opens a run for a newly eligible child and stamps the continue initiator', () => {
    ledger.applyRequest('ct1', { kind: 'create', id: 'cp', input: { title: 'P', description: '', prompt: 'p' } })
    const parent = ledger.applyRequest('ct2', { kind: 'run', taskId: 'cp' }).run!
    ledger.settle('cp', parent.execution.id, 'succeeded')
    ledger.applyRequest('ct3', { kind: 'create', id: 'cc', input: { title: 'C', description: '', prompt: 'c', parentIds: ['cp'] } })
    const opened = ledger.openContinueRun('cc', NOW + 1000)
    expect(opened?.task.id).toBe('cc')
    expect(opened?.execution.initiatedBy).toBe(CONTINUE_INITIATOR)
    ledger.settle('cc', opened!.execution.id, 'succeeded')
  })

  it('does not continue while a parent is still pending', () => {
    ledger.applyRequest('ct4', { kind: 'create', id: 'wp', input: { title: 'WP', description: '', prompt: 'p' } })
    ledger.applyRequest('ct5', { kind: 'create', id: 'wc', input: { title: 'WC', description: '', prompt: 'c', parentIds: ['wp'] } })
    expect(ledger.openContinueRun('wc', NOW + 1001)).toBeUndefined()
    const parent = ledger.applyRequest('ct6', { kind: 'run', taskId: 'wp' }).run!
    ledger.settle('wp', parent.execution.id, 'succeeded')
    const opened = ledger.openContinueRun('wc', NOW + 1002)
    expect(opened?.task.id).toBe('wc')
    ledger.settle('wc', opened!.execution.id, 'succeeded')
  })

  it('defers at the cap and continues once a slot frees', () => {
    ledger.applyRequest('ct7', { kind: 'create', id: 'cbusy', input: { title: 'Busy', description: '', prompt: 'b' } })
    const busy = ledger.applyRequest('ct8', { kind: 'run', taskId: 'cbusy' }).run!
    ledger.applyRequest('ct9', { kind: 'create', id: 'cc2', input: { title: 'C2', description: '', prompt: 'c' } })
    expect(ledger.openContinueRun('cc2', NOW + 1003)).toBeUndefined()
    ledger.settle('cbusy', busy.execution.id, 'succeeded')
    const opened = ledger.openContinueRun('cc2', NOW + 1004)
    expect(opened?.task.id).toBe('cc2')
    ledger.settle('cc2', opened!.execution.id, 'succeeded')
  })

  it('never auto-confirms an unconfirmed elevated permission on continue', () => {
    ledger.applyRequest('ct10', { kind: 'create', id: 'cperm', input: { title: 'Perm', description: '', prompt: 'p', permission: 'danger-full-access' } })
    expect(ledger.openContinueRun('cperm', NOW + 1005)).toBeUndefined()
  })

  it('leaves cron-owned and archived tasks to their owners', () => {
    ledger.applyRequest('ct11', {
      kind: 'create',
      id: 'ccron',
      input: { title: 'Cron C', description: '', prompt: 'c', schedule: { enabled: true, cron: '0 9 * * *' } },
    })
    expect(ledger.openContinueRun('ccron', NOW + 1006)).toBeUndefined()

    ledger.applyRequest('ct12', { kind: 'create', id: 'carch', input: { title: 'Arch C', description: '', prompt: 'c' } })
    const archRun = ledger.applyRequest('ct13', { kind: 'run', taskId: 'carch' }).run!
    ledger.settle('carch', archRun.execution.id, 'succeeded')
    ledger.applyRequest('ct14', { kind: 'archive', taskId: 'carch' })
    expect(ledger.openContinueRun('carch', NOW + 1007)).toBeUndefined()
  })
})

describe('TaskBoardHostService automation surface', () => {
  it('carries the automation block and live-updates the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-auto-'))
    const service = new TaskBoardHostService(undefined as unknown as TypertGateway, {
      ledger: new HostTaskLedger(dir, () => NOW, { maxConcurrency: 3 }),
      patrolEnabled: true,
      patrolIntervalMs: 15000,
    })
    try {
      const snapshot = service.snapshot()
      expect(snapshot.automation).toEqual({
        maxConcurrency: 3,
        openExecutions: 0,
        patrolEnabled: true,
        patrolIntervalMs: 15000,
      })
      expect(service.eventPayload().automation).toEqual(service.automationSnapshot())
      service.setConfiguration(true, false, { maxConcurrency: 5, patrolEnabled: false, patrolIntervalMs: 1000 })
      expect(service.ledger.maxConcurrency).toBe(5)
      expect(service.automationSnapshot()).toEqual({ maxConcurrency: 5, openExecutions: 0, patrolEnabled: false, patrolIntervalMs: 1000 })
      expect(service.snapshot().automation).toEqual(service.automationSnapshot())
    } finally {
      service.dispose()
    }
  })
})

describe('TaskBoardHostService settle-driven auto-continuation', () => {
  function makeService(): { service: TaskBoardHostService; dispose: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-continue-svc-'))
    const service = new TaskBoardHostService(undefined as unknown as TypertGateway, {
      ledger: new HostTaskLedger(dir, () => NOW, { maxConcurrency: 2 }),
    })
    return { service, dispose: () => service.dispose() }
  }

  it('hands a newly eligible child to the board on the next apply after the parent settles', () => {
    const { service, dispose } = makeService()
    try {
      service.apply('s1', { kind: 'create', id: 'busy', input: { title: 'Busy', description: '', prompt: 'b' } })
      service.apply('s2', { kind: 'run', taskId: 'busy' })
      service.apply('s3', { kind: 'create', id: 'cp', input: { title: 'P', description: '', prompt: 'p' } })
      service.apply('s4', { kind: 'run', taskId: 'cp' })
      const parentExecution = service.ledger.state().tasks.find(task => task.id === 'cp')!.executions.at(-1)!
      service.ledger.settle('cp', parentExecution.id, 'succeeded')
      // The creating apply of the child also runs the continuation pass: the
      // parent is already settled, so the child opens straight away.
      service.apply('s5', { kind: 'create', id: 'cc', input: { title: 'C', description: '', prompt: 'c', parentIds: ['cp'] } })
      const child = service.ledger.state().tasks.find(task => task.id === 'cc')!
      expect(child.status).toBe('running')
      expect(child.executions.at(-1)?.initiatedBy).toBe(CONTINUE_INITIATOR)
    } finally {
      dispose()
    }
  })

  it('keeps an unconfirmed-permission child parked even after its parent settles', () => {
    const { service, dispose } = makeService()
    try {
      service.apply('p1', { kind: 'create', id: 'cp', input: { title: 'P', description: '', prompt: 'p' } })
      service.apply('p2', { kind: 'run', taskId: 'cp' })
      const parentExecution = service.ledger.state().tasks.find(task => task.id === 'cp')!.executions.at(-1)!
      service.ledger.settle('cp', parentExecution.id, 'succeeded')
      service.apply('p3', { kind: 'create', id: 'cc', input: { title: 'C', description: '', prompt: 'c', parentIds: ['cp'], permission: 'danger-full-access' } })
      const child = service.ledger.state().tasks.find(task => task.id === 'cc')!
      expect(child.status).toBe('todo')
      expect(child.executions).toEqual([])
    } finally {
      dispose()
    }
  })

  it('parks a child at the cap and continues it once a slot frees', () => {
    const { service, dispose } = makeService()
    try {
      service.ledger.setMaxConcurrency(1)
      service.apply('k1', { kind: 'create', id: 'cp', input: { title: 'P', description: '', prompt: 'p' } })
      service.apply('k2', { kind: 'run', taskId: 'cp' })
      // The running parent fills the single slot: the child must stay parked.
      service.apply('k3', { kind: 'create', id: 'cc', input: { title: 'C', description: '', prompt: 'c', parentIds: ['cp'] } })
      expect(service.ledger.state().tasks.find(task => task.id === 'cc')!.status).toBe('todo')
      expect(service.ledger.openContinueRun('cc', NOW + 2000)).toBeUndefined()
      // Free the slot: the settle (a subsequent apply) continues the child.
      const parentExecution = service.ledger.state().tasks.find(task => task.id === 'cp')!.executions.at(-1)!
      service.ledger.settle('cp', parentExecution.id, 'succeeded')
      service.apply('k4', { kind: 'update', taskId: 'cc', patch: { title: 'C2' } })
      const child = service.ledger.state().tasks.find(task => task.id === 'cc')!
      expect(child.status).toBe('running')
      expect(child.executions.at(-1)?.initiatedBy).toBe(CONTINUE_INITIATOR)
    } finally {
      dispose()
    }
  })

  it('catches up children that unblocked while the host was down on the first tick', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-continue-boot-'))
    const service = new TaskBoardHostService(undefined as unknown as TypertGateway, {
      ledger: new HostTaskLedger(dir, () => NOW, { maxConcurrency: 2 }),
    })
    try {
      service.ledger.applyRequest('b1', { kind: 'create', id: 'cp', input: { title: 'P', description: '', prompt: 'p' } })
      const parentExecution = service.ledger.applyRequest('b2', { kind: 'run', taskId: 'cp' }).run!
      service.ledger.settle('cp', parentExecution.execution.id, 'succeeded')
      service.ledger.applyRequest('b3', { kind: 'create', id: 'cc', input: { title: 'C', description: '', prompt: 'c', parentIds: ['cp'] } })
      ;(service as unknown as { scheduleTick(first: boolean): void }).scheduleTick(true)
      const child = service.ledger.state().tasks.find(task => task.id === 'cc')!
      expect(child.status).toBe('running')
      expect(child.executions.at(-1)?.initiatedBy).toBe(CONTINUE_INITIATOR)
    } finally {
      service.dispose()
    }
  })
})
