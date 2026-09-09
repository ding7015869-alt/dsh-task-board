/**
 * Minimal ambient typing for the `jsdom` devDependency: the package ships no
 * type declarations and @types/jsdom is not installed (the package's
 * node_modules layout is hand-maintained junctions — no `pnpm install`).
 * The shim types only what the specs use; `window` stays `any`-backed so
 * jsdom's real structural API flows through unchecked.
 */
declare module 'jsdom' {
  export interface JSDOMOptions {
    url?: string
    pretendToBeVisual?: boolean
  }
  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions)
    readonly window: any
  }
}
