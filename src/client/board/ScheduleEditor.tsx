/**
 * The reminder-app style schedule editor: a repeat-frequency tab row
 * (daily / weekly / monthly / interval / custom), weekday chips with quick
 * weekdays/weekends groups, an exact hour:minute picker, a day-of-month
 * picker, interval steppers with quick steps, and a free-form 5-field cron
 * tab for exotic expressions. Serializes into the host's plain cron model
 * through schedule-spec; the scheduler itself is untouched.
 *
 * Emission contract: spec-tab controls emit the derived cron immediately
 * (like the old presets); the custom tab emits on commit (blur / Enter),
 * mirroring the old text-input behavior. Invalid intermediate states keep
 * the last valid cron instead of breaking an armed schedule.
 */
import { useEffect, useRef, useState } from 'react'
import { isValidCron, nextRunAtMs } from '../../core/schedule.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import {
  QUICK_INTERVAL_HOURS,
  QUICK_INTERVAL_MINUTES,
  SCHEDULE_TABS,
  WEEKDAY_GROUPS,
  WEEKDAY_ORDER,
  cronToSpec,
  describeSpec,
  specToCron,
  type ScheduleSpec,
} from '../schedule-spec.ts'
import css from '../board.module.css'
import { formatHostTimestamp } from './TaskCard.tsx'

export interface ScheduleEditorProps {
  /** The persisted / draft cron (empty string = no schedule yet). */
  cron: string
  /** Called with a confirmed cron: spec-tab changes immediately, custom-text on commit. */
  onCronChange: (cron: string) => void
  /** Show the derived next-run preview line (creation flows; the detail panel tracks the Host-managed next run itself). */
  showPreview?: boolean
  /** The host local time zone for the preview line. */
  timeZone?: string
  /** Disable every control (a pending Host operation is in flight). */
  disabled?: boolean
}

/** Tab kinds the editor offers, in render order. */
const TAB_KEYS: readonly TaskBoardKey[] = SCHEDULE_TABS.map(kind => `detail.schedule.freq.${kind}` as TaskBoardKey)

