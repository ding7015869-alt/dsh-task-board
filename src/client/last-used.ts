/**
 * 「上次创建任务时的设置」记忆：浏览器本地保存，创建成功后写入，
 * 下次打开新建表单时作为默认值预填（复制任务时以被复制任务为准）。
 *
 * 只保存执行目标类字段，不保存标题/描述/Prompt 等任务内容。
 */
const KEY = 'dsh.taskBoard.lastUsed.v1'

/** The remembered subset of the new-task form. */
export interface LastUsedSettings {
  workspaceId?: string
  mode?: string
  permission?: string
  model?: string
  reasoningEffort?: string
  reuseSession?: boolean
  scheduleEnabled?: boolean
  scheduleCron?: string
}

const STRING_FIELDS = ['workspaceId', 'mode', 'permission', 'model', 'reasoningEffort', 'scheduleCron'] as const
const BOOLEAN_FIELDS = ['reuseSession', 'scheduleEnabled'] as const

/** Bound every stored string so a corrupted or hand-edited entry cannot grow the form. */
const MAX_FIELD_LENGTH = 512

function sanitize(raw: Record<string, unknown>): LastUsedSettings {
  const result: LastUsedSettings = {}
  for (const field of STRING_FIELDS) {
    const value = raw[field]
    if (typeof value === 'string' && value.length <= MAX_FIELD_LENGTH) result[field] = value
  }
  for (const field of BOOLEAN_FIELDS) {
    const value = raw[field]
    if (typeof value === 'boolean') result[field] = value
  }
  return result
}

/** Read the remembered form defaults; an absent or unusable store yields {}. */
export function readLastUsed(): LastUsedSettings {
  try {
    const storage = globalThis.localStorage
    if (storage === undefined) return {}
    const raw = storage.getItem(KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return sanitize(parsed as Record<string, unknown>)
  } catch {
    // A blocked or corrupted localStorage degrades to "no memory", never a form error.
    return {}
  }
}

/** Persist the form defaults; a failing store is silently ignored. */
export function writeLastUsed(settings: LastUsedSettings): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(sanitize(settings as Record<string, unknown>)))
  } catch {
    // Quota or privacy-mode failures must not block task creation.
  }
}
