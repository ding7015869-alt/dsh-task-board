/**
 * Schedule editor: the structured spec <-> 5-field cron bridge (pure logic)
 * plus light SSR mount assertions for the reminder-app style editor (the
 * pure-UI smoke allowance from the repo AGENTS).
 */
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TaskBoardKey } from '../src/client/locales.ts'
import {
  WEEKDAY_ORDER,
  cronToSpec,
  describeSpec,
  formatTime,
  specToCron,
  type ScheduleSpec,
} from '../src/client/schedule-spec.ts'
import { ScheduleEditor } from '../src/client/board/ScheduleEditor.tsx'

describe('specToCron', () => {
  it('serializes the four structured kinds', () => {
    expect(specToCron({ kind: 'daily', hour: 9, minute: 0 })).toBe('0 9 * * *')
    expect(specToCron({ kind: 'daily', hour: 23, minute: 59 })).toBe('59 23 * * *')
    expect(specToCron({ kind: 'weekly', days: [1, 3, 5], hour: 9, minute: 0 })).toBe('0 9 * * 1,3,5')
    expect(specToCron({ kind: 'weekly', days: [0], hour: 9, minute: 0 })).toBe('0 9 * * 7')
    expect(specToCron({ kind: 'weekly', days: [6, 0], hour: 9, minute: 0 })).toBe('0 9 * * 6,7')
    expect(specToCron({ kind: 'monthly', day: 15, hour: 8, minute: 30 })).toBe('30 8 15 * *')
    expect(specToCron({ kind: 'interval', unit: 'minute', every: 1 })).toBe('* * * * *')
    expect(specToCron({ kind: 'interval', unit: 'minute', every: 10 })).toBe('*/10 * * * *')
    expect(specToCron({ kind: 'interval', unit: 'hour', every: 1 })).toBe('0 * * * *')
    expect(specToCron({ kind: 'interval', unit: 'hour', every: 6 })).toBe('0 */6 * * *')
    expect(specToCron({ kind: 'custom', cron: '30 4 1,15 * *' })).toBe('30 4 1,15 * *')
  })

  it('rejects structurally invalid specs with null', () => {
    expect(specToCron({ kind: 'weekly', days: [], hour: 9, minute: 0 })).toBeNull()
    expect(specToCron({ kind: 'monthly', day: 0, hour: 9, minute: 0 })).toBeNull()
    expect(specToCron({ kind: 'monthly', day: 32, hour: 9, minute: 0 })).toBeNull()
    expect(specToCron({ kind: 'interval', unit: 'minute', every: 0 })).toBeNull()
    expect(specToCron({ kind: 'interval', unit: 'minute', every: 60 })).toBeNull()
    expect(specToCron({ kind: 'interval', unit: 'hour', every: 24 })).toBeNull()
    expect(specToCron({ kind: 'custom', cron: 'not a cron' })).toBeNull()
  })
})

describe('cronToSpec', () => {
  it('picks the most specific structured tab', () => {
    expect(cronToSpec('')).toEqual({ kind: 'daily', hour: 9, minute: 0 }) // fresh task default
    expect(cronToSpec('0 9 * * *')).toEqual({ kind: 'daily', hour: 9, minute: 0 })
    expect(cronToSpec('0 9 * * 1,3,5')).toEqual({ kind: 'weekly', days: [1, 3, 5], hour: 9, minute: 0 })
    expect(cronToSpec('0 9 * * 7')).toEqual({ kind: 'weekly', days: [0], hour: 9, minute: 0 })
    expect(cronToSpec('0 9 * * 6,7')).toEqual({ kind: 'weekly', days: [6, 0], hour: 9, minute: 0 })
    expect(cronToSpec('30 8 15 * *')).toEqual({ kind: 'monthly', day: 15, hour: 8, minute: 30 })
    expect(cronToSpec('* * * * *')).toEqual({ kind: 'interval', unit: 'minute', every: 1 })
    expect(cronToSpec('*/10 * * * *')).toEqual({ kind: 'interval', unit: 'minute', every: 10 })
    expect(cronToSpec('*/30 * * * *')).toEqual({ kind: 'interval', unit: 'minute', every: 30 })
    expect(cronToSpec('0 * * * *')).toEqual({ kind: 'interval', unit: 'hour', every: 1 })
    expect(cronToSpec('0 */6 * * *')).toEqual({ kind: 'interval', unit: 'hour', every: 6 })
  })

  it('keeps exotic expressions in the custom tab verbatim', () => {
    expect(cronToSpec('30 4 1,15 * *')).toEqual({ kind: 'custom', cron: '30 4 1,15 * *' })
    expect(cronToSpec('0 9 */2 * *')).toEqual({ kind: 'custom', cron: '0 9 */2 * *' }) // "every N days" is not expressible
    expect(cronToSpec('0 9 1 1 *')).toEqual({ kind: 'custom', cron: '0 9 1 1 *' }) // month-restricted
    expect(cronToSpec('*/10 9 * * *')).toEqual({ kind: 'custom', cron: '*/10 9 * * *' }) // hour-restricted steps
    expect(cronToSpec('garbage')).toEqual({ kind: 'custom', cron: 'garbage' })
    expect(cronToSpec('0 9 31 2 *')).toEqual({ kind: 'custom', cron: '0 9 31 2 *' }) // no such date
  })

  it('round-trips every structured shape', () => {
    const samples: Array<{ cron: string; spec: ScheduleSpec }> = [
      { cron: '0 9 * * *', spec: cronToSpec('0 9 * * *') },
      { cron: '59 23 * * *', spec: cronToSpec('59 23 * * *') },
      { cron: '0 9 * * 1,3,5', spec: cronToSpec('0 9 * * 1,3,5') },
      { cron: '0 9 * * 6,7', spec: cronToSpec('0 9 * * 6,7') },
      { cron: '30 8 15 * *', spec: cronToSpec('30 8 15 * *') },
      { cron: '* * * * *', spec: cronToSpec('* * * * *') },
      { cron: '*/10 * * * *', spec: cronToSpec('*/10 * * * *') },
      { cron: '0 * * * *', spec: cronToSpec('0 * * * *') },
      { cron: '0 */6 * * *', spec: cronToSpec('0 */6 * * *') },
    ]
    for (const { cron, spec } of samples) {
      expect(specToCron(spec)).toBe(cron)
      expect(cronToSpec(specToCron(spec)!)).toEqual(spec)
    }
  })
})

