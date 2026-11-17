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
const CHAT_ROWS = 80
const CHAT_TEXT = 30000
const CHAT_EVERY_MS = 2500
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
  | { type: 'send'; text: string }

// The server of this module's life: started once, gone with a reload.
let server: Promise<Link> | undefined
// Where it listens while it runs; nothing is sent while it does not.
let current: Link | undefined
// When the Chat tab was last sent the conversation, to pace it in a turn.
let chatAt = 0

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

// What the Chat tab shows of one transcript row: the words alone, or ''
// for a row that is the engine's own (a reminder, a command's output).
function words(role: string, text: string): string {
  if (role !== 'user') return text.trim()
  const bare = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  const command = /^<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/.exec(bare)
  if (command !== null) {
    const name = command[1] ?? ''

    return name.startsWith('/') ? name : `/${name}`
  }

  return bare.startsWith('<') ? '' : bare
}

// The Chat tab's rows: the conversation as the session holds it.
async function chat($: EngineInterface): Promise<void> {
  if (current === undefined) return
  try {
    const rows = await $.session.messages()
    // Each row with the tool calls made in it, in the transcript's order.
    const messages = rows
      .map(row => ({
        role: row.role,
        text: words(row.role, row.text).slice(0, CHAT_TEXT),
        tools: row.toolUses.map(use => ({
          id: use.tool_use_id,
          name: use.tool,
          detail: describe(use.input),
          isDone: use.text !== undefined || use.result !== undefined,
          isError: use.isError === true,
        })),
      }))
      .filter(row => row.text !== '' || row.tools.length > 0)
      .slice(-CHAT_ROWS)
    post($, '/chat', { messages })
  } catch {
    // The tab keeps the rows it has.
  }
}

// A message typed in the window: submitted as the person's own words. A
// slash command is put in the prompt box instead, for their Enter.
async function send($: EngineInterface, text: string): Promise<void> {
  if (text.startsWith('/')) return fill($, text)
  const sent = await $.prompt
    .submit({ text, asUser: true })
    .catch(() => undefined)
  if (sent === undefined || sent.drop !== undefined) {
    post($, '/notice', { isOk: false, text: 'No se pudo enviar el mensaje.' })
  }
}

// A command from the window: into the prompt box, never submitted.
async function fill($: EngineInterface, text: string): Promise<void> {
  const filled = await $.prompt
    .fill({ text, mode: 'append' })
    .catch(() => undefined)
  post(
    $,
    '/notice',
    filled?.isFilled === true
      ? { isOk: true, text: 'Es un comando: quedó en el prompt de la terminal, da Enter.' }
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
      void chat($)
      settle(found)
    }
    if (message.type === 'bye') await update($, link, () => null)
    if (message.type === 'send' && typeof message.text === 'string') {
      void send($, message.text.trim())
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
      const said = words('user', e.text)
      if (said !== '') {
        post($, '/chat-add', {
          message: { role: 'user', text: said.slice(0, CHAT_TEXT), tools: [] },
        })
      }
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
    // The call shows in the chat as it starts, a few seconds apart at most.
    if (!item.isAgent && item.startedAt - chatAt > CHAT_EVERY_MS) {
      chatAt = item.startedAt
      void chat($)
    }
    const ran = await next(e)
    const endedAt = await $.clock.now().catch(() => item.startedAt)
    await record($, {
      ...item,
      endedAt,
      isError: ran.deny !== undefined || ran.isError === true,
    })
    // What Claude wrote so far this turn, a few seconds apart at most.
    if (!item.isAgent && endedAt - chatAt > CHAT_EVERY_MS) {
      chatAt = endedAt
      void chat($)
    }

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
      void chat($)
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
