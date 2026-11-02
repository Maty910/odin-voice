import { describe, expect, it, vi } from "vitest"
import { runGenerateClips } from "../scripts/generate-clips.ts"

describe("runGenerateClips", () => {
  it("A7: dry-run uses no credentials, fetch, directory creation, or clip writes", async () => {
    const fetch = vi.fn()
    const writeClip = vi.fn()
    const ensureClipsDir = vi.fn()
    const stdout = vi.fn()
    const stderr = vi.fn()

    const status = await runGenerateClips({
      argv: ["--dry-run"],
      env: {},
      loadConfig: () => ({
        categories: {
          finished: {
            clips: [
              { clip: "finished-1.mp3", phrase: "[pause] It is done." },
              { clip: "finished-flow-1.mp3", phrase: "[long pause] All returned.", scope: "flow" },
            ],
          },
        },
      }),
      listExisting: () => new Set(),
      ensureClipsDir,
      fetch,
      writeClip,
      stdout,
      stderr,
    })

    expect(status).toBe(0)
    expect(stdout).toHaveBeenCalledWith("generate-clips: 2 clip(s) a generar (dry-run)\n")
    expect(fetch).not.toHaveBeenCalled()
    expect(writeClip).not.toHaveBeenCalled()
    expect(ensureClipsDir).not.toHaveBeenCalled()
    expect(stderr).not.toHaveBeenCalled()
  })
})
