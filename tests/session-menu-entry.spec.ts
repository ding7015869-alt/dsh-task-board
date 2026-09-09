/**
 * Session-row "add as task card" menu injection (DOM behavior): the plain-DOM
 * row lands in the portaled menu list only while a session row is menuOpen
 * AND its session is not claimed by a live task card; idempotent + self-heal
 * on eviction; click publishes the new-task request and closes the source
 * menu with a synthetic Escape; claimed flips remove the row; dispose stops
 * all of it. Drives the real module through a jsdom document with a fake
 * React fiber (the shell keeps the session id in React state, not DOM).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { mountSessionTaskCardEntry } from '../src/client/session-menu-entry.ts'
import { onNewTaskRequest, type NewTaskRequest } from '../src/client/new-task-request.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'

const NOW = 1_700_000_000_000

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: 'T', description: '', prompt: 'p' }, NOW, 't1'), ...overrides }
}

/** A BoardController duck: snapshot + publish, no store/transport. */
function makeController(tasks: TaskRecord[]) {
  let listener: (() => void) | undefined
  const controller = {
    getSnapshot: () => ({ tasks }),
    subscribe: (fn: () => void): (() => void) => {
      listener = fn
      return () => { listener = undefined }
    },
    publish: (next: TaskRecord[]): void => {
      tasks.length = 0
      tasks.push(...next)
      listener?.()
    },
  }
  return controller
}

/**
 * Build the open-menu DOM: a session row carrying `menuOpen` + its React
 * fiber (host fiber -> SessionNodeItem fiber with the node/handlers shape)
 * and the portaled list (a direct body child, as the shell's portal puts
 * it) with its item viewport.
 */
function buildOpenMenu(opts: {
  session?: { id: string; title: string }
  withFiber?: boolean
}): JSDOM {
  const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body></body></html>', { url: 'http://localhost/' })
  const document = dom.window.document
  const row = document.createElement('div')
  row.className = 'sessionRow menuOpen'
  const slot = document.createElement('span')
  slot.className = 'slot'
  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = opts.session?.title ?? ''
  row.append(slot, title)
  document.body.appendChild(row)
  if (opts.withFiber !== false && opts.session !== undefined) {
    // HostComponent fiber first (DOM props, no node), then the component
    // fiber whose props carry the SessionNode shape.
    const componentFiber = {
      memoizedProps: {
        node: { id: opts.session.id, title: opts.session.title, blank: false, updatedAt: NOW, completed: false },
        onOpen: () => {}, onRename: () => {}, onFork: () => {}, onArchive: () => {},
      },
      return: null,
    }
    const hostFiber = {
      memoizedProps: { className: row.className, role: 'treeitem' },
      return: componentFiber,
    }
    ;(row as unknown as Record<string, unknown>)['__reactFiber$test'] = hostFiber
  }
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  const viewport = document.createElement('div')
  viewport.setAttribute('role', 'presentation')
  menu.appendChild(viewport)
  document.body.appendChild(menu)
  liveDom = dom
  return dom
}

/** Stub the browser globals the module touches, from a jsdom window. */
function stubBrowser(dom: JSDOM): void {
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('MutationObserver', dom.window.MutationObserver)
  vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent)
}

/** The JSDOM window of the running test; closed in afterEach so no jsdom
 * handle keeps the vitest fork's event loop alive (the run would hang on
 * exit). */
let liveDom: JSDOM | undefined

