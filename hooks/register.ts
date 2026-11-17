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
const SETTING_KEYS = ['permissionMode', 'model']
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

type WindowAnswer = {
  kind: 'allow' | 'deny'
  isAlways?: boolean
  answers?: Record<string, string>
  message?: string
}

type ServerLine =
  | { type: 'ready'; port: number; token: string }
  | { type: 'bye' }
  | { type: 'send'; text: string }
  | { type: 'setting'; key: string; value: string }

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

// One request to the server, its JSON answer; rejects while none runs.
async function call($: EngineInterface, path: string, body: object): Promise<unknown> {
  if (current === undefined) throw new Error('no server')
  const response = await $.http.fetch(`http://127.0.0.1:${current.port}${path}`, {
    method: 'POST',
    headers: { 'x-ventana-token': current.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`status ${response.status}`)

  return JSON.parse(response.text) as unknown
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
    const [usage, model, rows] = await Promise.all([
      $.session.usage(),
      $.session.model(),
      $.config.list().catch(() => []),
    ])
    // The two rows the window's pickers change, as the /config menu has them.
    const settings = rows
      .filter(row => SETTING_KEYS.includes(row.key))
      .map(row => ({
        key: row.key,
        value: String(row.value),
        options: 'options' in row && Array.isArray(row.options) ? row.options.map(String) : [],
        isLocked: row.isLocked,
      }))
    post($, '/usage', { usage: { ...usage, model, turn }, settings })
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

// The slash commands the person can run, for the window's suggestions.
async function commands($: EngineInterface): Promise<void> {
  if (current === undefined) return
  try {
    const list = await $.command.list()
    post($, '/commands', {
      commands: list.map(one => ({
        name: one.name,
        description: one.description.replace(/\s+/g, ' ').slice(0, 160),
      })),
    })
  } catch {
    // The window suggests none.
  }
}

// A slash command typed in the window: run as if typed at the prompt. One
// the engine will not run for a plugin is left in the prompt box instead.
async function run($: EngineInterface, text: string): Promise<void> {
  const [, name = '', args = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(text) ?? []
  try {
    const ran = await $.command.run({ command: name, args })
    const said = (ran.text ?? '').trim()
    if (said !== '') post($, '/notice', { isOk: true, text: said.slice(0, 300) })
  } catch {
    await fill($, text)
  }
}

// Claude waits on an answer only the terminal can take.
function attention($: EngineInterface, text: string): void {
  post($, '/attention', { text })
}

// A message typed in the window: submitted as the person's own words.
async function send($: EngineInterface, text: string): Promise<void> {
  if (text.startsWith('/')) return run($, text)
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

// Starts the server if it is not running and asks it for the window.
async function openWindow($: EngineInterface): Promise<boolean> {
  const timeout = $.clock.sleep(READY_TIMEOUT_MS).then((): never => {
    throw new Error('el servidor no respondio a tiempo')
  })
  const found = await Promise.race([start($, await read($, link)), timeout])
  const opened = await $.http.fetch(`http://127.0.0.1:${found.port}/open`, {
    method: 'POST',
    headers: { 'x-ventana-token': found.token },
  })
  if (!opened.ok) throw new Error(`error ${opened.status}`)

  return (JSON.parse(opened.text) as { launched: boolean }).launched
}

// The session's permission mode, as the classic hooks' input carries it.
let mode = ''
function noteMode($: EngineInterface, now: string | undefined): void {
  if (now === undefined || now === mode) return
  mode = now
  post($, '/mode', { mode })
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
      void commands($)
      settle(found)
    }
    if (message.type === 'bye') await update($, link, () => null)
    if (message.type === 'setting' && SETTING_KEYS.includes(message.key)) {
      const set = await $.config
        .set({ key: message.key, value: message.value })
        .catch((error: unknown) => ({ deny: String(error) }))
      post($, '/notice', 'deny' in set && set.deny !== undefined
        ? { isOk: false, text: `No se pudo cambiar: ${set.deny}` }
        : { isOk: true, text: 'Cambiado.' })
      void report($)
    }
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

    // Started by the `claude-ventana` launcher: the window opens by itself.
    // The variable is cleared so nothing this session starts inherits it.
    if ((await $.env.get('VENTANA_AUTO')) === '1') {
      await $.env.set('VENTANA_AUTO', undefined)
      $.clock.after(800, () => void openWindow($).catch(() => {}))
    }

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

  // A permission or a question Claude puts to the person: asked in the
  // window while one is open, and in the terminal's own dialog otherwise.
  on('classic.PermissionRequest', async ($, e, next) => {
    const below = await next(e)
    if (below.decision !== undefined || current === undefined) return below

    const input = (e.tool_input ?? {}) as Record<string, unknown>
    const suggestions = e.permission_suggestions ?? []
    const id = `ask-${await $.clock.now()}-${Math.random().toString(36).slice(2, 8)}`
    const cancel = () => post($, '/ask-cancel', { id })
    next.signal.addEventListener('abort', cancel)
    let answer: WindowAnswer | null = null
    try {
      const opened = (await call($, '/ask', {
        ask: {
          id,
          tool: e.tool_name,
          input,
          detail: describe(input),
          canRemember: suggestions.length > 0,
          isAgent: e.agent_id !== undefined,
        },
      })) as { status: string }
      // Waits in short polls: a call in flight does not count against the
      // hook's time, and none is held open long enough for the host to cut.
      let failures = opened.status === 'open' ? 0 : 3
      while (failures < 3 && !next.signal.aborted) {
        try {
          const polled = (await call($, '/ask-wait', { id })) as {
            status: string
            answer?: WindowAnswer | null
          }
          failures = 0
          if (polled.status === 'done') {
            answer = polled.answer ?? null
            break
          }
        } catch {
          failures += 1
        }
      }
      if (failures >= 3) cancel()
    } catch {
      answer = null
    } finally {
      next.signal.removeEventListener('abort', cancel)
    }
    // No window, no answer in time, or "answer in the terminal": its dialog.
    if (answer === null) return below

    if (answer.kind === 'deny') {
      return {
        ...below,
        decision: {
          behavior: 'deny',
          message: answer.message || 'La persona lo rechazó desde la ventana.',
        },
      }
    }

    return {
      ...below,
      decision: {
        behavior: 'allow',
        ...(answer.answers === undefined
          ? {}
          : { updatedInput: { ...input, answers: answer.answers } }),
        ...(answer.isAlways === true && suggestions.length > 0
          ? { updatedPermissions: suggestions }
          : {}),
      },
    }
  }).catch(($, e, next) => next(e))

  on('classic.Notification', ($, e, next) => {
    if (e.notification_type === 'permission_prompt') {
      attention($, 'Claude espera tu permiso en la terminal.')
    }

    return next(e)
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

  on('classic.UserPromptSubmit', ($, e, next) => {
    noteMode($, e.permission_mode)

    return next(e)
  })

  on('classic.Stop', ($, e, next) => {
    noteMode($, e.permission_mode)

    return next(e)
  })

  on('command.run', { command: 'ventana' }, async $ => {
    try {
      const launched = await openWindow($)

      return { text: launched ? 'Ventana abierta.' : 'La ventana ya esta abierta.' }
    } catch (error) {
      return { text: `No pude abrir la ventana: ${String(error)}` }
    }
  })
}
