/**
 * Session-sourced new-task prefill: NewTaskModal pre-fills the title from
 * the request's sourceSession (title only, user-editable), a duplicated
 * task's own title wins over the source session, and the standalone overlay
 * (session-new-task-overlay) renders that modal in a body-level React root
 * off the request bus — the trigger fires while the board panel is closed,
 * so an in-board copy would be invisible.
 */
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
// React's scheduler grabs Node's MessageChannel when the react-dom modules
// load; a live channel keeps the vitest fork's event loop busy and the whole
// run then hangs on exit. Hoisted before the imports so the scheduler falls
// back to its setTimeout flusher instead.
vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).MessageChannel = undefined
})
// The bus contract (no-op idle, replacement, restore) is covered by
// new-task-request.spec.ts; here the overlay is the only subscriber.
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import { DEFAULT_PROJECT_ID } from '../src/core/projects.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { parseActionEnvelope } from '../src/protocol.ts'
import { NewTaskModal } from '../src/client/board/NewTaskModal.tsx'
import { mountNewTaskOverlay } from '../src/client/session-new-task-overlay.tsx'
import { requestNewTask } from '../src/client/new-task-request.ts'

const NOW = 1_700_000_000_000

function modalController(tasks: readonly TaskRecord[] = []): BoardController {
  const snapshot = {
    tasks,
    pendingTaskIds: [],
    host: {
      scheduler: { timeZone: 'Asia/Shanghai' },
      sessionDefaultPermission: undefined,
      automation: undefined,
    },
    executionOptions: { workspaces: [], presets: [], models: [], defaultModel: undefined },
    projects: [],
    defaultProjectId: DEFAULT_PROJECT_ID,
  } as unknown as ControllerSnapshot
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    openTask: () => {},
    closeTask: () => {},
    openSession: () => {},
    retryHostSync: () => {},
    createTaskConfirmed: async () => undefined,
    rerunTask: async () => {},
    moveTask: () => {},
    updateTask: async () => true,
    archiveTask: async () => {},
    deleteTask: async () => {},
  } as unknown as BoardController
}

/** The first <input> in a rendered form is the title field. */
function firstInputValue(html: string): string {
  const jsdom = new JSDOM(html)
  const value = jsdom.window.document.querySelector('input')?.value ?? ''
  jsdom.window.close() // release the window's handles before the next test
  return value
}

describe('NewTaskModal session prefill (SSR mount)', () => {
  it('pre-fills the title from the request source session', () => {
    const html = renderToString(createElement(NewTaskModal, {
      controller: modalController(),
      onClose: () => {},
      sourceSession: { id: 's1', title: '写周报' },
    }))
    expect(firstInputValue(html)).toBe('写周报')
  })

  it('keeps the title empty without a source session', () => {
    const html = renderToString(createElement(NewTaskModal, {
      controller: modalController(),
      onClose: () => {},
    }))
    expect(firstInputValue(html)).toBe('')
  })

  it('lets a duplicated task win over the source session', () => {
    const source = createTask({ title: 'COPY', description: '', prompt: 'p' }, NOW, 't1')
    const html = renderToString(createElement(NewTaskModal, {
      controller: modalController(),
      onClose: () => {},
      initialTask: source,
      sourceSession: { id: 's1', title: '写周报' },
    }))
    expect(firstInputValue(html)).toBe('COPY')
  })

  it('shows the source-session binding line on the form (and none without a source)', () => {
    const withSource = renderToString(createElement(NewTaskModal, {
      controller: modalController(),
      onClose: () => {},
      sourceSession: { id: 's1', title: '写周报' },
    }))
    expect(withSource).toContain('来源会话 写周报')
    const without = renderToString(createElement(NewTaskModal, {
      controller: modalController(),
      onClose: () => {},
    }))
    expect(without).not.toContain('来源会话')
  })
})