/** The schedule editor. */
export function ScheduleEditor({ cron, onCronChange, showPreview = false, timeZone, disabled = false }: ScheduleEditorProps) {
  const [spec, setSpec] = useState<ScheduleSpec>(() => cronToSpec(cron))
  const [customText, setCustomText] = useState<string>(() => {
    const initial = cronToSpec(cron)
    return initial.kind === 'custom' ? initial.cron : ''
  })
  const [customError, setCustomError] = useState<string | undefined>(undefined)

  // The last value handed to onCronChange (or the incoming cron when no
  // emit has happened yet): the self-echo guard for the prop sync.
  const emittedRef = useRef(cron)
  // Last structurally valid serialization: kept alive when the custom tab
  // or an empty weekday set produces an invalid intermediate state.
  const lastValidRef = useRef<string>(specToCron(cronToSpec(cron)) ?? cron)

  /** The editor's current effective cron (valid value, never '' when one exists). */
  const effectiveCron = (): string => {
    if (spec.kind === 'custom') {
      const trimmed = customText.trim()
      return trimmed !== '' && isValidCron(trimmed) ? trimmed : (lastValidRef.current !== '' ? lastValidRef.current : '')
    }
    return specToCron(spec) ?? (lastValidRef.current !== '' ? lastValidRef.current : '')
  }

  /** Hand a confirmed cron to the parent and mark it emitted. */
  const commit = (next: ScheduleSpec): void => {
    if (disabled) return
    const nextCron = specToCron(next)
    if (nextCron === null) return // invalid spec (e.g. no weekday picked): keep the last valid value
    setSpec(next)
    lastValidRef.current = nextCron
    emittedRef.current = nextCron
    onCronChange(nextCron)
  }

  /** Switch tabs, carrying over the shared values (time, weekday set, interval step). */
  const switchTab = (kind: ScheduleSpec['kind']): void => {
    if (disabled || kind === spec.kind) return
    if (kind === 'custom') {
      // Pre-fill the raw text with the current effective cron (if any);
      // nothing is committed until the user blurs / presses Enter.
      setSpec({ kind: 'custom', cron: '' })
      setCustomText(effectiveCron())
      setCustomError(undefined)
      return
    }
    const time = 'hour' in spec ? { hour: spec.hour, minute: spec.minute } : { hour: 9, minute: 0 }
    const days = spec.kind === 'weekly' ? spec.days : [1, 2, 3, 4, 5]
    const next: ScheduleSpec =
      kind === 'daily' ? { kind: 'daily', ...time }
      : kind === 'weekly' ? { kind: 'weekly', days, ...time }
      : kind === 'monthly' ? { kind: 'monthly', day: spec.kind === 'monthly' ? spec.day : 1, ...time }
      : { kind: 'interval', unit: spec.kind === 'interval' ? spec.unit : 'minute', every: spec.kind === 'interval' ? spec.every : 10 }
    commit(next)
  }

  /** Commit the custom text (blur / Enter). */
  const commitCustom = (): void => {
    if (disabled) return
    const trimmed = customText.trim()
    if (trimmed === '' || !isValidCron(trimmed)) {
      setCustomError(t('detail.schedule.invalid'))
      return
    }
    setCustomError(undefined)
    lastValidRef.current = trimmed
    emittedRef.current = trimmed
    onCronChange(trimmed)
  }

  // Keep the editor in sync when the cron changes underneath (another
  // surface edited it, or the Host confirmed a persist): re-derive the
  // structured spec unless the change is our own echo.
  useEffect(() => {
    if (cron === emittedRef.current) return
    const next = cronToSpec(cron)
    setSpec(next)
    setCustomText(next.kind === 'custom' ? next.cron : '')
    setCustomError(undefined)
    if (next.kind !== 'custom' || isValidCron(next.cron)) {
      lastValidRef.current = specToCron(next) ?? lastValidRef.current
    }
    emittedRef.current = cron
  }, [cron])

  // Mount: push the derived default cron up so a fresh task's submit path
  // sees a valid expression even before the user touches anything.
  useEffect(() => {
    const effective = effectiveCron()
    if (effective !== '' && effective !== emittedRef.current) {
      lastValidRef.current = effective
      emittedRef.current = effective
      onCronChange(effective)
    }
    // Intentionally mount-only: the prop sync above owns later updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setDays = (days: number[]): void => {
    if (spec.kind !== 'weekly') return
    commit({ ...spec, days })
  }

  const toggleDay = (day: number): void => {
    if (spec.kind !== 'weekly') return
    const days = spec.days.includes(day) ? spec.days.filter(item => item !== day) : [...spec.days, day]
    setDays(days)
  }

  const setTime = (patch: Partial<{ hour: number; minute: number }>): void => {
    if (spec.kind !== 'daily' && spec.kind !== 'weekly' && spec.kind !== 'monthly') return
    commit({ ...spec, ...patch } as ScheduleSpec)
  }

  const setMonthDay = (day: number): void => {
    if (spec.kind !== 'monthly') return
    commit({ ...spec, day })
  }

  const setUnit = (unit: 'minute' | 'hour'): void => {
    if (spec.kind !== 'interval') return
    // Clamp the step when the unit changes (59 minutes != 59 hours).
    const every = unit === 'minute' ? Math.min(spec.every, 59) : Math.min(spec.every, 23)
    commit({ ...spec, unit, every })
  }

  const setEvery = (every: number): void => {
    if (spec.kind !== 'interval') return
    commit({ ...spec, every })
  }

  const numberFrom = (event: { target: HTMLInputElement }, min: number, max: number): number | undefined => {
    const value = Number.parseInt(event.target.value, 10)
    if (Number.isNaN(value)) return undefined
    return Math.min(max, Math.max(min, value))
  }

  const weeklyEmpty = spec.kind === 'weekly' && spec.days.length === 0
  const effective = effectiveCron()
  const preview = showPreview && effective !== '' ? nextRunAtMs(effective, Date.now()) : undefined

  return (
    <div className={css.scheduleEditor}>
      <div className={css.scheduleFreq} aria-label={t('detail.schedule.freq')}>
        {SCHEDULE_TABS.map((tab, index) => (
          <button
            key={tab}
            type="button"
            className={css.scheduleFreqBtn}
            data-active={spec.kind === tab}
            disabled={disabled}
            aria-label={t(TAB_KEYS[index])}
            onClick={() => { switchTab(tab) }}
          >
            {t(TAB_KEYS[index])}
          </button>
        ))}
      </div>

      {spec.kind === 'weekly' && (
        <div className={css.scheduleSpecRow}>
          {WEEKDAY_GROUPS.map(group => (
            <button
              key={group.key}
              type="button"
              className={css.scheduleQuickChip}
              disabled={disabled}
              onClick={() => { setDays([...group.days]) }}
            >
              {t(group.key)}
            </button>
          ))}
          <div className={css.scheduleDayChips} aria-label={t('detail.schedule.weekdays')}>
            {WEEKDAY_ORDER.map(day => (
              <button
                key={day}
                type="button"
                className={css.scheduleDayChip}
                data-on={spec.days.includes(day)}
                disabled={disabled}
                onClick={() => { toggleDay(day) }}
              >
                {t(`detail.schedule.day.${day}` as TaskBoardKey)}
              </button>
            ))}
          </div>
        </div>
      )}

      {weeklyEmpty && <p className={css.formError}>{t('detail.schedule.invalidDays')}</p>}

      {(spec.kind === 'daily' || spec.kind === 'weekly' || spec.kind === 'monthly') && (
        <div className={css.scheduleSpecRow}>
          {spec.kind === 'monthly' && (
            <label className={css.scheduleTimeField}>
              <span>{t('detail.schedule.monthDay')}</span>
              <select
                className={css.scheduleUnitSelect}
                value={spec.day}
                disabled={disabled}
                aria-label={t('detail.schedule.monthDay')}
                onChange={event => { setMonthDay(Number(event.target.value)) }}
              >
                {Array.from({ length: 31 }, (_, index) => index + 1).map(day => (
                  <option key={day} value={day}>{day}</option>
                ))}
              </select>
            </label>
          )}
          <div className={css.scheduleTimeField}>
            <span>{t('detail.schedule.time')}</span>
            <input
              type="number"
              min={0}
              max={23}
              step={1}
              className={css.scheduleTimeInput}
              value={String(spec.hour)}
              disabled={disabled}
              aria-label={`${t('detail.schedule.time')} ${String(spec.hour)}`}
              onChange={event => {
                const value = numberFrom(event, 0, 23)
                if (value !== undefined) setTime({ hour: value })
              }}
            />
            <span className={css.scheduleTimeColon}>:</span>
            <input
              type="number"
              min={0}
              max={59}
              step={1}
              className={css.scheduleTimeInput}
              value={String(spec.minute)}
              disabled={disabled}
              aria-label={`${t('detail.schedule.time')} ${String(spec.minute)}`}
              onChange={event => {
                const value = numberFrom(event, 0, 59)
                if (value !== undefined) setTime({ minute: value })
              }}
            />
          </div>
        </div>
      )}

      {spec.kind === 'interval' && (
        <div className={css.scheduleSpecRow}>
          <label className={css.scheduleTimeField}>
            <span>{t('detail.schedule.every')}</span>
            <input
              type="number"
              min={1}
              max={spec.unit === 'minute' ? 59 : 23}
              step={1}
              className={css.scheduleEveryInput}
              value={String(spec.every)}
              disabled={disabled}
              aria-label={t('detail.schedule.every')}
              onChange={event => {
                const value = numberFrom(event, 1, spec.unit === 'minute' ? 59 : 23)
                if (value !== undefined) setEvery(value)
              }}
            />
            <select
              className={css.scheduleUnitSelect}
              value={spec.unit}
              disabled={disabled}
              aria-label={t('detail.schedule.freq.interval')}
              onChange={event => { setUnit(event.target.value === 'hour' ? 'hour' : 'minute') }}
            >
              <option value="minute">{t('detail.schedule.unit.minute')}</option>
              <option value="hour">{t('detail.schedule.unit.hour')}</option>
            </select>
          </label>
          <div className={css.scheduleQuickChips}>
            {(spec.unit === 'minute' ? QUICK_INTERVAL_MINUTES : QUICK_INTERVAL_HOURS).map(step => (
              <button
                key={step}
                type="button"
                className={css.scheduleQuickChip}
                data-on={spec.every === step}
                disabled={disabled}
                onClick={() => { setEvery(step) }}
              >
                {step}
              </button>
            ))}
          </div>
        </div>
      )}

      {spec.kind === 'custom' && (
        <div className={css.scheduleRow}>
          <input
            className={`${css.input} ${css.scheduleInput}${customError !== undefined ? ` ${css.scheduleInputInvalid}` : ''}`}
            value={customText}
            disabled={disabled}
            placeholder="0 9 * * 1,3,5"
            spellCheck={false}
            aria-label={t('detail.schedule.cron')}
            onChange={event => { setCustomText(event.target.value); setCustomError(undefined) }}
            onBlur={() => { commitCustom() }}
            onKeyDown={event => { if (event.key === 'Enter') commitCustom() }}
          />
          {customError !== undefined && <p className={css.formError}>{customError}</p>}
        </div>
      )}

      {spec.kind !== 'custom' && effective !== '' && (
        <p className={css.scheduleDesc}>{describeSpec(spec, t)}</p>
      )}
      {preview !== undefined && (
        <p className={css.scheduleMeta}>{t('detail.schedule.nextRun')} {formatHostTimestamp(preview, timeZone)}</p>
      )}
    </div>
  )
}
