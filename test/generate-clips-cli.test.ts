import { readFileSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, "..")
const scriptPath = resolve(pluginDir, "scripts", "generate-clips.ts")
const clipsDir = resolve(pluginDir, "clips")
const configPath = resolve(pluginDir, "config.json")

interface ConfigShape {
  categories: Record<string, { clips: Array<{ clip: string }> }>
}

describe("generate-clips --dry-run", () => {
  it("A7: needs no credentials and does not write clips while listing the complete plan", () => {
    const before = readdirSync(clipsDir).sort()
    const config = JSON.parse(readFileSync(configPath, "utf8")) as ConfigShape
    const configuredClips = Object.values(config.categories).flatMap(({ clips }) => clips)
    const expectedCount = configuredClips.length
    const result = spawnSync(process.execPath, [scriptPath, "--dry-run", "--force"], {
      cwd: pluginDir,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`generate-clips: ${expectedCount} clip(s) a generar (dry-run)`)
    expect(configuredClips.map(({ clip }) => clip)).toContain("finished-iris-1.mp3")
    expect(result.stdout).toContain("finished-iris-1.mp3")
    expect(result.stderr).toBe("")
    expect(readdirSync(clipsDir).sort()).toEqual(before)
  })
})
