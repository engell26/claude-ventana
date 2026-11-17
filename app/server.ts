// The window's local server, started by the mod with `bun`.
// stdout is the channel back to the mod: one JSON object per line.
// It listens on 127.0.0.1 only, and every request needs the session token.

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const token =
  process.env.VENTANA_TOKEN || crypto.randomUUID().replaceAll('-', '')
const wantedPort = Number(process.env.VENTANA_PORT || 0)
const parent = process.ppid
const bornAt = Date.now()

const IDLE_EXIT_MS = 60_000
const encoder = new TextEncoder()
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
let lastClientAt = Date.now()

// What the window shows, as the mod last told it; the mod keeps the record.
type Item = { id: string }
let items: Item[] = []
let isBusy = false
let usage: unknown = null
type Message = { role: string; text: string }
let messages: Message[] = []
type Command = { name: string; description: string }
let commands: Command[] = []

// The terminal Claude runs in, hidden and shown through Hyprland: moved to a
// special workspace and back. Elsewhere the window offers no such button.
const terminalPid = Number(process.env.KITTY_PID || 0)
const HIDDEN = 'special:claude-terminal'

const hypr = (args: string[]): string => {
  const ran = Bun.spawnSync(['hyprctl', ...args], { stdout: 'pipe', stderr: 'ignore' })

  return ran.stdout.toString()
}

type Terminal = { isSupported: boolean; isHidden: boolean; address?: string }

const readTerminal = (): Terminal => {
  const none = { isSupported: false, isHidden: false }
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE || terminalPid === 0) return none
  try {
    const clients = JSON.parse(hypr(['clients', '-j'])) as Array<{
      address: string
      pid: number
      workspace: { name: string }
    }>
    // One process drawing several windows: which is Claude's is not known.
    const mine = clients.filter(client => client.pid === terminalPid)
    const [only] = mine
    if (mine.length !== 1 || only === undefined) return none

    return {
      isSupported: true,
      isHidden: only.workspace.name === HIDDEN,
      address: only.address,
    }
  } catch {
    return none
  }
}

const setTerminal = (isHidden: boolean): Terminal => {
  const found = readTerminal()
  if (found.address === undefined || found.isHidden === isHidden) return found
  try {
    const target = isHidden
      ? HIDDEN
      : String((JSON.parse(hypr(['activeworkspace', '-j'])) as { id: number }).id)
    // Hyprland's Lua dispatchers first; the older spelling where that one
    // did not move the window.
    hypr([
      'dispatch',
      `hl.dsp.window.move({ workspace = '${target}', follow = false, window = 'address:${found.address}' })`,
    ])
    if (readTerminal().isHidden !== isHidden) {
      hypr(['dispatch', 'movetoworkspacesilent', `${target},address:${found.address}`])
    }
  } catch {
    // Read back below: the button shows what happened.
  }
  const now = readTerminal()
  broadcast('terminal', { isSupported: now.isSupported, isHidden: now.isHidden })

  return now
}

// The terminal never stays hidden behind a server that is gone.
const leave = () => {
  setTerminal(false)
  process.exit(0)
}
process.on('SIGTERM', leave)
process.on('SIGINT', leave)
process.on('SIGHUP', leave)

// The person's shortcuts, kept outside the mod's folder so an update of the
// mod does not replace them.
type Shortcut = { label: string; text: string }
const configDir = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'claude-ventana',
)
const shortcutsPath = join(configDir, 'atajos.json')
const DEFAULT_SHORTCUTS: Shortcut[] = [
  { label: 'Resumen', text: 'Resume en pocas líneas lo que hiciste en esta sesión.' },
  { label: 'Revisar cambios', text: '/code-review' },
  { label: 'Recargar plugins', text: '/reload-plugins' },
]

const cleanShortcuts = (value: unknown): Shortcut[] | undefined => {
  if (!Array.isArray(value) || value.length > 30) return undefined
  const list: Shortcut[] = []
  for (const one of value) {
    const label = typeof one?.label === 'string' ? one.label.trim() : ''
    const text = typeof one?.text === 'string' ? one.text.trim() : ''
    if (label === '' || text === '' || label.length > 40 || text.length > 4000) {
      return undefined
    }
    list.push({ label, text })
  }

  return list
}

