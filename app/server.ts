// The window's local server, started by the mod with `bun`.
// stdout is the channel back to the mod: one JSON object per line.
// It listens on 127.0.0.1 only, and every request needs the session token.

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
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
let settings: unknown[] = []
let mode = ''

// The window's own preferences, kept beside the shortcuts.
type Prefs = { hideTerminalOnOpen: boolean }
const DEFAULT_PREFS: Prefs = { hideTerminalOnOpen: true }
const prefsPath = () => join(configDir, 'ajustes.json')
const readPrefs = (): Prefs => {
  try {
    const kept = JSON.parse(readFileSync(prefsPath(), 'utf8'))

    return { hideTerminalOnOpen: kept.hideTerminalOnOpen !== false }
  } catch {
    return DEFAULT_PREFS
  }
}
// The window the next /open launches hides the terminal once it connects.
let isHidingOnConnect = false
type Message = { role: string; text: string }
let messages: Message[] = []
type Command = { name: string; description: string }

// ---- Sessions and projects, as Claude Code keeps them under ~/.claude:
// `sessions/<pid>.json` for each running one, `projects/<dir>/<id>.jsonl`
// for every conversation, its folder the project.
const claudeDir = join(homedir(), '.claude')
const HEAD_BYTES = 256 * 1024
const TAIL_BYTES = 512 * 1024
const SESSIONS_PER_PROJECT = 8

type Live = { pid: number; sessionId: string; cwd: string; name: string; status: string; isThis: boolean }
type Summary = { mtimeMs: number; cwd: string; title: string }
const summaries = new Map<string, Summary>()

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

