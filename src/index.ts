/**
 * odin-voice — OpenCode plugin (adapter fino)
 *
 * Conecta el bus V2 de OpenCode con el core puro. El handler se crea una sola
 * vez por setup y relee config.json por cada evento recibido.
 */
import { spawn } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { createSessionLookup, extractEvent, type VoiceContext } from "./context.ts"
import { createOdinVoiceHandler, safeOnEvent, type Decision, type OdinVoiceHandler } from "./core.ts"
import { buildCommand } from "./player.ts"
import { parseConfig, type VoiceConfig } from "./config.ts"
import { createAnnouncementGate, type AnnouncementGate } from "./announcement-gate.ts"

interface PluginContext {
  event: {
    subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown>
  }
  session: unknown
}

const SILENT_LOG = () => {
  // Log silencioso por defecto; el resumen debug se emite después de cada evento.
}

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, "..")
const configPath = join(pluginDir, "config.json")
const clipsDir = join(pluginDir, "clips")
const RETRY_MIN_MS = 100
const RETRY_MAX_MS = 1_000
const SINGLETON_KEY = Symbol.for("odin-voice.singleton")
const MODULE_INSTANCE_KEY = Symbol.for("odin-voice.module-instance")
const globals = globalThis as Record<PropertyKey, unknown>
const previousModuleInstance = globals[MODULE_INSTANCE_KEY]
const moduleInstance = typeof previousModuleInstance === "number" ? previousModuleInstance + 1 : 1
globals[MODULE_INSTANCE_KEY] = moduleInstance

interface ReceivedAnnouncement {
  eventType: string
  context: VoiceContext
}

interface VoiceSingleton {
  handler: OdinVoiceHandler
  gate: AnnouncementGate<ReceivedAnnouncement>
  contexts: Map<symbol, PluginContext>
  controller: AbortController | undefined
  consumerToken: symbol | undefined
  consuming: boolean
  singletonShared: boolean
  moduleInstance: number
}

function readConfig(): VoiceConfig {
  try {
    if (!existsSync(configPath)) return parseConfig(null, SILENT_LOG)
    return parseConfig(readFileSync(configPath, "utf8"), SILENT_LOG)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    SILENT_LOG(`odin-voice: readConfig error: ${msg}`)
    return parseConfig(null, SILENT_LOG)
  }
}

function detectPlayers(): string[] {
  const present: string[] = []
  const searchDirs = [
    "/usr/bin",
    "/usr/local/bin",
    "/bin",
    ...(process.env.PATH || "").split(":").filter(Boolean),
  ]
  for (const name of ["paplay", "pw-play", "ffplay", "mpv", "aplay"]) {
    if (searchDirs.some((dir) => {
      try { return existsSync(`${dir}/${name}`) } catch { return false }
    })) {
      present.push(name)
    }
  }
  return present
}

function spawnDetached(argv: string[]): void {
  try {
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    SILENT_LOG(`odin-voice: spawn error: ${msg}`)
  }
}

function handleEvent(singleton: VoiceSingleton, eventType: string, context: VoiceContext): void {
  try {
    const decision: Decision = safeOnEvent(singleton.handler, eventType, context, SILENT_LOG)

    if (decision.kind === "play") {
      const clipPath = join(clipsDir, decision.clip)
      spawnDetached(buildCommand(decision.player, clipPath, decision.volume))
    }

    if (process.env.ODIN_VOICE_DEBUG === "1") {
      const debug = {
        eventType: eventType === "session.idle" || eventType === "session.error" || eventType === "question.asked" || eventType === "permission.asked"
          ? eventType
          : "unknown",
        subagent: context.subagent,
        agent: context.agent?.toLowerCase() ?? null,
        decision: decision.kind === "play" ? "play" : `silence:${decision.reason}`,
        moduleInstance: singleton.moduleInstance,
        singletonShared: singleton.singletonShared,
      }
      process.stderr.write(`odin-voice: ${JSON.stringify(debug)}\n`)
    }
  } catch {
    // Ningún fallo del adapter puede romper el consumidor de eventos.
  }
}

