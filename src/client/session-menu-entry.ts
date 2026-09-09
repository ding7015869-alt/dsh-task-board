/**
 * Session-row "add as task card" menu injection (dsh-task-board client).
 *
 * The shell's session row renders its own ellipsis menu (ui-workspace
 * Rows.tsx `SessionNodeItem`): a portaled list fixed-positioned in
 * `document.body`, items built from a closed vocabulary the plugin cannot
 * extend (rename/fork/archive; no slot exists for external plugins). Same
 * self-healing pattern as the sidebar entry — a body-level MutationObserver
 * watches the portaled list appear and reappear and appends a plain-DOM
 * "add as task card" row when the open menu's session is NOT claimed by a
 * live task card (`taskClaimedSessionIds` on the controller snapshot:
 * every non-archived task's newest execution session, all retained
 * execution sessions, and its freeze provenance session). Claimed sessions
 * get no row — the card already owns them.
 *
 * The row's session identity comes from the open row's React fiber: the
 * shell keeps the session id in React state, not in DOM attributes, so the
 * walk reads the `SessionNodeItem` fiber's `node` prop by shape (string
 * `id` plus `onOpen`/`onRename` functions survive minification; component
 * names do not). An unreadable fiber is skipped — no injection beats a
 * wrong injection.
 *
 * The row is plain DOM with this module's hashed classes, so it can never
 * disturb the shell's reconciliation; it dies with the menu list on close
 * and re-injects itself (the same observer) if a re-render evicts it while
 * the menu stays open. Click = publish the new-task request
 * (new-task-request.ts, owned by session-new-task-overlay.tsx) + a
 * synthetic document-level Escape keydown, which the Menu primitive's
 * document keydown listener turns into a close.
 */
import { taskClaimedSessionIds } from '../core/tasks.ts'
import type { BoardController } from '../core/controller.ts'
import { requestNewTask } from './new-task-request.ts'
import { t } from './locales.ts'
import type { LocaleRefreshSource } from './sidebar-entry.ts'
import css from './session-menu-entry.module.css'

/** The open session row: hashed CSS-module classes, partial-matched (family convention). */
const OPEN_ROW_SELECTOR = '[class*="sessionRow"][class*="menuOpen"]'
/** Idempotency + self-heal marker on the injected row. */
const ROW_MARK = 'data-dsh-taskboard-menu-row'
/** The label span inside the injected row (locale refresh hook). */
const LABEL_MARK = 'data-dsh-taskboard-menu-label'

/** 16px plus glyph (ui-primitives `IconPlusOutline16`, the board's own new-task icon). */
const PLUS_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z" fill="currentColor"/></svg>'

/** The session identity the injected row publishes. */
interface SessionRef {
  id: string
  title: string
}

/** A React fiber node (the only shape this reader touches). */
interface FiberNode {
  return: FiberNode | null
  memoizedProps: unknown
}

/** The fiber key React attaches to host instances (`__reactFiber$<tag>`). */
function fiberOf(element: HTMLElement): FiberNode | null {
  const keys = Object.keys(element)
  for (const key of keys) {
    if (key.startsWith('__reactFiber$')) {
      const found = (element as unknown as Record<string, FiberNode | null | undefined>)[key]
      return found ?? null
    }
  }
  return null
}

/**
 * Read the open row's session from its React fiber chain: the first fiber
 * whose props carry a `node` by the SessionNode shape — string `id`, plus
 * the `onOpen`/`onRename` handlers — is the `SessionNodeItem` component
 * (its wrapper, HoverCard, carries elements, not the node object).
 * undefined when the chain never matches (fiber unreadable: skip).
 */
function readSessionFromRow(row: HTMLElement): SessionRef | undefined {
  let fiber: FiberNode | null = fiberOf(row)
  while (fiber !== null) {
    const props = fiber.memoizedProps as
      | { node?: unknown; onOpen?: unknown; onRename?: unknown }
      | null
      | undefined
    if (props !== null && props !== undefined && typeof props === 'object') {
      const node = props.node
      if (node !== null && node !== undefined && typeof node === 'object') {
        const shape = node as { id?: unknown; title?: unknown }
        if (
          typeof shape.id === 'string' && shape.id !== ''
          && typeof props.onOpen === 'function'
          && typeof props.onRename === 'function'
        ) {
          const rawTitle = typeof shape.title === 'string' ? shape.title : ''
          return { id: shape.id, title: visibleTitle(row, rawTitle) }
        }
      }
    }
    fiber = fiber.return
  }
  return undefined
}

/**
 * The title to prefill: the raw session title, or — for a blank session
 * (empty title) — the row's visible title text so the prefill still names
 * what the user is looking at.
 */
function visibleTitle(row: HTMLElement, rawTitle: string): string {
  if (rawTitle !== '') return rawTitle
  const span = row.querySelector('[class*="title"]')
  return span?.textContent?.trim() ?? ''
}

