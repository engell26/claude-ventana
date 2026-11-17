import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Link } from '../types'

// Observe-only: no hook here denies, rewrites or draws. Each returns what
// `next(e)` gives, so the session behaves the same with the window dead.

const link = atom({ plugin: 'ventana', key: 'link' } as const, null, {
  shape: 'link-1',
})

const feed = atom({ plugin: 'ventana', key: 'feed' } as const, [], {
  shape: 'feed-1',
})

const READY_TIMEOUT_MS = 6000
const FEED_ROWS = 100
const DETAIL_KEYS = [
  'file_path',
  'description',
  'command',
  'pattern',
  'url',
  'query',
  'skill',
  'prompt',
  'path',
]

type ServerLine =
  | { type: 'ready'; port: number; token: string }
  | { type: 'bye' }
  | { type: 'fill'; text: string }

// The server of this module's life: started once, gone with a reload.
let server: Promise<Link> | undefined
// Where it listens while it runs; nothing is sent while it does not.
let current: Link | undefined

function post($: EngineInterface, path: string, body: object): void {
  if (current === undefined) return
  void $.http
    .fetch(`http://127.0.0.1:${current.port}${path}`, {
      method: 'POST',
      headers: {
        'x-ventana-token': current.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    .catch(() => {})
}

// Keeps the row and shows it; never throws, so no hook fails over it.
async function record($: EngineInterface, item: Item): Promise<void> {
  try {
    await update($, feed, list =>
      (list.some(one => one.id === item.id)
        ? list.map(one => (one.id === item.id ? item : one))
        : [...list, item]
      ).slice(-FEED_ROWS),
    )
    post($, '/item', { item })
  } catch {
    // The window misses a row; the session goes on.
  }
}

// The Uso tab's figures: the session's own, with the last turn's tokens.
async function report($: EngineInterface, turn?: object): Promise<void> {
  if (current === undefined) return
  try {
    const [usage, model] = await Promise.all([
      $.session.usage(),
      $.session.model(),
    ])
    post($, '/usage', { usage: { ...usage, model, turn } })
  } catch {
    // The tab keeps its last figures.
  }
}

// Text the person sent from the window: into the prompt box, never submitted.
async function fill($: EngineInterface, text: string): Promise<void> {
  const filled = await $.prompt
    .fill({ text, mode: 'append' })
    .catch(() => undefined)
  post(
    $,
    '/notice',
    filled?.isFilled === true
      ? { isOk: true, text: 'Listo: está en el prompt de la terminal, da Enter.' }
      : { isOk: false, text: 'No pude escribir en el prompt (¿hay un diálogo abierto?).' },
  )
}

function describe(input: Record<string, unknown>): string {
  for (const key of DETAIL_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') {
      return value.replace(/\s+/g, ' ').slice(0, 160)
    }
  }

  return ''
}

function start($: EngineInterface, prior: Link | null): Promise<Link> {
  if (server !== undefined) return server

  let settle: (value: Link) => void = () => {}
  let fail: (reason: Error) => void = () => {}
  const ready = new Promise<Link>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  // A failure nobody awaits (the restart after a reload) is not an error.
  ready.catch(() => {})
  server = ready

  const handle = async (line: string) => {
    let message: ServerLine
    try {
      message = JSON.parse(line) as ServerLine
    } catch {
      return
    }
    if (message.type === 'ready') {
      const found: Link = { port: message.port, token: message.token }
      await update($, link, () => found)
      current = found
      post($, '/snapshot', { items: await read($, feed) })
      void report($)
      settle(found)
    }
    if (message.type === 'bye') await update($, link, () => null)
    if (message.type === 'fill' && typeof message.text === 'string') {
      await fill($, message.text)
    }
  }

  const run = async () => {
    const env: Record<string, string> = prior
      ? { VENTANA_PORT: String(prior.port), VENTANA_TOKEN: prior.token }
      : {}
    let pending = ''
    try {
      const child = $.process.spawn({
        argv: ['bun', `${$.plugin.root}/app/server.ts`],
        env,
      })
      for await (const chunk of child) {
        if (chunk.stream !== 'stdout') continue
        pending += chunk.text
        let cut = pending.indexOf('\n')
        while (cut >= 0) {
          await handle(pending.slice(0, cut)).catch(() => {})
          pending = pending.slice(cut + 1)
          cut = pending.indexOf('\n')
        }
      }
    } catch (error) {
      $.ui.log(`ventana: el servidor no arranco: ${String(error)}`, {
        to: 'debug',
      })
    } finally {
      server = undefined
      current = undefined
      fail(new Error('el servidor de la ventana termino'))
    }
  }

  // From a timer, so the child belongs to the module and not to the
  // dispatch that asked for it.
  $.clock.after(0, () => void run())

  return ready
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started

    await $.command.register({
      name: 'ventana',
      description: 'Abre la ventana grafica de Claude',
    })
    // A window was open before this reload: bring its server back where it
    // was. The server leaves by itself if no window comes back to it.
    const prior = await read($, link)
    if (prior !== null) void start($, prior)

    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta !== true && e.text.trim() !== '') {
      const startedAt = await $.clock.now().catch(() => 0)
      await record($, {
        id: `prompt-${startedAt}`,
        kind: 'prompt',
        label: 'Pedido',
        detail: e.text.replace(/\s+/g, ' ').slice(0, 160),
        startedAt,
        endedAt: startedAt,
      })
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const item: Item = {
      id: e.tool_use_id,
      kind: 'tool',
      label: String(e.tool),
      detail: describe(input),
      startedAt: await $.clock.now().catch(() => 0),
      isAgent: typeof input.agentId === 'string',
    }
    await record($, item)
    const ran = await next(e)
    await record($, {
      ...item,
      endedAt: await $.clock.now().catch(() => item.startedAt),
      isError: ran.deny !== undefined || ran.isError === true,
    })

    return ran
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) post($, '/status', { isBusy: true })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const input = e as unknown as Record<string, unknown>
    if (input.agentId === undefined) {
      post($, '/status', { isBusy: false })
      void report($, done.usage)
    }

    return done
  })

  on('command.run', { command: 'ventana' }, async $ => {
    try {
      const timeout = $.clock
        .sleep(READY_TIMEOUT_MS)
        .then((): never => {
          throw new Error('el servidor no respondio a tiempo')
        })
      const found = await Promise.race([start($, await read($, link)), timeout])
      const opened = await $.http.fetch(
        `http://127.0.0.1:${found.port}/open`,
        { method: 'POST', headers: { 'x-ventana-token': found.token } },
      )
      if (!opened.ok) return { text: `Ventana: error ${opened.status}.` }
      const { launched } = JSON.parse(opened.text) as { launched: boolean }

      return { text: launched ? 'Ventana abierta.' : 'La ventana ya esta abierta.' }
    } catch (error) {
      return { text: `No pude abrir la ventana: ${String(error)}` }
    }
  })
}
