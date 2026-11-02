import type { ClipEntry, VoiceConfig } from "./config.ts"
import type { VoiceContext } from "./context.ts"
import { mapEventToCategory, type Category } from "./events.ts"
import { selectPlayer, type PlayerName } from "./player.ts"

export type Decision =
  | {
      kind: "play"
      clip: string
      player: PlayerName
      volume: number
    }
  | {
      kind: "silence"
      reason: "unknown-event" | "disabled" | "cooldown" | "no-player" | "muted" | "no-clip"
    }

export interface OdinVoiceDeps {
  config: VoiceConfig
  env: Record<string, string>
  now: () => number
  detectPlayers: () => string[]
  log: (message: string) => void
}

export interface OdinVoiceHandlerDeps {
  readConfig: () => VoiceConfig
  env: Record<string, string>
  now: () => number
  random: () => number
  existsSync: (clip: string) => boolean
  detectPlayers: () => string[]
  log: (message: string) => void
}

export interface OdinVoice {
  onEvent(eventType: string, context?: VoiceContext): Decision
}

export type OdinVoiceHandler = OdinVoice

function safeDetectPlayers(deps: OdinVoiceHandlerDeps): string[] {
  try {
    return deps.detectPlayers()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    deps.log(`odin-voice: detectPlayers error: ${msg}`)
    return []
  }
}

function clipPool(category: { clips?: ClipEntry[]; clip: string; phrase: string }): ClipEntry[] {
  return category.clips ?? [{ clip: category.clip, phrase: category.phrase }]
}

function untagged(entries: ClipEntry[]): ClipEntry[] {
  return entries.filter((entry) => entry.agent === undefined && entry.scope === undefined)
}

function candidatesForContext(entries: ClipEntry[], context: VoiceContext & { flow?: boolean }): ClipEntry[] {
  const generic = untagged(entries)
  if (context.subagent) {
    const agent = context.agent?.toLowerCase()
    const agentEntries = agent === undefined
      ? []
      : entries.filter((entry) => entry.agent?.toLowerCase() === agent)
    return agentEntries.length > 0 ? agentEntries : generic
  }
  if (context.flow) {
    const flowEntries = entries.filter((entry) => entry.scope === "flow")
    return flowEntries.length > 0 ? flowEntries : generic
  }
  return generic
}

function choose(entries: ClipEntry[], previous: string | undefined, random: () => number): ClipEntry {
  const alternatives = previous === undefined
    ? entries
    : entries.filter((entry) => entry.clip !== previous)
  const pool = alternatives.length > 0 ? alternatives : entries
  const value = random()
  const index = Number.isFinite(value)
    ? Math.max(0, Math.min(pool.length - 1, Math.floor(value * pool.length)))
    : 0
  return pool[index]!
}

function existing(entries: ClipEntry[], deps: OdinVoiceHandlerDeps): ClipEntry[] {
  return entries.filter((entry) => {
    try {
      return deps.existsSync(entry.clip)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.log(`odin-voice: existsSync error: ${msg}`)
      return false
    }
  })
}

// Crea una vez el estado por categoría y por sesión; la config se relee en cada evento.
export function createOdinVoiceHandler(deps: OdinVoiceHandlerDeps): OdinVoiceHandler {
  const lastPlayedAt = new Map<Category, number>()
  const lastClip = new Map<Category, string>()
  const subagentSeen = new Map<string, boolean>()

  const contextForEvent = (category: Category, context: VoiceContext): VoiceContext & { flow?: boolean } => {
    if (category !== "finished") return context
    if (context.subagent) {
      if (context.topSessionID !== undefined) subagentSeen.set(context.topSessionID, true)
      return context
    }

    const flow = context.topSessionID !== undefined && subagentSeen.get(context.topSessionID) === true
    if (context.topSessionID !== undefined) subagentSeen.delete(context.topSessionID)
    return { ...context, flow }
  }

  return {
    onEvent(eventType: string, inputContext: VoiceContext = { subagent: false }): Decision {
      const config = deps.readConfig()

      if (deps.env.ODIN_VOICE_MUTE === "1") {
        return { kind: "silence", reason: "muted" }
      }

      const category = mapEventToCategory(eventType)
      if (category === null) {
        return { kind: "silence", reason: "unknown-event" }
      }

      const context = contextForEvent(category, inputContext)
      const categoryConfig = config.categories[category]
      if (!categoryConfig.enabled) {
        return { kind: "silence", reason: "disabled" }
      }

      const candidates = existing(candidatesForContext(clipPool(categoryConfig), context), deps)
      if (candidates.length === 0) {
        return { kind: "silence", reason: "no-clip" }
      }

      const now = deps.now()
      const previousTime = lastPlayedAt.get(category)
      if (previousTime !== undefined && now - previousTime < categoryConfig.cooldownMs) {
        return { kind: "silence", reason: "cooldown" }
      }

      const player = selectPlayer(safeDetectPlayers(deps))
      if (player === null) {
        return { kind: "silence", reason: "no-player" }
      }

      const selected = choose(candidates, lastClip.get(category), deps.random)
      lastPlayedAt.set(category, now)
      lastClip.set(category, selected.clip)
      return { kind: "play", clip: selected.clip, player, volume: config.volume }
    },
  }
}

// Compatibilidad para consumidores del core anterior: config fija y todos los clips disponibles.
export function createOdinVoice(deps: OdinVoiceDeps): OdinVoice {
  return createOdinVoiceHandler({
    readConfig: () => deps.config,
    env: deps.env,
    now: deps.now,
    random: Math.random,
    existsSync: () => true,
    detectPlayers: deps.detectPlayers,
    log: deps.log,
  })
}

export function safeOnEvent(core: OdinVoice, eventType: string, log: (message: string) => void): Decision
export function safeOnEvent(
  core: OdinVoice,
  eventType: string,
  context: VoiceContext,
  log: (message: string) => void,
): Decision
export function safeOnEvent(
  core: OdinVoice,
  eventType: string,
  contextOrLog: VoiceContext | ((message: string) => void),
  maybeLog?: (message: string) => void,
): Decision {
  const context = typeof contextOrLog === "function" ? { subagent: false } : contextOrLog
  const log = typeof contextOrLog === "function" ? contextOrLog : maybeLog ?? (() => {})
  try {
    return core.onEvent(eventType, context)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`odin-voice: handler error: ${msg}`)
    return { kind: "silence", reason: "no-player" }
  }
}
