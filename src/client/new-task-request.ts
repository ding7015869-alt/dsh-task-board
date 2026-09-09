/**
 * New-task modal request bus (dsh-task-board client).
 *
 * Surfaces that can trigger the new-task form from OUTSIDE the board tree —
 * the session-row "add as task card" menu injection — publish a request; the
 * overlay owner (session-new-task-overlay.tsx) subscribes and renders the
 * modal in a body-level root, so it stays visible even while the center
 * column is handed back to the conversation (a sidebar row click closes the
 * board panel; the board's own "+ New Task" button keeps its in-view copy).
 */

/** A new-task request and the prefill a triggering surface can supply. */
export interface NewTaskRequest {
  /**
   * The session the card is created from: the modal pre-fills the title with
   * the session's title. Absent for the board's own new-task button.
   */
  sourceSession?: { id: string; title: string }
}

type Listener = (request: NewTaskRequest) => void

let listener: Listener | undefined

/**
 * Publish a new-task request to the overlay owner. No-op while the overlay
 * is not mounted (settings disabled) — the board's own button is unaffected.
 */
export function requestNewTask(request: NewTaskRequest): void {
  listener?.(request)
}

/**
 * Subscribe as the overlay owner. Replacement semantics: one open-at-a-time
 * modal means one owner; mounting a second overlay detaches the first.
 * Returns the unsubscribe.
 */
export function onNewTaskRequest(next: Listener): () => void {
  const previous = listener
  listener = next
  return () => {
    if (listener === next) listener = previous
  }
}