const readLive = (): Live[] => {
  try {
    return readdirSync(join(claudeDir, 'sessions'))
      .filter(name => /^\d+\.json$/.test(name))
      .flatMap(name => {
        try {
          const one = JSON.parse(readFileSync(join(claudeDir, 'sessions', name), 'utf8'))
          if (typeof one.pid !== 'number' || !isAlive(one.pid)) return []

          return [{
            pid: one.pid,
            sessionId: String(one.sessionId ?? ''),
            cwd: String(one.cwd ?? ''),
            name: String(one.name ?? ''),
            status: String(one.status ?? ''),
            isThis: one.pid === parent,
          }]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

// What a conversation file says about itself, from its first and last
// pieces alone: some of them run to many megabytes.
const summarize = async (path: string, mtimeMs: number): Promise<Summary> => {
  const known = summaries.get(path)
  if (known !== undefined && known.mtimeMs === mtimeMs) return known
  const file = Bun.file(path)
  const head = await file.slice(0, HEAD_BYTES).text()
  const tail = file.size > HEAD_BYTES ? await file.slice(Math.max(HEAD_BYTES, file.size - TAIL_BYTES)).text() : ''
  let cwd = ''
  let title = ''
  let prompt = ''
  for (const line of `${head}\n${tail}`.split('\n')) {
    if (!line.startsWith('{')) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (cwd === '' && typeof row.cwd === 'string') cwd = row.cwd
    if (row.type === 'custom-title' && typeof row.customTitle === 'string') title = row.customTitle
    if (row.type === 'ai-title' && typeof row.aiTitle === 'string' && !title) title = row.aiTitle
    if (prompt === '' && row.type === 'user') {
      const content = (row.message as { content?: unknown } | undefined)?.content
      const text = typeof content === 'string' ? content
        : Array.isArray(content) ? String(content.find(block => block?.type === 'text')?.text ?? '') : ''
      if (text.trim() !== '' && !text.trimStart().startsWith('<')) prompt = text.trim()
    }
  }
  const summary = { mtimeMs, cwd, title: (title || prompt || 'Sesión sin título').replace(/\s+/g, ' ').slice(0, 120) }
  summaries.set(path, summary)

  return summary
}

type Project = {
  cwd: string
  name: string
  updatedAt: number
  sessions: Array<{ id: string; title: string; updatedAt: number; isLive: boolean }>
}

const readProjects = async (live: Live[]): Promise<Project[]> => {
  const byCwd = new Map<string, Project>()
  const liveIds = new Set(live.map(one => one.sessionId))
  const root = join(claudeDir, 'projects')
  let folders: string[] = []
  try {
    folders = readdirSync(root)
  } catch {
    return []
  }
  for (const folder of folders) {
    let names: string[] = []
    try {
      names = readdirSync(join(root, folder)).filter(name => name.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(root, folder, name)
      try {
        const { mtimeMs, size } = statSync(path)
        if (size === 0) continue
        const summary = await summarize(path, mtimeMs)
        if (summary.cwd === '') continue
        const project = byCwd.get(summary.cwd) ?? {
          cwd: summary.cwd,
          name: summary.cwd === homedir() ? 'Carpeta personal' : basename(summary.cwd),
          updatedAt: 0,
          sessions: [],
        }
        const id = name.replace(/\.jsonl$/, '')
        project.sessions.push({ id, title: summary.title, updatedAt: mtimeMs, isLive: liveIds.has(id) })
        project.updatedAt = Math.max(project.updatedAt, mtimeMs)
        byCwd.set(summary.cwd, project)
      } catch {
        // A file being written or gone: skipped this time.
      }
    }
  }
  // Running sessions in a folder with no conversation saved yet.
  for (const one of live) {
    if (one.cwd !== '' && !byCwd.has(one.cwd)) {
      byCwd.set(one.cwd, { cwd: one.cwd, name: basename(one.cwd), updatedAt: Date.now(), sessions: [] })
    }
  }

  return [...byCwd.values()]
    .map(project => ({
      ...project,
      sessions: project.sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, SESSIONS_PER_PROJECT),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

// The window of the terminal a process runs in: its nearest ancestor
// Hyprland draws a window for.
const windowOf = (pid: number): string | undefined => {
  try {
    const clients = JSON.parse(hypr(['clients', '-j'])) as Array<{ address: string; pid: number }>
    const byPid = new Map(clients.map(client => [client.pid, client.address]))
    let at = pid
    for (let step = 0; step < 12 && at > 1; step += 1) {
      const found = byPid.get(at)
      if (found !== undefined) return found
      const stat = readFileSync(`/proc/${at}/stat`, 'utf8')
      at = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    }
  } catch {
    // No Hyprland, or the process is gone.
  }

  return undefined
}

const focusWindow = (address: string) => {
  // Shown again first if this window hid it.
  const hidden = readTerminal()
  if (hidden.address === address && hidden.isHidden) setTerminal(false)
  hypr(['dispatch', `hl.dsp.focus({ window = 'address:${address}' })`])
}

const openTerminal = (cwd: string, args: string[]) => {
  spawn('setsid', ['-f', 'kitty', '--directory', cwd, 'claude', ...args], {
    stdio: 'ignore',
    detached: true,
    cwd,
  }).unref()
}

// Permissions and questions waiting on the person. The mod polls for the
// answer in short waits; an answer is kept until it collects it.
type Ask = { id: string }
type Answer = Record<string, unknown> | null
const ASK_WAIT_MS = 5 * 60 * 1000
const POLL_HOLD_MS = 8000
const POLL_LOST_MS = 30_000
type Held = {
  ask: Ask
  polledAt: number
  timer: ReturnType<typeof setTimeout>
  wake: Set<() => void>
}
const asks = new Map<string, Held>()
const answered = new Map<string, Answer>()

const settleAsk = (id: string, answer: Answer) => {
  const held = asks.get(id)
  if (held === undefined) return false
  asks.delete(id)
  clearTimeout(held.timer)
  answered.set(id, answer)
  setTimeout(() => answered.delete(id), 60_000)
  for (const wake of held.wake) wake()
  broadcast('ask-done', { id })

  return true
}

// Files the person pastes or drops in the window are kept here, and the
// message names their paths: Claude reads them with its own tools.
const attachDir = join(
  process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
  'claude-ventana',
  'adjuntos',
)
const ATTACH_MAX_BYTES = 512 * 1024 * 1024
const ATTACH_KEEP_MS = 7 * 24 * 60 * 60 * 1000
const IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']
// What the page may read back for a thumbnail: these and the folder above.
const adopted = new Set<string>()

type Attachment = { path: string; name: string; size: number; isImage: boolean }

const describeFile = (path: string): Attachment => ({
  path,
  name: basename(path),
  size: statSync(path).size,
  isImage: IMAGE_TYPES.includes(extname(path).toLowerCase()),
})

const sweepAttachments = () => {
  try {
    for (const name of readdirSync(attachDir)) {
      const path = join(attachDir, name)
      if (Date.now() - statSync(path).mtimeMs > ATTACH_KEEP_MS) unlinkSync(path)
    }
  } catch {
    // Nothing kept yet.
  }
}
sweepAttachments()
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

// The ordinary workspace the person is looking at: never the hidden one,
// even while Hyprland shows it over everything.
const normalWorkspace = (): string => {
  const monitors = JSON.parse(hypr(['monitors', '-j'])) as Array<{
    focused: boolean
    activeWorkspace: { id: number }
  }>
  const monitor = monitors.find(one => one.focused) ?? monitors[0]

  return String(monitor?.activeWorkspace.id ?? 1)
}

const moveWindow = (address: string, target: string) => {
  hypr(['dispatch', `hl.dsp.window.move({ workspace = '${target}', follow = false, window = 'address:${address}' })`])
}

// An empty hidden place left open darkens the whole screen: close it.
const closeHidden = () => {
  const monitors = JSON.parse(hypr(['monitors', '-j'])) as Array<{ specialWorkspace: { name: string } }>
  if (monitors.some(one => one.specialWorkspace.name === HIDDEN)) {
    hypr(['dispatch', `hl.dsp.workspace.toggle_special('${HIDDEN.replace('special:', '')}')`])
  }
}

// Hyprland opened the hidden place over the screen (focus went to the
// terminal there, or it asked for attention): everything in it comes back.
const rescueHidden = () => {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return
  try {
    const monitors = JSON.parse(hypr(['monitors', '-j'])) as Array<{ specialWorkspace: { name: string } }>
    if (!monitors.some(one => one.specialWorkspace.name === HIDDEN)) return
    const target = normalWorkspace()
    const clients = JSON.parse(hypr(['clients', '-j'])) as Array<{ address: string; workspace: { name: string } }>
    for (const client of clients) {
      if (client.workspace.name === HIDDEN) moveWindow(client.address, target)
    }
    closeHidden()
    const now = readTerminal()
    broadcast('terminal', { isSupported: now.isSupported, isHidden: now.isHidden })
  } catch {
    // Tried again next second.
  }
}

const setTerminal = (isHidden: boolean): Terminal => {
  const found = readTerminal()
  if (found.address === undefined || found.isHidden === isHidden) return found
  try {
    const target = isHidden ? HIDDEN : normalWorkspace()
    // Hyprland's Lua dispatchers first; the older spelling where that one
    // did not move the window.
    moveWindow(found.address, target)
    if (!isHidden) closeHidden()
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
  const url = `http://127.0.0.1:${port}/`
  // setsid -f: the window outlives this server, which restarts on a reload.
  // The token goes in the environment, not the arguments: any user can read
  // a process's arguments with `ps`, but only its owner can read its environment.
  spawn('setsid', ['-f', 'python3', join(here, 'window.py'), url], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, VENTANA_WINDOW_TOKEN: token },
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
        if (isHidingOnConnect) {
          isHidingOnConnect = false
          setTimeout(() => setTerminal(true), 700)
        }
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
            asks: [...asks.values()].map(held => held.ask),
            settings,
            mode,
            prefs: readPrefs(),
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
    if (launched) {
      isHidingOnConnect = readPrefs().hideTerminalOnOpen
      launchWindow(port)
    }

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
    const body = (await request.json()) as { usage: unknown; settings?: unknown[] }
    usage = body.usage
    if (Array.isArray(body.settings)) settings = body.settings
    broadcast('usage', { usage })
    broadcast('settings', { settings })

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

  if (request.method === 'POST' && url.pathname === '/mode') {
    mode = String(((await request.json()) as { mode: unknown }).mode ?? '')
    broadcast('mode', { mode })

    return json({})
  }

  // Only the two rows the pickers show; the mod changes them as /config does.
  if (request.method === 'POST' && url.pathname === '/setting') {
    const body = (await request.json()) as { key: unknown; value: unknown }
    if ((body.key !== 'permissionMode' && body.key !== 'model') || typeof body.value !== 'string') {
      return json({ error: 'setting' }, 400)
    }
    say({ type: 'setting', key: body.key, value: body.value })

    return json({})
  }

  if (request.method === 'GET' && url.pathname === '/prefs') {
    return json({ prefs: readPrefs() })
  }

  if (request.method === 'POST' && url.pathname === '/prefs') {
    const body = (await request.json()) as { prefs: Partial<Prefs> }
    const prefs = { ...readPrefs(), hideTerminalOnOpen: body.prefs?.hideTerminalOnOpen !== false }
    mkdirSync(configDir, { recursive: true })
    writeFileSync(prefsPath(), `${JSON.stringify(prefs, null, 2)}\n`)

    return json({ prefs })
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
    // The answer is asked for in the terminal: bring it back, unless the
    // window is the one asking.
    if (asks.size === 0) {
      setTerminal(false)
      broadcast('notice', { isOk: false, text })
    }

    return json({})
  }

  if (request.method === 'GET' && url.pathname === '/sessions') {
    const live = readLive()

    return json({ live, projects: await readProjects(live), here: process.cwd() })
  }

  // Only what the lists name: a known project's folder, a known session, a
  // running session's terminal. Nothing here runs a command of the page's.
  if (request.method === 'POST' && url.pathname === '/sessions/open') {
    const body = (await request.json()) as { cwd?: unknown; sessionId?: unknown; pid?: unknown; path?: unknown }
    const live = readLive()
    if (typeof body.pid === 'number') {
      const running = live.find(one => one.pid === body.pid)
      const address = running ? windowOf(running.pid) : undefined
      if (address === undefined) return json({ error: 'No encontré la ventana de esa sesión.' }, 400)
      focusWindow(address)

      return json({ done: 'focus' })
    }
    if (typeof body.path === 'string') {
      const path = body.path.trim().replace(/^~(?=\/|$)/, homedir())
      try {
        const real = realpathSync(path)
        if (!statSync(real).isDirectory()) throw new Error('not a folder')
        openTerminal(real, [])

        return json({ done: 'new' })
      } catch {
        return json({ error: 'Esa carpeta no existe.' }, 400)
      }
    }
    const project = (await readProjects(live)).find(one => one.cwd === body.cwd)
    if (project === undefined) return json({ error: 'Proyecto desconocido.' }, 400)
    if (body.sessionId === undefined) {
      openTerminal(project.cwd, [])

      return json({ done: 'new' })
    }
    const running = live.find(one => one.sessionId === body.sessionId)
    const address = running ? windowOf(running.pid) : undefined
    if (address !== undefined) {
      focusWindow(address)

      return json({ done: 'focus' })
    }
    if (!project.sessions.some(one => one.id === body.sessionId)) return json({ error: 'Sesión desconocida.' }, 400)
    openTerminal(project.cwd, ['--resume', String(body.sessionId)])

    return json({ done: 'resume' })
  }

  if (request.method === 'POST' && url.pathname === '/ask') {
    const { ask } = (await request.json()) as { ask: Ask }
    // Nobody is looking at a window: the terminal asks.
    if (clients.size === 0 || typeof ask?.id !== 'string') return json({ status: 'none' })
    const timer = setTimeout(() => {
      if (settleAsk(ask.id, null)) {
        setTerminal(false)
        broadcast('notice', { isOk: false, text: 'Sin respuesta: la pregunta pasó a la terminal.' })
      }
    }, ASK_WAIT_MS)
    asks.set(ask.id, { ask, polledAt: Date.now(), timer, wake: new Set() })
    broadcast('ask', { ask })

    return json({ status: 'open' })
  }

  if (request.method === 'POST' && url.pathname === '/ask-wait') {
    const { id } = (await request.json()) as { id: string }
    const held = asks.get(id)
    if (held !== undefined) {
      held.polledAt = Date.now()
      await new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(wait)
          held.wake.delete(done)
          resolve()
        }
        const wait = setTimeout(done, POLL_HOLD_MS)
        held.wake.add(done)
      })
      held.polledAt = Date.now()
    }
    if (asks.has(id)) return json({ status: 'open' })
    const answer = answered.get(id) ?? null
    answered.delete(id)

    return json({ status: 'done', answer })
  }

  if (request.method === 'POST' && url.pathname === '/answer') {
    const body = (await request.json()) as { id: string; answer: Answer; toTerminal?: boolean }
    if (body.toTerminal === true) setTerminal(false)
    const isSettled = settleAsk(body.id, body.toTerminal === true ? null : body.answer)

    return json(isSettled ? {} : { error: 'gone' })
  }

  if (request.method === 'POST' && url.pathname === '/ask-cancel') {
    settleAsk(((await request.json()) as { id: string }).id, null)

    return json({})
  }

  if (request.method === 'POST' && url.pathname === '/upload') {
    const given = basename(url.searchParams.get('name') || 'archivo')
    const safe = given.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(-80) || 'archivo'
    mkdirSync(attachDir, { recursive: true })
    const path = join(attachDir, `${Date.now()}-${safe}`)
    await Bun.write(path, await request.arrayBuffer())

    return json({ file: describeFile(path) })
  }

  // A file named by its path (copied in a file manager): used where it is.
  if (request.method === 'POST' && url.pathname === '/adopt') {
    const { path } = (await request.json()) as { path: unknown }
    try {
      const real = realpathSync(String(path))
      if (!statSync(real).isFile()) return json({ error: 'file' }, 400)
      adopted.add(real)

      return json({ file: describeFile(real) })
    } catch {
      return json({ error: 'file' }, 400)
    }
  }

  if (request.method === 'GET' && url.pathname === '/file') {
    try {
      const real = realpathSync(url.searchParams.get('path') ?? '')
      const isKept = real.startsWith(`${realpathSync(attachDir)}/`)
      if (!isKept && !adopted.has(real)) return json({ error: 'file' }, 403)

      return new Response(Bun.file(real), {
        headers: { 'cache-control': 'private, max-age=3600' },
      })
    } catch {
      return json({ error: 'file' }, 404)
    }
  }

  if (request.method === 'POST' && url.pathname === '/send') {
    const { text } = (await request.json()) as { text: unknown }
    if (typeof text !== 'string' || text.trim() === '' || text.length > 20_000) {
      return json({ error: 'text' }, 400)
    }
    say({ type: 'send', text })

    return json({})
  }

  // The stop button: the mod ends the running turn.
  if (request.method === 'POST' && url.pathname === '/stop') {
    say({ type: 'stop' })

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
        maxRequestBodySize: ATTACH_MAX_BYTES,
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

setInterval(rescueHidden, 1000)

setInterval(() => {
  if (clients.size > 0) lastClientAt = Date.now()
  // A question whose mod stopped asking for the answer is closed.
  for (const [id, held] of asks) {
    if (Date.now() - held.polledAt > POLL_LOST_MS) settleAsk(id, null)
  }
  broadcast('ping', {})
  const isOrphan = process.ppid !== parent
  const isIdle = clients.size === 0 && Date.now() - lastClientAt > IDLE_EXIT_MS
  if (isOrphan || isIdle) {
    if (isIdle) say({ type: 'bye' })
    leave()
  }
}, 5000)
