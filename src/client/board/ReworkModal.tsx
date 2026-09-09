/**
 * Rework/reject modal: reject a settled card with modification requirements.
 * On submit the Host ledger appends the note to the card's rework history and
 * opens the rework execution (the fix continues in the original execution
 * session); while the request is in flight the overlay stays open, and it
 * closes once the Host accepts (or the user cancels).
 */
import { useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import { REWORK_NOTE_MAX_LENGTH } from '../../core/rework.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'
import { ModalShell } from './TaskForm.tsx'

export function ReworkModal({ controller, task, onClose }: { controller: BoardController; task: TaskRecord; onClose: () => void }) {
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)

  const submit = (): void => {
    const trimmed = note.trim()
    if (trimmed === '') {
      setError(t('rework.required'))
      return
    }
    if (trimmed.length > REWORK_NOTE_MAX_LENGTH) {
      setError(t('rework.tooLong', { max: String(REWORK_NOTE_MAX_LENGTH) }))
      return
    }
    setError(undefined)
    setPending(true)
    void controller.reworkTask(task.id, trimmed).then(accepted => {
      // The Host owns the rework transition (or the park-at-cap deferral):
      // close on acceptance so the card state stays authoritative; keep the
      // overlay open on refusal so the note is not lost.
      if (accepted) onClose()
      else setPending(false)
    })
  }

  return (
    <ModalShell
      ariaLabel={t('rework.title')}
      title={t('rework.title')}
      error={error}
      pending={pending}
      submitLabel={pending ? t('board.pending') : t('rework.submit')}
      onSubmit={submit}
      onClose={() => { if (!pending) onClose() }}
    >
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('rework.note')}</span>
        <textarea
          className={css.input}
          rows={4}
          autoFocus
          value={note}
          placeholder={t('rework.notePlaceholder')}
          onChange={event => { setNote(event.target.value); setError(undefined) }}
        />
      </label>
      <p className={css.detailMeta}>{t('detail.reworkHint')}</p>
    </ModalShell>
  )
}
