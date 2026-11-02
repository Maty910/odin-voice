#!/usr/bin/env node
/** Genera clips mp3 con ElevenLabs o lista el plan sin efectos con --dry-run. */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { planClips, validateCredentials, type CategoryMap } from "../src/generate-clips.ts"

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, "..")
const configPath = join(pluginDir, "config.json")
const clipsDir = join(pluginDir, "clips")

interface ConfigShape {
  categories: CategoryMap
}

interface ParsedArgs {
  force: boolean
  dryRun: boolean
}

interface FetchResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

type FetchFn = (url: string, init: RequestInit) => Promise<FetchResponse>

export interface GenerateClipsDeps {
  argv: string[]
  env: Record<string, string | undefined>
  loadConfig: () => ConfigShape
  listExisting: () => Set<string>
  ensureClipsDir: () => void
  fetch: FetchFn
  writeClip: (path: string, data: Uint8Array) => void
  stdout: (message: string) => void
  stderr: (message: string) => void
}

function loadConfig(): ConfigShape {
  if (!existsSync(configPath)) {
    throw new Error(`config.json no encontrado en ${configPath}`)
  }
  return JSON.parse(readFileSync(configPath, "utf8")) as ConfigShape
}

function listExisting(): Set<string> {
  if (!existsSync(clipsDir)) return new Set()
  return new Set(readdirSync(clipsDir).filter((file) => file.endsWith(".mp3")))
}

function parseArgs(argv: string[]): ParsedArgs {
  return { force: argv.includes("--force"), dryRun: argv.includes("--dry-run") }
}

async function generateOne(
  deps: Pick<GenerateClipsDeps, "fetch" | "writeClip">,
  apiKey: string,
  voiceId: string,
  clip: string,
  phrase: string,
): Promise<void> {
  const response = await deps.fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: phrase,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  )

  if (!response.ok) {
    const errorText = await response.text().catch(() => "")
    throw new Error(`ElevenLabs ${response.status}: ${errorText.slice(0, 200)}`)
  }

  deps.writeClip(join(clipsDir, clip), Buffer.from(await response.arrayBuffer()))
}

export async function runGenerateClips(deps: GenerateClipsDeps): Promise<number> {
  const { force, dryRun } = parseArgs(deps.argv)
  const config = deps.loadConfig()
  const plan = planClips({ existing: deps.listExisting(), force, categories: config.categories })

  if (dryRun) {
    deps.stdout(`generate-clips: ${plan.length} clip(s) a generar (dry-run)\n`)
    for (const item of plan) {
      deps.stdout(`  - ${item.clip} ("${item.phrase}")\n`)
    }
    return 0
  }

  const credentials = validateCredentials({ env: deps.env })
  if (!credentials.ok) {
    deps.stderr(`generate-clips: falta variable de entorno ${credentials.missing}\n`)
    return 1
  }

  if (plan.length === 0) {
    deps.stdout("generate-clips: nada que hacer. Use --force para regenerar.\n")
    return 0
  }

  deps.ensureClipsDir()
  deps.stdout(`generate-clips: ${plan.length} clip(s) a generar${force ? " (force)" : ""}\n`)
  for (const item of plan) {
    deps.stdout(`  - ${item.clip} ("${item.phrase}")\n`)
    await generateOne(deps, deps.env.ELEVENLABS_API_KEY!, deps.env.ELEVENLABS_VOICE_ID!, item.clip, item.phrase)
    deps.stdout("    ok\n")
  }
  deps.stdout("generate-clips: done\n")
  return 0
}

async function main(): Promise<void> {
  const status = await runGenerateClips({
    argv: process.argv.slice(2),
    env: process.env,
    loadConfig,
    listExisting,
    ensureClipsDir: () => {
      if (!existsSync(clipsDir)) mkdirSync(clipsDir, { recursive: true })
    },
    fetch: globalThis.fetch as FetchFn,
    writeClip: writeFileSync,
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  })
  if (status !== 0) process.exitCode = status
}

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  main().catch((err) => {
    process.stderr.write(`generate-clips: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
