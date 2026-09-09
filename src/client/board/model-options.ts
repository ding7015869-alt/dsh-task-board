/**
 * 模型下拉的展示辅助：按 provider 分组、给「宿主默认」选项拼上默认路由的可读名。
 * 新建任务与任务详情共用，避免两处渲染规则漂移。
 */
import type { ExecutionModelOption, ExecutionReasoningEffort } from '../../core/controller.ts'

/** One provider group of model options. */
export interface ModelOptionGroup {
  /** Provider id ('' when the option carries no provider). */
  key: string
  /** Provider display name for the group heading. */
  label: string | undefined
  items: ExecutionModelOption[]
}

/** Group model options by provider, preserving catalog order. */
export function groupModelOptions(models: readonly ExecutionModelOption[]): ModelOptionGroup[] {
  const groups: ModelOptionGroup[] = []
  for (const model of models) {
    const key = model.provider ?? ''
    const existing = groups.find(group => group.key === key)
    if (existing === undefined) groups.push({ key, label: model.groupName ?? model.provider, items: [model] })
    else existing.items.push(model)
  }
  return groups
}

/**
 * Display name of the Host default route: the catalog's model name when the
 * catalog still lists it, else the raw `provider/model` route.
 * @param defaultModel - the catalog default route (`provider/model`).
 * @param models - the current option list.
 * @returns the display name.
 */
export function defaultModelName(
  defaultModel: string,
  models: readonly ExecutionModelOption[],
): string {
  const match = models.find(model => model.id === defaultModel)
  return match?.label ?? match?.name ?? defaultModel
}

/** Visible text of one model option. */
export function modelOptionLabel(model: ExecutionModelOption): string {
  return model.label ?? model.name ?? model.id
}

/**
 * 当前选中模型（或宿主默认路由）下可用的推理强度选项：从模型目录的
 * `reasoning.efforts` 映射而来；该路由未声明 efforts 时返回空数组（UI 不渲染下拉）。
 * @param model - 任务当前钉住的模型（空 = 宿主默认）。
 * @param defaultModel - 目录默认路由（`provider/model`）。
 * @param models - 当前选项列表。
 */
export function reasoningEffortOptionsFor(
  model: string,
  defaultModel: string | undefined,
  models: readonly ExecutionModelOption[],
): readonly ExecutionReasoningEffort[] {
  const effectiveModel = model !== '' ? model : defaultModel
  if (effectiveModel === undefined) return []
  const match = models.find(option => option.id === effectiveModel)
  return match?.reasoningEfforts ?? []
}

/** Visible text of one reasoning-effort option (the catalog name falls back to the id). */
export function reasoningEffortLabel(effort: ExecutionReasoningEffort): string {
  return effort.name !== undefined && effort.name !== '' ? effort.name : effort.id
}