/**
 * The currently open portaled menu list: a `role="menu"` div that is a
 * DIRECT child of document.body (portaled lists mount there; in-place menu
 * lists live inside the row and are excluded). Only one menu is open at a
 * time (the Menu primitive closes the previous on outside pointerdown), so
 * any such list while a session row is menuOpen is that row's menu.
 */
function openPortaledMenu(): HTMLElement | undefined {
  const children = Array.from(document.body.children)
  for (const child of children) {
    // Duck-type instead of `instanceof HTMLElement`: the module must stay
    // loadable in environments without the global constructor (tests run in
    // node against a jsdom document).
    const element = child as HTMLElement
    if (element.nodeType === 1 && element.getAttribute('role') === 'menu') return element
  }
  return undefined
}

/** Remove an injected row (and its hairline) from a menu list. */
function removeInjected(menu: HTMLElement): void {
  menu.querySelector(`[${ROW_MARK}]`)?.remove()
}

/** Build + append the injected row under the shell's own items. */
function injectRow(menu: HTMLElement, session: SessionRef): void {
  const existing = menu.querySelector<HTMLElement>(`[${ROW_MARK}]`)
  if (existing !== null) {
    // Self-heal in place: refresh the label (locale switched while open).
    // Touch the DOM only when the value actually changed: re-setting
    // identical text still records a childList mutation, which would
    // re-trigger this very observer's rescan forever (a callback must
    // never mutate what it observes into another record of itself).
    const label = existing.querySelector<HTMLElement>(`[${LABEL_MARK}]`)
    if (label !== null && label.textContent !== t('menu.addTaskCard')) {
      label.textContent = t('menu.addTaskCard')
    }
    return
  }
  const wrap = document.createElement('div')
  wrap.className = css.wrap
  wrap.setAttribute(ROW_MARK, '')
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('role', 'menuitem')
  button.className = css.item
  button.title = t('menu.addTaskCardHint')
  const icon = document.createElement('span')
  icon.className = css.itemIcon
  icon.innerHTML = PLUS_SVG
  const label = document.createElement('span')
  label.className = css.itemLabel
  label.setAttribute(LABEL_MARK, '')
  label.textContent = t('menu.addTaskCard')
  button.append(icon, label)
  wrap.append(button)
  // Items live in the list's `role="presentation"` viewport; the plain list
  // is the fallback (no session menu in practice carries a footer).
  const target = menu.querySelector<HTMLElement>('[role="presentation"]') ?? menu
  // Close the source menu the way the Menu primitive itself closes on
  // Escape (its document-level keydown listener); a synthetic pointerdown
  // would not reach that path.
  button.addEventListener('click', () => {
    requestNewTask({ sourceSession: { id: session.id, title: session.title } })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  target.append(wrap)
}

/**
 * Mount the session-row menu injection.
 * @param controller - task roster source (the claimed-session set is
 *   recomputed on every task snapshot change).
 * @param locale - locale-change source; refreshes an open row's label on a
 *   language switch.
 * @returns disposer disconnecting the observer and unsubscribing.
 */
export function mountSessionTaskCardEntry(controller: BoardController, locale?: LocaleRefreshSource): () => void {
  const disposers: Array<() => void> = []

  let claimed = taskClaimedSessionIds(controller.getSnapshot().tasks)
  const unsubscribeTasks = controller.subscribe(() => {
    claimed = taskClaimedSessionIds(controller.getSnapshot().tasks)
    // A task claiming/releasing the open row's session flips the row's
    // visibility while the menu is open — rescan immediately.
    scan()
  })
  disposers.push(unsubscribeTasks)

  function scan(): void {
    const row = document.querySelector<HTMLElement>(OPEN_ROW_SELECTOR) ?? undefined
    const menu = openPortaledMenu()
    if (row === undefined || menu === undefined) return
    const session = readSessionFromRow(row)
    if (session === undefined || claimed.has(session.id)) {
      removeInjected(menu)
      return
    }
    injectRow(menu, session)
  }

  // The menu list mounts/unmounts on document.body and its viewport's items
  // churn on re-render: childList on the body subtree catches both, and the
  // callback resynchronizes (idempotent) at whatever state it fires in.
  const observer = new MutationObserver(() => {
    try {
      scan()
    } catch (error) {
      // DOM failures degrade the feature, never the GUI.
      console.error('[dsh-task-board] session menu entry scan failed:', error)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })

  const unsubscribeLocale = locale?.subscribe(() => {
    scan()
  })
  if (unsubscribeLocale !== undefined) disposers.push(unsubscribeLocale)

  // A menu may already be open when this mount lands.
  scan()

  return () => {
    observer.disconnect()
    for (const dispose of disposers.splice(0)) dispose()
    // An open menu still mounted: leave it to its own close (the row dies
    // with the portaled list).
  }
}
