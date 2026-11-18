// Where this session's window server listens, kept through a hot reload so
// the open window finds the restarted server at the same address.
export type Link = { port: number; token: string }

// One row of the window's activity list: a prompt, or a tool call.
export type Item = {
  id: string
  kind: 'prompt' | 'tool'
  label: string
  detail: string
  startedAt: number
  endedAt?: number
  isError?: boolean
  isAgent?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    ventana: { link: Shaped<Link | null>; feed: Shaped<Item[]>; mode: Shaped<string> }
  }
}
