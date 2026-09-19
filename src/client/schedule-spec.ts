/**
 * Structured schedule spec <-> 5-field cron bridge for the schedule editor.
 *
 * The reminder-app style UI (day-of-week chips, exact time-of-day, interval
 * steppers, day-of-month picker) serializes into the host's plain 5-field
 * cron ledger model without touching the scheduler: every spec maps to one
 * cron expression, and an existing cron expression parses back into the
 * most specific structured tab it can be described by (anything exotic
 * stays in the free-form custom tab).
 */
import { isValidCron, parseCron } from '../core/schedule.ts'
import type { TaskBoardKey } from './locales.ts'

/** The structured schedule shape the editor works on. */
export type ScheduleSpec =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; days: number[]; hour: number; minute: number }
  | { kind: 'monthly'; day: number; hour: number; minute: number }
  | { kind: 'interval'; unit: 'minute' | 'hour'; every: number }
  | { kind: 'custom'; cron: string }

/** Spec kinds, in tab order. */
export const SCHEDULE_TABS: ReadonlyArray<ScheduleSpec['kind']> = ['daily', 'weekly', 'monthly', 'interval', 'custom']

/** UI weekday order: Monday first (0 keeps the JS Date convention = Sunday). */
export const WEEKDAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0]

/** Quick-select weekday groups (reminder-app style). */
export const WEEKDAY_GROUPS: ReadonlyArray<{ key: TaskBoardKey; days: number[] }> = [
  { key: 'detail.schedule.quick.weekdays', days: [1, 2, 3, 4, 5] },
  { key: 'detail.schedule.quick.weekends', days: [6, 0] },
]

/** Quick-pick interval steps per unit. */
export const QUICK_INTERVAL_MINUTES: readonly number[] = [5, 10, 15, 30]
export const QUICK_INTERVAL_HOURS: readonly number[] = [1, 2, 3, 6, 12]

/** "09:05" style wall-clock time. */
export function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * Serialize a spec to a cron expression.
 * @returns the cron string, or null when the spec is structurally invalid
 * (weekly without any day) — the editor keeps the last valid value then.
 */
export function specToCron(spec: ScheduleSpec): string | null {
  switch (spec.kind) {
    case 'daily':
      return `${spec.minute} ${spec.hour} * * *`
    case 'weekly': {
      if (spec.days.length === 0) return null
      const list = spec.days
        .map(day => (day === 0 ? 7 : day))
        .sort((a, b) => a - b)
        .join(',')
      return `${spec.minute} ${spec.hour} * * ${list}`
    }
    case 'monthly':
      if (spec.day < 1 || spec.day > 31) return null
      return `${spec.minute} ${spec.hour} ${spec.day} * *`
    case 'interval':
      if (spec.every < 1) return null
      if (spec.unit === 'minute') {
        if (spec.every > 59) return null
        return spec.every === 1 ? '* * * * *' : `*/${spec.every} * * * *`
      }
      if (spec.every > 23) return null
      return spec.every === 1 ? '0 * * * *' : `0 */${spec.every} * * *`
    case 'custom':
      return isValidCron(spec.cron) ? spec.cron.trim() : null
  }
}

/**
 * Parse an existing cron expression into the most specific structured spec
 * it can be described by. Unparseable and exotic expressions fall back to
 * the custom tab carrying the raw text. Empty input starts on the daily
 * tab with the common 09:00 default (fresh task).
 */