describe('describeSpec', () => {
  /** The zh dictionary's schedule layer, as a tiny template resolver. */
  const T: Record<string, string> = {
    'detail.schedule.desc.daily': '每天 {time}',
    'detail.schedule.desc.weekly': '每{days} {time}',
    'detail.schedule.desc.monthly': '每月 {day} 日 {time}',
    'detail.schedule.desc.intervalMinute': '每 {n} 分钟',
    'detail.schedule.desc.intervalHour': '每 {n} 小时',
    'detail.schedule.join': '、',
    'detail.schedule.day.0': '周日',
    'detail.schedule.day.1': '周一',
    'detail.schedule.day.2': '周二',
    'detail.schedule.day.3': '周三',
    'detail.schedule.day.4': '周四',
    'detail.schedule.day.5': '周五',
    'detail.schedule.day.6': '周六',
  }
  const t = (key: TaskBoardKey, params?: Record<string, string>): string =>
    (T[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => params?.[name] ?? '')

  it('reads out every spec kind', () => {
    expect(describeSpec({ kind: 'daily', hour: 9, minute: 0 }, t)).toBe('每天 09:00')
    // Monday-first ordering: the Sunday slot sorts last.
    expect(describeSpec({ kind: 'weekly', days: [1, 0, 3], hour: 9, minute: 0 }, t)).toBe('每周一、周三、周日 09:00')
    expect(describeSpec({ kind: 'weekly', days: [6, 0], hour: 9, minute: 0 }, t)).toBe('每周六、周日 09:00')
    expect(describeSpec({ kind: 'monthly', day: 15, hour: 8, minute: 30 }, t)).toBe('每月 15 日 08:30')
    expect(describeSpec({ kind: 'interval', unit: 'minute', every: 10 }, t)).toBe('每 10 分钟')
    expect(describeSpec({ kind: 'interval', unit: 'hour', every: 2 }, t)).toBe('每 2 小时')
    expect(describeSpec({ kind: 'custom', cron: '30 4 1,15 * *' }, t)).toBe('30 4 1,15 * *')
  })

  it('formats wall-clock times zero-padded', () => {
    expect(formatTime(9, 5)).toBe('09:05')
    expect(formatTime(0, 0)).toBe('00:00')
  })
})

describe('ScheduleEditor SSR', () => {
  const emit = (): void => {}

  it('renders a daily task on the daily tab with the summary line', () => {
    const html = renderToString(createElement(ScheduleEditor, { cron: '0 9 * * *', onCronChange: emit }))
    expect(html).toContain('每天')
    expect(html).toContain('每天 09:00')
  })

  it('renders a weekly task with its weekday chips selected', () => {
    const html = renderToString(createElement(ScheduleEditor, { cron: '0 9 * * 1,3,5', onCronChange: emit }))
    expect(html).toContain('每周一、周三、周五 09:00')
    expect(html).toContain('工作日')
    expect(html).toContain('周末')
  })

  it('renders an interval task with its step', () => {
    const html = renderToString(createElement(ScheduleEditor, { cron: '*/10 * * * *', onCronChange: emit }))
    expect(html).toContain('每 10 分钟')
  })

  it('renders a monthly task with the day-of-month select', () => {
    const html = renderToString(createElement(ScheduleEditor, { cron: '30 8 15 * *', onCronChange: emit }))
    expect(html).toContain('每月 15 日 08:30')
  })

  it('keeps exotic crons in the custom tab', () => {
    const html = renderToString(createElement(ScheduleEditor, { cron: '30 4 1,15 * *', onCronChange: emit }))
    expect(html).toContain('30 4 1,15 * *')
  })

  it('starts an empty schedule on the common 09:00 daily default', () => {
    const html = renderToString(createElement(ScheduleEditor, { cron: '', onCronChange: emit }))
    expect(html).toContain('每天 09:00')
  })

  it('exposes every weekday chip in Monday-first order', () => {
    const html = renderToString(createElement(ScheduleEditor, { cron: '0 9 * * 1', onCronChange: emit }))
    const labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    const positions = labels.map(label => html.indexOf(`>${label}</button>`))
    expect(positions.every(position => position > 0)).toBe(true)
    const ordered = positions.every((position, index) => index === 0 || position > positions[index - 1])
    expect(ordered).toBe(true)
    expect(WEEKDAY_ORDER).toEqual([1, 2, 3, 4, 5, 6, 0])
  })
})
