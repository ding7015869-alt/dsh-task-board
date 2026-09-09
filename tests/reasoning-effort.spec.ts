/**
 * Reasoning-effort pin: the new-task form's per-model reasoning-effort choice
 * flows end to end — ledger record, update patch, wire validation, store
 * repair, runner select-model call, and the option-list helpers.
 */
import { describe, expect, it } from 'vitest'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { applyUpdateTask } from '../src/core/use-cases/task-update.ts'
import { parseLedger } from '../src/core/store.ts'
import { parseActionEnvelope } from '../src/protocol.ts'
import { HostExecutionRunner } from '../src/host-runner.ts'
import { reasoningEffortLabel, reasoningEffortOptionsFor } from '../src/client/board/model-options.ts'
import type { ExecutionModelOption } from '../src/core/controller.ts'

const NOW = 1_700_000_000_000

function baseTask(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask({ title: 't', description: '', prompt: 'p' }, NOW, 'task-1'),
    ...over,
  }
}

describe('createTask', () => {
  it('persists the pinned reasoning effort trimmed, blank collapses to undefined', () => {
    const task = createTask(
      { title: 't', description: '', prompt: 'p', model: 'openai/gpt-x', reasoningEffort: '  high  ' },
      NOW,
      'task-r1',
    )
    expect(task.reasoningEffort).toBe('high')
    const blank = createTask(
      { title: 't', description: '', prompt: 'p', reasoningEffort: '   ' },
      NOW,
      'task-r2',
    )
    expect(blank.reasoningEffort).toBeUndefined()
    const absent = createTask({ title: 't', description: '', prompt: 'p' }, NOW, 'task-r3')
    expect(absent.reasoningEffort).toBeUndefined()
  })
})

describe('applyUpdateTask', () => {
  it('sets, clears, and preserves the pinned effort across patches', () => {
    const task = baseTask()
    const set = applyUpdateTask([task], task.id, { reasoningEffort: 'max' }, NOW + 1)
    expect(set[0]?.reasoningEffort).toBe('max')
    const cleared = applyUpdateTask(set, task.id, { reasoningEffort: undefined }, NOW + 2)
    expect(cleared[0]?.reasoningEffort).toBeUndefined()
    const preserved = applyUpdateTask(set, task.id, { title: 't2' }, NOW + 3)
    expect(preserved[0]?.reasoningEffort).toBe('max')
    expect(preserved[0]?.title).toBe('t2')
    // Blank collapses to undefined like the other execution targets.
    const blanked = applyUpdateTask(set, task.id, { reasoningEffort: '  ' }, NOW + 4)
    expect(blanked[0]?.reasoningEffort).toBeUndefined()
  })

  it('keeps a model change from carrying a stale effort into the patch caller contract', () => {
    const task = baseTask({ model: 'openai/gpt-x', reasoningEffort: 'high' })
    const next = applyUpdateTask([task], task.id, { model: 'openai/gpt-y', reasoningEffort: undefined }, NOW + 1)
    expect(next[0]?.model).toBe('openai/gpt-y')
    expect(next[0]?.reasoningEffort).toBeUndefined()
  })
})

describe('parseLedger (store)', () => {
  function ledgerRow(record: TaskRecord): string {
    return JSON.stringify([
      {
        ...record,
        status: 'todo',
      },
    ])
  }

  it('round-trips a persisted reasoning effort', () => {
    const parsed = parseLedger(ledgerRow(baseTask({ reasoningEffort: 'high' })))
    expect(parsed[0]?.reasoningEffort).toBe('high')
  })

  it('repairs a blank persisted effort to undefined instead of dropping the row', () => {
    const parsed = parseLedger(ledgerRow(baseTask({ reasoningEffort: '   ' })))
    expect(parsed[0]?.id).toBe('task-1')
    expect(parsed[0]?.reasoningEffort).toBeUndefined()
  })

  it('drops a row whose reasoning effort is not a string', () => {
    const parsed = parseLedger(ledgerRow({ ...baseTask(), reasoningEffort: 42 as unknown as string }))
    expect(parsed).toEqual([])
  })
})