const readShortcuts = (): Shortcut[] => {
  try {
    return cleanShortcuts(JSON.parse(readFileSync(shortcutsPath, 'utf8'))) ?? DEFAULT_SHORTCUTS
  } catch {
    return DEFAULT_SHORTCUTS
  }
}

// Plugins through the `claude plugin` CLI, the same switch `/plugin` flips.
type Plugin = { id: string; version: string; enabled: boolean }

const claude = async (args: string[]) => {
  const child = Bun.spawn(['claude', 'plugin', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const timer = setTimeout(() => child.kill(), 30_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)

  return { stdout, stderr, exitCode }
}

const listPlugins = async (): Promise<Plugin[]> => {
  const { stdout } = await claude(['list', '--json'])
  const rows = JSON.parse(stdout) as Array<Record<string, unknown>>

  return rows.map(row => ({
    id: String(row.id),
    version: String(row.version ?? ''),
    enabled: row.enabled === true,
  }))
}

const backUpSettings = () => {
  const settings = join(homedir(), '.claude', 'settings.json')
  const copy = `${settings}.antes-de-ventana`
  if (existsSync(settings) && !existsSync(copy)) copyFileSync(settings, copy)
}

const say = (message: object) => console.log(JSON.stringify(message))

const frame = (event: string, data: unknown) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

const broadcast = (event: string, data: unknown) => {
  for (const client of clients) {
    try {
      client.enqueue(frame(event, data))
    } catch {
      clients.delete(client)
    }
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const launchWindow = (port: number) => {
  const url = `http://127.0.0.1:${port}/?t=${token}`
  // setsid -f: the window outlives this server, which restarts on a reload.
  spawn('setsid', ['-f', 'python3', join(here, 'window.py'), url], {
    stdio: 'ignore',
    detached: true,
  }).unref()
}

const handle = async (request: Request, port: number): Promise<Response> => {
  const url = new URL(request.url)
  const origin = `http://127.0.0.1:${port}`
  // Only this address, only this page, only with the token.
  if (request.headers.get('host') !== `127.0.0.1:${port}`) {
    return json({ error: 'host' }, 403)
  }
  const from = request.headers.get('origin')
  if (from !== null && from !== origin) return json({ error: 'origin' }, 403)
  const given =
    request.headers.get('x-ventana-token') ?? url.searchParams.get('t')
  if (given !== token) return json({ error: 'token' }, 403)

  if (request.method === 'GET' && url.pathname === '/') {
    return new Response(Bun.file(join(here, 'index.html')), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }

  if (request.method === 'GET' && url.pathname === '/events') {
    let mine: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        mine = controller
        clients.add(controller)
        lastClientAt = Date.now()
        // `build` changes when the page's file does: an open window reloads.
        const build = statSync(join(here, 'index.html')).mtimeMs
        controller.enqueue(
          frame('hello', {
            cwd: process.cwd(),
            items,
            isBusy,
            usage,
            build,
            messages,
            commands,
            terminal: readTerminal(),
          }),
        )
      },
      cancel() {
        if (mine) clients.delete(mine)
        lastClientAt = Date.now()
      },
    })

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
      },
    })
  }

  if (request.method === 'POST' && url.pathname === '/open') {
    // Restarted under an open window: give it a moment to come back
    // before opening a second one.
    const isRestart = wantedPort !== 0 && Date.now() - bornAt < 15_000
    for (let wait = 0; isRestart && clients.size === 0 && wait < 25; wait += 1) {
      await Bun.sleep(200)
    }
    const launched = clients.size === 0
    if (launched) launchWindow(port)

    return json({ launched })
  }

  if (request.method === 'POST' && url.pathname === '/snapshot') {
    const body = (await request.json()) as { items: Item[] }
    items = body.items
    broadcast('snapshot', { items })

    return json({})
  }

  if (request.method === 'POST' && url.pathname === '/item') {
    const { item } = (await request.json()) as { item: Item }
    items = (
      items.some(one => one.id === item.id)
        ? items.map(one => (one.id === item.id ? item : one))
        : [...items, item]
    ).slice(-100)
    broadcast('item', { item })

    return json({})
  }

  if (request.method === 'POST' && url.pathname === '/status') {
    isBusy = ((await request.json()) as { isBusy: boolean }).isBusy === true
    broadcast('status', { isBusy })

    return json({})
  }

  if (request.method === 'POST' && url.pathname === '/usage') {
    usage = ((await request.json()) as { usage: unknown }).usage
    broadcast('usage', { usage })

    return json({})
  }

  if (request.method === 'POST' && url.pathname === '/notice') {
    broadcast('notice', await request.json())

    return json({})
  }

  if (request.method === 'POST' && url.pathname === '/chat') {
    messages = ((await request.json()) as { messages: Message[] }).messages
    broadcast('chat', { messages })

    return json({})
  }

  if (request.method === 'POST' && url.pathname === '/chat-add') {
    const { message } = (await request.json()) as { message: Message }
    messages = [...messages, message].slice(-80)
    broadcast('chat', { messages })

    return json({})
  }

  if (request.method === 'POST' && url.pathname === '/commands') {
    commands = ((await request.json()) as { commands: Command[] }).commands
    broadcast('commands', { commands })

    return json({})
  }

  if (request.method === 'POST' && url.pathname === '/terminal') {
    const body = (await request.json()) as { isHidden: unknown }
    const now = setTerminal(body.isHidden === true)

    return json({ isSupported: now.isSupported, isHidden: now.isHidden })
  }

  if (request.method === 'POST' && url.pathname === '/attention') {
    const { text } = (await request.json()) as { text: string }
    // The answer is asked for in the terminal: bring it back.
    setTerminal(false)
    broadcast('notice', { isOk: false, text })

    return json({})
  }

  if (request.method === 'POST' && url.pathname === '/send') {
    const { text } = (await request.json()) as { text: unknown }
    if (typeof text !== 'string' || text.trim() === '' || text.length > 20_000) {
      return json({ error: 'text' }, 400)
    }
    say({ type: 'send', text })

    return json({})
  }

  if (request.method === 'GET' && url.pathname === '/shortcuts') {
    return json({ shortcuts: readShortcuts() })
  }

  if (request.method === 'POST' && url.pathname === '/shortcuts') {
    const body = (await request.json()) as { shortcuts: unknown }
    const shortcuts = cleanShortcuts(body.shortcuts)
    if (shortcuts === undefined) return json({ error: 'shortcuts' }, 400)
    mkdirSync(configDir, { recursive: true })
    writeFileSync(shortcutsPath, `${JSON.stringify(shortcuts, null, 2)}\n`)

    return json({ shortcuts })
  }

  if (request.method === 'GET' && url.pathname === '/plugins') {
    try {
      return json({ plugins: await listPlugins() })
    } catch (error) {
      return json({ error: String(error) }, 500)
    }
  }

  if (request.method === 'POST' && url.pathname === '/plugins') {
    const body = (await request.json()) as { id: unknown; enabled: unknown }
    try {
      const known = (await listPlugins()).find(one => one.id === body.id)
      if (known === undefined) return json({ error: 'plugin' }, 400)
      backUpSettings()
      const ran = await claude([body.enabled === true ? 'enable' : 'disable', known.id])

      return json({
        isOk: ran.exitCode === 0,
        message: (ran.stderr || ran.stdout).trim().slice(0, 300),
        plugins: await listPlugins(),
      })
    } catch (error) {
      return json({ error: String(error) }, 500)
    }
  }

  return json({ error: 'not found' }, 404)
}

const listen = async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: wantedPort,
        idleTimeout: 0,
        fetch: request => handle(request, server.port),
      })

      return server
    } catch (error) {
      // The server this one replaces may still hold the port for a moment.
      if (wantedPort === 0) throw error
      await Bun.sleep(150)
    }
  }
  throw new Error(`port ${wantedPort} stayed busy`)
}

const server = await listen()
say({ type: 'ready', port: server.port, token })

setInterval(() => {
  if (clients.size > 0) lastClientAt = Date.now()
  broadcast('ping', {})
  const isOrphan = process.ppid !== parent
  const isIdle = clients.size === 0 && Date.now() - lastClientAt > IDLE_EXIT_MS
  if (isOrphan || isIdle) {
    if (isIdle) say({ type: 'bye' })
    leave()
  }
}, 5000)