export function cronToSpec(cron: string): ScheduleSpec {
  const trimmed = cron.trim()
  if (trimmed === '') return { kind: 'daily', hour: 9, minute: 0 }
  const parsed = parseCron(trimmed)
  if (parsed === null) return { kind: 'custom', cron: trimmed }

  // Unrestricted day/weekday/month: a single time-of-day means daily; a
  // uniform step set means an interval (every N minutes / every N hours).
  if (parsed.dayWildcard && parsed.weekdayWildcard && parsed.months.size === 12) {
    // `*/N` on minutes: a genuine step set, or the full 0-59 range (every
    // minute). A lone {0} is NOT "every minute" — it is the "on the hour"
    // marker of the hour-interval case below.
    const minuteStep = stepOf(parsed.minutes)
    if (parsed.hours.size === 24 && minuteStep !== undefined && (minuteStep > 1 || parsed.minutes.size === 60)) {
      return { kind: 'interval', unit: 'minute', every: minuteStep }
    }
    const hourStep = stepOf(parsed.hours)
    if (parsed.minutes.size === 1 && parsed.minutes.has(0) && hourStep !== undefined) {
      return { kind: 'interval', unit: 'hour', every: hourStep }
    }
    if (parsed.hours.size === 1 && parsed.minutes.size === 1) {
      return { kind: 'daily', hour: [...parsed.hours][0], minute: [...parsed.minutes][0] }
    }
  }

  // Unrestricted day + restricted weekday: weekly on those days.
  if (parsed.dayWildcard && !parsed.weekdayWildcard && parsed.months.size === 12 && parsed.hours.size === 1 && parsed.minutes.size === 1) {
    return { kind: 'weekly', days: [...parsed.weekdays], hour: [...parsed.hours][0], minute: [...parsed.minutes][0] }
  }

  // Unrestricted weekday + single day-of-month: monthly on that day.
  if (parsed.weekdayWildcard && !parsed.dayWildcard && parsed.months.size === 12 && parsed.days.size === 1 && parsed.hours.size === 1 && parsed.minutes.size === 1) {
    return { kind: 'monthly', day: [...parsed.days][0], hour: [...parsed.hours][0], minute: [...parsed.minutes][0] }
  }

  return { kind: 'custom', cron: trimmed }
}

/**
 * The uniform step of a step-generated set ({0, k, 2k, ...}, as the cron
 * minute/hour step field produces); undefined when the set is not a pure
 * step from zero. A full 0-to-max range reports step 1 (i.e. "every one").
 */
function stepOf(set: ReadonlySet<number>): number | undefined {
  const values = [...set].sort((a, b) => a - b)
  if (values.length === 0 || values[0] !== 0) return undefined
  if (values.length === 1) return 1
  const step = values[1] - values[0]
  if (step < 1) return undefined
  for (let index = 2; index < values.length; index++) {
    if (values[index] - values[index - 1] !== step) return undefined
  }
  return step
}

/**
 * Human-readable summary line for the editor ("每周一、周三、周五 09:00").
 * The custom kind returns the raw cron text (the input already shows it).
 */
export function describeSpec(spec: ScheduleSpec, t: (key: TaskBoardKey, params?: Record<string, string>) => string): string {
  switch (spec.kind) {
    case 'daily':
      return t('detail.schedule.desc.daily', { time: formatTime(spec.hour, spec.minute) })
    case 'weekly': {
      const days = [...spec.days].sort((a, b) => weekdayRank(a) - weekdayRank(b))
      const labels = days
        .filter(day => day >= 0 && day <= 6)
        .map(day => t(`detail.schedule.day.${day}` as TaskBoardKey))
        .join(t('detail.schedule.join'))
      return t('detail.schedule.desc.weekly', { days: labels, time: formatTime(spec.hour, spec.minute) })
    }
    case 'monthly':
      return t('detail.schedule.desc.monthly', { day: String(spec.day), time: formatTime(spec.hour, spec.minute) })
    case 'interval':
      if (spec.unit === 'minute') return t('detail.schedule.desc.intervalMinute', { n: String(spec.every) })
      return t('detail.schedule.desc.intervalHour', { n: String(spec.every) })
    case 'custom':
      return spec.cron.trim()
  }
}

/** Monday-first sort rank (Sunday last). */
function weekdayRank(day: number): number {
  return day === 0 ? 7 : day
}
