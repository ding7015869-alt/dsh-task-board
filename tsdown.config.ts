/**
 * Standalone build config for the task-board client plugin.
 *
 * Uses the vendored dsh client-bundle preset (build/tsdown.client.ts, copied
 * from the dsh-web-ui monorepo's shared/tsdown.client.ts; keep in sync when
 * the dsh SDK version changes): node-half lib/ plus the browser bundle
 * lib/client.js (closure-factory artifact for the GUI's __ModuleLoader__,
 * CSS Modules inlined with auto-injected <style data-plugin>).
 *
 * Node-half entries point at src (tsdown compiles TS directly), so the build
 * needs no separate tsc emit for runtime artifacts.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { clientBundle } from './build/tsdown.client.ts'

/**
 * 快照 store 引擎（`@deepseek-ai/dsh-client-store`）不在浏览器模块表里，上游
 * 也是把它内联进 client bundle（其产物只 require react / react-dom / jsx-runtime）。
 * 共享 preset 的 purity 闸门会把「非平台模块的 @deepseek-ai 值导入」判为错误，
 * 所以在它之前用一个 resolveId 插件把该包指向实现源码。
 *
 * 解析顺序：`DSH_CLIENT_STORE_ENTRY` 环境变量 > 本仓 node_modules 的
 * `src/index.ts`（devDependency 源码）> 其 `lib/index.js`（npm 发布产物）。
 */
const CLIENT_STORE_CANDIDATES = [
  process.env.DSH_CLIENT_STORE_ENTRY,
  resolve('node_modules/@deepseek-ai/dsh-client-store/src/index.ts'),
  resolve('node_modules/@deepseek-ai/dsh-client-store/lib/index.js'),
].filter((entry): entry is string => Boolean(entry))

const CLIENT_STORE_ENTRY = CLIENT_STORE_CANDIDATES.find((entry) => existsSync(entry))

if (!CLIENT_STORE_ENTRY) {
  throw new Error(
    '@deepseek-ai/dsh-client-store not found; run the package manager install first '
    + 'or point DSH_CLIENT_STORE_ENTRY at its src/index.ts',
  )
}

const inlineClientStore = {
  name: 'task-board-inline-client-store',
  resolveId(source: string): string | null {
    return source === '@deepseek-ai/dsh-client-store' ? CLIENT_STORE_ENTRY : null
  },
}

const base = clientBundle('@linxin666/dsh-client-ui-task-board', ['src/index.ts', 'src/invariant.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-system-prompt',
  ],
})

type InlineConfig = Parameters<typeof base>[0]

export default (inlineConfig: InlineConfig) =>
  base(inlineConfig).map((entry) => {
    if (!String(entry.name ?? '').endsWith('/client')) return entry
    return { ...entry, plugins: [inlineClientStore as never, ...(entry.plugins ?? [])] }
  })
