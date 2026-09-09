/**
 * Standalone new-task modal root for the session-row trigger.
 *
 * The board's own "+ New Task" button renders NewTaskModal INSIDE the center
 * column's board view. The session-row trigger fires while the board panel
 * is closed — clicking a sidebar row hands the center column back to the
 * conversation (panel-mount-core's capture listener) — so an in-view copy
 * would be invisible. This owner subscribes to the request bus
 * (new-task-request.ts) and renders the same modal in a body-level React
 * root, one at a time. The form itself is shared: Host-authoritative create
 * through the controller, close only after the Host confirms.
 */
import { createRoot, type Root } from 'react-dom/client'
import type { BoardController } from '../core/controller.ts'
import { DEFAULT_PROJECT_ID } from '../core/projects.ts'
import { NewTaskModal } from './board/NewTaskModal.tsx'
import { onNewTaskRequest, type NewTaskRequest } from './new-task-request.ts'
import type { LocaleRefreshSource } from './sidebar-entry.ts'

/**
 * Mount the overlay owner. Cheap while idle: the body container is created
 * lazily on the first request and the root renders null until then.
 * @param controller - the board controller (create goes through it).
 * @param locale - locale-change source; re-renders an open form on switch.
 * @returns disposer unmounting the tree and removing the container.
 */
export function mountNewTaskOverlay(controller: BoardController, locale?: LocaleRefreshSource): () => void {
  let container: HTMLDivElement | undefined
  let root: Root | undefined
  let open = false
  let request: NewTaskRequest | undefined
  let unsubscribeLocale: (() => void) | undefined

  const snapshot = (): void => {
    if (root === undefined) return
    root.render(
      open && request !== undefined
        ? (
          <NewTaskModal
            controller={controller}
            onClose={close}
            projects={controller.getSnapshot().projects ?? []}
            defaultProjectId={controller.getSnapshot().defaultProjectId ?? DEFAULT_PROJECT_ID}
            sourceSession={request.sourceSession}
          />
        )
        : null,
    )
  }

  const ensure = (): void => {
    if (root !== undefined) return
    container = document.createElement('div')
    container.dataset.dshTaskboardNewTaskOverlay = ''
    document.body.appendChild(container)
    root = createRoot(container)
    snapshot()
  }

  const close = (): void => {
    open = false
    request = undefined
    snapshot()
  }

  const unsubscribe = onNewTaskRequest((next): void => {
    open = true
    request = next
    ensure()
    snapshot()
  })
  unsubscribeLocale = locale?.subscribe(() => {
    // Re-render the open form with the new language; a closed overlay
    // re-renders on its next open (labels read the active locale lazily).
    if (root !== undefined && open) snapshot()
  })

  return () => {
    unsubscribe()
    unsubscribeLocale?.()
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}