describe('protocol (wire gate)', () => {
  const ENVELOPE = { requestId: 'req-1', initiator: 'sess-1' }

  it('accepts a create input carrying the effort string', () => {
    const parsed = parseActionEnvelope({
      requestId: ENVELOPE.requestId,
      action: {
        kind: 'create',
        id: 'task-r1',
        input: { title: 't', description: '', prompt: 'p', model: 'openai/gpt-x', reasoningEffort: 'high' },
      },
    })
    expect(parsed?.action).toMatchObject({ kind: 'create', input: { reasoningEffort: 'high' } })
  })

  it('rejects a create input whose effort is not a string', () => {
    const parsed = parseActionEnvelope({
      requestId: ENVELOPE.requestId,
      action: {
        kind: 'create',
        id: 'task-r1',
        input: { title: 't', description: '', prompt: 'p', reasoningEffort: 9 as unknown as string },
      },
    })
    expect(parsed).toBeUndefined()
  })

  it('accepts and rejects update patches on the effort field', () => {
    const ok = parseActionEnvelope({
      requestId: ENVELOPE.requestId,
      action: { kind: 'update', taskId: 'task-1', patch: { reasoningEffort: 'medium' } },
    })
    expect(ok?.action).toMatchObject({ kind: 'update', patch: { reasoningEffort: 'medium' } })
    const bad = parseActionEnvelope({
      requestId: ENVELOPE.requestId,
      action: { kind: 'update', taskId: 'task-1', patch: { reasoningEffort: null } },
    })
    expect(bad).toBeUndefined()
  })
})

describe('runner select-model wire call', () => {
  function fakeGateway(calls: Array<{ namespace: string; method: string; args: Record<string, unknown> }>) {
    return {
      invoke(request: { namespace: string; method: string; args: Record<string, unknown> }): Promise<unknown> {
        calls.push(request)
        if (request.namespace === 'session' && request.method === 'create') return Promise.resolve({ sessionId: 'sess-1' })
        if (request.namespace === 'session' && request.method === 'prompt') return Promise.resolve({ accepted: true })
        return Promise.resolve({})
      },
    }
  }

  it('rides the effort on the select-model call when the task pins one', async () => {
    const calls: Array<{ namespace: string; method: string; args: Record<string, unknown> }> = []
    const runner = new HostExecutionRunner(fakeGateway(calls))
    const task = baseTask({ model: 'openai/gpt-x', reasoningEffort: 'high' })
    await runner.launch(task)
    const select = calls.find(item => item.namespace === 'session' && item.method === 'selectModel')
    expect(select?.args).toEqual({
      request: {
        sessionId: 'sess-1',
        provider: 'openai',
        model: 'gpt-x',
        reasoningEffort: 'high',
      },
    })
  })

  it('omits the effort key when the task pins no effort', async () => {
    const calls: Array<{ namespace: string; method: string; args: Record<string, unknown> }> = []
    const runner = new HostExecutionRunner(fakeGateway(calls))
    const task = baseTask({ model: 'openai/gpt-x' })
    await runner.launch(task)
    const select = calls.find(item => item.namespace === 'session' && item.method === 'selectModel')
    expect(select?.args).toEqual({
      request: {
        sessionId: 'sess-1',
        provider: 'openai',
        model: 'gpt-x',
      },
    })
  })

  it('never sends an effort for a task without a pinned model', async () => {
    const calls: Array<{ namespace: string; method: string; args: Record<string, unknown> }> = []
    const runner = new HostExecutionRunner(fakeGateway(calls))
    const task = baseTask({ reasoningEffort: 'high' })
    await runner.launch(task)
    expect(calls.some(item => item.method === 'selectModel')).toBe(false)
  })
})

describe('model-options effort helpers', () => {
  const MODELS: ExecutionModelOption[] = [
    {
      id: 'openai/gpt-x',
      label: 'gpt-x',
      reasoningEfforts: [
        { id: 'low', name: '低' },
        { id: 'high', name: '高', description: 'deeper thinking' },
      ],
      defaultReasoningEffort: 'low',
    },
    { id: 'anthropic/claude-y', label: 'claude-y' },
    { id: 'local/llama', label: 'llama' },
  ]

  it('lists the efforts of the pinned model only', () => {
    expect(reasoningEffortOptionsFor('openai/gpt-x', 'openai/gpt-x', MODELS).map(item => item.id)).toEqual(['low', 'high'])
    expect(reasoningEffortOptionsFor('anthropic/claude-y', 'openai/gpt-x', MODELS)).toEqual([])
  })

  it('falls back to the default route when nothing is pinned', () => {
    expect(reasoningEffortOptionsFor('', 'openai/gpt-x', MODELS).map(item => item.id)).toEqual(['low', 'high'])
    expect(reasoningEffortOptionsFor('', undefined, MODELS)).toEqual([])
  })

  it('ignores unknown pinned routes', () => {
    expect(reasoningEffortOptionsFor('ghost/model', 'openai/gpt-x', MODELS)).toEqual([])
  })

  it('labels fall back from name to id', () => {
    const options = reasoningEffortOptionsFor('', 'openai/gpt-x', MODELS)
    expect(options[0]).toEqual({ id: 'low', name: '低' })
    expect(reasoningEffortLabel(options[0] as { id: string; name?: string })).toBe('低')
    expect(reasoningEffortLabel({ id: 'max' })).toBe('max')
  })
})