/** Flush queued mutation-observer callbacks. */
function flush(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

describe('mountSessionTaskCardEntry', () => {
  let published: NewTaskRequest[]
  let unsubscribeBus: () => void

  beforeEach(() => {
    published = []
    unsubscribeBus = onNewTaskRequest(request => { published.push(request) })
  })

  afterEach(() => {
    unsubscribeBus()
    liveDom?.window.close()
    liveDom = undefined
    vi.unstubAllGlobals()
  })

  it('injects the row into the open session menu for an unclaimed session', async () => {
    const dom = buildOpenMenu({ session: { id: 's1', title: '写周报' } })
    stubBrowser(dom)
    const controller = makeController([])
    const dispose = mountSessionTaskCardEntry(controller as never)
    await flush()

    const row = dom.window.document.querySelector('[data-dsh-taskboard-menu-row]')
    expect(row).not.toBeNull()
    // The row sits in the item viewport, after any shell items.
    expect(row?.parentElement?.getAttribute('role')).toBe('presentation')
    expect(row?.querySelector('[data-dsh-taskboard-menu-label]')?.textContent).toBe('添加为任务卡')
    dispose()
  })

  it('rescans without re-mutating the stable row (no observer loop)', async () => {
    const dom = buildOpenMenu({ session: { id: 's1', title: '写周报' } })
    stubBrowser(dom)
    const dispose = mountSessionTaskCardEntry(makeController([]) as never)
    await flush()
    const row = dom.window.document.querySelector('[data-dsh-taskboard-menu-row]') as HTMLElement | null
    const label = row?.querySelector('[data-dsh-taskboard-menu-label]') as HTMLElement | null
    const labelBefore = label?.textContent

    // A foreign mutation inside the watched subtree forces the observer
    // through another full delivery round over the stable row.
    dom.window.document.body.appendChild(dom.window.document.createElement('i'))
    await flush()
    await flush()

    // Same row and label elements, same text: the resync never re-wrote
    // them (re-writing identical text records another mutation and the
    // callback would starve the event loop forever).
    expect(dom.window.document.querySelector('[data-dsh-taskboard-menu-row]')).toBe(row)
    expect(row?.querySelector('[data-dsh-taskboard-menu-label]')).toBe(label)
    expect(label?.textContent).toBe(labelBefore)
    dispose()
  })

  it('stays out while the session is claimed by a live task card', async () => {
    const dom = buildOpenMenu({ session: { id: 's1', title: '写周报' } })
    stubBrowser(dom)
    const controller = makeController([
      makeTask({ status: 'done', executions: [{ id: 'e1', sessionId: 's1', startedAt: NOW - 60_000, endedAt: NOW - 30_000, result: 'succeeded', error: undefined }] }),
    ])
    const dispose = mountSessionTaskCardEntry(controller as never)
    await flush()

    expect(dom.window.document.querySelector('[data-dsh-taskboard-menu-row]')).toBeNull()
    dispose()
  })

  it('publishes the request and closes the source menu on click', async () => {
    const dom = buildOpenMenu({ session: { id: 's1', title: '写周报' } })
    stubBrowser(dom)
    const document = dom.window.document
    let escapes = 0
    document.addEventListener('keydown', (event: Event) => {
      const keyEvent = event as KeyboardEvent
      if (keyEvent instanceof dom.window.KeyboardEvent && keyEvent.key === 'Escape') escapes += 1
    })
    const dispose = mountSessionTaskCardEntry(makeController([]) as never)
    await flush()

    const button = dom.window.document.querySelector('[data-dsh-taskboard-menu-row] button') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    button!.click()

    expect(published).toEqual([{ sourceSession: { id: 's1', title: '写周报' } }])
    expect(escapes).toBe(1)
    dispose()
  })

  it('re-injects after the shell evicts the row (self-heal)', async () => {
    const dom = buildOpenMenu({ session: { id: 's1', title: '写周报' } })
    stubBrowser(dom)
    const dispose = mountSessionTaskCardEntry(makeController([]) as never)
    await flush()
    expect(dom.window.document.querySelectorAll('[data-dsh-taskboard-menu-row]')).toHaveLength(1)

    // Simulate a re-render eviction: React replaces the viewport children.
    dom.window.document.querySelector('[data-dsh-taskboard-menu-row]')?.remove()
    await flush()

    expect(dom.window.document.querySelectorAll('[data-dsh-taskboard-menu-row]')).toHaveLength(1)
    dispose()
  })

  it('skips rows without a readable React fiber', async () => {
    const dom = buildOpenMenu({ session: { id: 's1', title: '写周报' }, withFiber: false })
    stubBrowser(dom)
    const dispose = mountSessionTaskCardEntry(makeController([]) as never)
    await flush()

    expect(dom.window.document.querySelector('[data-dsh-taskboard-menu-row]')).toBeNull()
    dispose()
  })

  it('falls back to the visible row title for a blank session (empty node.title)', async () => {
    const dom = buildOpenMenu({ session: { id: 's1', title: '' } })
    stubBrowser(dom)
    const document = dom.window.document
    const visibleTitle = document.querySelector('.title') as HTMLSpanElement | null
    visibleTitle!.textContent = '新会话'
    const dispose = mountSessionTaskCardEntry(makeController([]) as never)
    await flush()

    const button = document.querySelector('[data-dsh-taskboard-menu-row] button') as HTMLButtonElement | null
    button!.click()
    expect(published).toEqual([{ sourceSession: { id: 's1', title: '新会话' } }])
    dispose()
  })

  it('removes the row when a task claims the session while the menu is open', async () => {
    const dom = buildOpenMenu({ session: { id: 's1', title: '写周报' } })
    stubBrowser(dom)
    const controller = makeController([])
    const dispose = mountSessionTaskCardEntry(controller as never)
    await flush()
    expect(dom.window.document.querySelector('[data-dsh-taskboard-menu-row]')).not.toBeNull()

    controller.publish([
      makeTask({ status: 'todo', executions: [{ id: 'e1', sessionId: 's1', startedAt: NOW - 60_000, endedAt: NOW - 30_000, result: 'succeeded', error: undefined }] }),
    ])

    expect(dom.window.document.querySelector('[data-dsh-taskboard-menu-row]')).toBeNull()
    dispose()
  })

  it('does nothing for a menu of another surface (no open session row)', async () => {
    const dom = buildOpenMenu({ session: { id: 's1', title: '写周报' }, withFiber: false })
    stubBrowser(dom)
    // Kill the guard: the row is no longer menuOpen (menu belongs to another surface).
    const row = dom.window.document.querySelector('.sessionRow') as HTMLElement | null
    row!.className = 'sessionRow'
    const dispose = mountSessionTaskCardEntry(makeController([]) as never)
    await flush()

    expect(dom.window.document.querySelector('[data-dsh-taskboard-menu-row]')).toBeNull()
    dispose()
  })

  it('dispose stops re-injection', async () => {
    const dom = buildOpenMenu({ session: { id: 's1', title: '写周报' } })
    stubBrowser(dom)
    const controller = makeController([])
    const dispose = mountSessionTaskCardEntry(controller as never)
    dispose()

    // Menu reopens after dispose: no observer left to heal.
    dom.window.document.querySelector('[data-dsh-taskboard-menu-row]')?.remove()
    await flush()
    expect(dom.window.document.querySelector('[data-dsh-taskboard-menu-row]')).toBeNull()
  })
})