function createSingleton(): VoiceSingleton {
  let singleton: VoiceSingleton
  const handler = createOdinVoiceHandler({
    readConfig,
    env: process.env as Record<string, string>,
    now: () => Date.now(),
    random: Math.random,
    existsSync: (clip) => {
      try { return existsSync(join(clipsDir, clip)) } catch { return false }
    },
    detectPlayers,
    log: SILENT_LOG,
  })
  const gate = createAnnouncementGate<ReceivedAnnouncement>({
    now: () => Date.now(),
    schedule: (run, delay) => setTimeout(run, delay),
    cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    dispatch: (announcement) => {
      if (singleton.contexts.size > 0) handleEvent(singleton, announcement.eventType, announcement.context)
    },
  })
  singleton = {
    handler,
    gate,
    contexts: new Map(),
    controller: undefined,
    consumerToken: undefined,
    consuming: false,
    singletonShared: false,
    moduleInstance,
  }
  return singleton
}

function getSingleton(): VoiceSingleton {
  const existing = globals[SINGLETON_KEY] as VoiceSingleton | undefined
  if (existing !== undefined) {
    existing.singletonShared = true
    return existing
  }
  const singleton = createSingleton()
  globals[SINGLETON_KEY] = singleton
  return singleton
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      done()
    }
    function done(): void {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function activeContext(singleton: VoiceSingleton): [symbol, PluginContext] | undefined {
  return singleton.contexts.entries().next().value as [symbol, PluginContext] | undefined
}

async function consume(singleton: VoiceSingleton, controller: AbortController): Promise<void> {
  singleton.consuming = true
  let retryMs = RETRY_MIN_MS
  try {
    while (!controller.signal.aborted) {
      const active = activeContext(singleton)
      if (active === undefined) return
      const [, ctx] = active
      const lookup = createSessionLookup(ctx)
      let received = false
      try {
        for await (const payload of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) return
          received = true
          try {
            const { eventType, context } = await extractEvent(payload, lookup)
            if (!controller.signal.aborted) singleton.gate.announce({ eventType, context })
          } catch {
            if (!controller.signal.aborted) singleton.gate.announce({ eventType: "", context: { subagent: false } })
          }
        }
      } catch {
        // Reintentar el stream salvo que el cleanup haya abortado intencionalmente.
      }
      if (controller.signal.aborted || singleton.contexts.size === 0) return
      await waitForRetry(retryMs, controller.signal)
      retryMs = received ? RETRY_MIN_MS : Math.min(retryMs * 2, RETRY_MAX_MS)
    }
  } finally {
    if (singleton.controller === controller) {
      singleton.consuming = false
      singleton.consumerToken = undefined
    }
  }
}

function ensureConsumer(singleton: VoiceSingleton): void {
  const active = activeContext(singleton)
  if (active === undefined) return
  if (singleton.consuming && !singleton.controller?.signal.aborted) return
  if (singleton.controller === undefined || singleton.controller.signal.aborted) {
    singleton.controller = new AbortController()
  }
  singleton.consumerToken = active[0]
  void consume(singleton, singleton.controller)
}

export const OdinVoice = Plugin.define({
  id: "odin-voice",
  setup(ctx: PluginContext) {
    const singleton = getSingleton()
    const token = Symbol("odin-voice-location")
    singleton.contexts.set(token, ctx)
    ensureConsumer(singleton)
    return () => {
      const ownsConsumer = singleton.consumerToken === token
      singleton.contexts.delete(token)
      if (singleton.contexts.size === 0) {
        singleton.gate.cancel()
        singleton.controller?.abort()
      } else if (ownsConsumer) {
        singleton.controller?.abort()
        ensureConsumer(singleton)
      }
    }
  },
})

export default OdinVoice