describe('session-new-task-overlay (body-level request bus)', () => {
  /** The JSDOM window of the running test; closed in afterEach so no jsdom
   * handle keeps the vitest fork's event loop alive (the run would hang on
   * exit). */
  let liveDom: JSDOM | undefined

  afterEach(() => {
    liveDom?.window.close()
    liveDom = undefined
    vi.unstubAllGlobals()
  })

  function stubBrowser(): JSDOM {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('MutationObserver', dom.window.MutationObserver)
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent)
    vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent)
    vi.stubGlobal('localStorage', dom.window.localStorage)
    vi.stubGlobal('navigator', dom.window.navigator)
    liveDom = dom
    return dom
  }

  it('publishes without a listener instead of throwing', () => {
    expect(() => { requestNewTask({ sourceSession: { id: 's1', title: 't' } }) }).not.toThrow()
  })

  it('renders the modal in a body-level root on request and unmounts on close', async () => {
    const dom = stubBrowser()
    const document = dom.window.document
    const dispose = mountNewTaskOverlay(modalController())

    // Idle: the container is created lazily on the first request.
    expect(document.querySelector('[data-dsh-taskboard-new-task-overlay]')).toBeNull()

    requestNewTask({ sourceSession: { id: 's1', title: '写周报' } })

    // The React root flushes on the scheduler's macrotask.
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    })
    const container = document.querySelector('[data-dsh-taskboard-new-task-overlay]')!
    expect(document.body.contains(container)).toBe(true)
    const dialog = document.querySelector('[role="dialog"]') as HTMLFormElement | null
    expect(dialog!.querySelector('input')?.value).toBe('写周报')

    // Cancel: the footer's first button. The container stays (idle), the
    // form goes.
    const cancel = dialog!.querySelectorAll('button')[0]
    cancel.click()
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
    expect(document.querySelector('[data-dsh-taskboard-new-task-overlay]')).not.toBeNull()

    // Dispose removes the container itself.
    dispose()
    expect(document.querySelector('[data-dsh-taskboard-new-task-overlay]')).toBeNull()
  })

  it('carries the source-session binding into the create payload on submit', async () => {
    const dom = stubBrowser()
    const document = dom.window.document
    const captured: unknown[] = []
    const controller = {
      ...modalController(),
      createTaskConfirmed: async (input: unknown) => {
        captured.push(input)
        return createTask(input as Parameters<typeof createTask>[0], NOW, 'created-1')
      },
    } as unknown as BoardController
    const dispose = mountNewTaskOverlay(controller)

    requestNewTask({ sourceSession: { id: 's1', title: '写周报' } })
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    })
    const dialog = document.querySelector('[role="dialog"]') as HTMLFormElement | null
    // The footer buttons: cancel first, submit second.
    const buttons = dialog!.querySelectorAll('button')
    ;(buttons[1] as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
    dispose()
    expect(captured).toHaveLength(1)
    expect((captured[0] as { sourceSession?: { id: string; title?: string } }).sourceSession)
      .toEqual({ id: 's1', title: '写周报' })
  })
})

describe('create-task wire gate: sourceSession', () => {
  const base = { title: 'T', description: '', prompt: 'p' }

  it('accepts a create payload carrying the source-session pin', () => {
    const envelope = parseActionEnvelope({
      requestId: 'r1',
      action: { kind: 'create', id: 't1', input: { ...base, sourceSession: { id: 'sess-1', title: '写周报' } } },
    })
    if (envelope?.action.kind !== 'create') throw new Error('create action was not accepted')
    expect(envelope.action.input.sourceSession).toEqual({ id: 'sess-1', title: '写周报' })
  })

  it('rejects a malformed source-session pin but not a legacy payload', () => {
    const reject = (input: Record<string, unknown>) =>
      parseActionEnvelope({ requestId: 'r2', action: { kind: 'create', id: 't2', input: { ...base, sourceSession: input } } })
    expect(reject({ id: '' })).toBeUndefined()
    expect(reject({ id: '   ' })).toBeUndefined()
    expect(reject({ id: 42 })).toBeUndefined()
    expect(reject({ id: 's', title: 7 })).toBeUndefined()
    expect(reject({ id: 's', stray: 1 })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r3', action: { kind: 'create', id: 't3', input: base } })).toBeDefined()
  })
})
