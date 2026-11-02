import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { formCreatedQuestion, sessionExecutionSucceeded } from "./fixtures/opencode-v2-wire-events.ts"

const plugin = vi.hoisted(() => ({
  define: vi.fn(<T>(definition: T) => definition),
}))

const mocks = vi.hoisted(() => {
  const unref = vi.fn()
  return {
    existsSync: vi.fn<(path: string) => boolean>(),
    readFileSync: vi.fn<(path: string, encoding: string) => string>(),
    spawn: vi.fn(() => ({ unref })),
    unref,
  }
})

vi.mock("@opencode/plugin", () => ({ Plugin: plugin }))

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
}))

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}))

import OdinVoice from "../src/index.ts"

type V2Event = {
  type: string
  data?: Record<string, unknown>
  properties?: Record<string, unknown>
}

type V2Session = { parentID?: string; agent?: string }

interface EventStream {
  emit(event: V2Event): void
  evictSilently(): void
  readonly signal: AbortSignal | undefined
  subscribe: ReturnType<typeof vi.fn>
}

function createEventStream(): EventStream {
  const queued: V2Event[] = []
  let closed = false
  let evicted = false
  let signal: AbortSignal | undefined
  let resolveNext: ((result: IteratorResult<V2Event>) => void) | undefined

  const close = (): void => {
    closed = true
    resolveNext?.({ done: true, value: undefined })
    resolveNext = undefined
  }

  const iterable: AsyncIterable<V2Event> = {
    [Symbol.asyncIterator](): AsyncIterator<V2Event> {
      return {
        next: async (): Promise<IteratorResult<V2Event>> => {
          if (evicted) return new Promise(() => {})
          if (queued.length > 0) return { done: false, value: queued.shift()! }
          if (closed) return { done: true, value: undefined }
          return new Promise((resolve) => { resolveNext = resolve })
        },
      }
    },
  }

  const subscribe = vi.fn((options: { signal: AbortSignal }) => {
    signal = options.signal
    signal.addEventListener("abort", close, { once: true })
    return iterable
  })

  return {
    emit(event) {
      if (closed || evicted) return
      if (resolveNext !== undefined) {
        const resolve = resolveNext
        resolveNext = undefined
        resolve({ done: false, value: event })
        return
      }
      queued.push(event)
    },
    evictSilently() {
      evicted = true
      resolveNext = undefined
    },
    get signal() { return signal },
    subscribe,
  }
}

function createContext(
  sessions: Record<string, V2Session> = {},
  responses: {
    get?: (sessionID: string) => unknown | Promise<unknown>
    context?: (sessionID: string) => unknown | Promise<unknown>
  } = {},
) {
  const stream = createEventStream()
  const get = vi.fn(({ sessionID }: { sessionID: string }) => responses.get?.(sessionID) ?? {
    id: sessionID,
    ...sessions[sessionID],
  })
  const context = vi.fn(({ sessionID }: { sessionID: string }) => responses.context?.(sessionID) ?? [{
    info: { role: "user", sessionID, agent: sessions[sessionID]?.agent },
    parts: [],
  }])
  return {
    ctx: {
      event: { subscribe: stream.subscribe },
      session: { get, context },
    },
    stream,
    get,
    context,
  }
}

function idle(sessionID: string): V2Event {
  return { type: "session.idle", data: { sessionID } }
}

function formCreated(kind: string | undefined, sessionID = "top-1"): V2Event {
  return {
    type: "form.created",
    data: {
      form: {
        sessionID,
        ...(kind === undefined ? {} : { metadata: { kind } }),
      },
    },
  }
}

function executionSucceeded(sessionID: string): V2Event {
  return { type: "session.execution.succeeded", data: { sessionID } }
}

async function waitForSpawn(count: number) {
  await vi.advanceTimersByTimeAsync(900)
  expect(mocks.spawn).toHaveBeenCalledTimes(count)
}

function spawnedArgs(index: number): string {
  return mocks.spawn.mock.calls[index]?.[1].join(" ") ?? ""
}

const config = JSON.stringify({
  volume: 80,
  categories: {
    finished: { enabled: true, cooldownMs: 8000, clip: "finished.mp3", phrase: "It is done." },
    error: { enabled: true, cooldownMs: 8000, clip: "error.mp3", phrase: "Something is amiss." },
    question: { enabled: true, cooldownMs: 8000, clip: "question.mp3", phrase: "I have a question." },
    permission: { enabled: true, cooldownMs: 8000, clip: "permission.mp3", phrase: "I require your leave." },
  },
})

const agentConfig = JSON.stringify({
  ...JSON.parse(config),
  categories: {
    ...JSON.parse(config).categories,
    finished: {
      enabled: true,
      cooldownMs: 8000,
      clip: "finished.mp3",
      phrase: "It is done.",
      clips: [
        { clip: "finished.mp3", phrase: "It is done." },
        { clip: "finished-themis.mp3", phrase: "Themis.", agent: "themis" },
      ],
    },
  },
})

const flowConfig = JSON.stringify({
  ...JSON.parse(agentConfig),
  categories: {
    ...JSON.parse(agentConfig).categories,
    finished: {
      enabled: true,
      cooldownMs: 0,
      clip: "finished.mp3",
      phrase: "It is done.",
      clips: [
        { clip: "finished.mp3", phrase: "It is done." },
        { clip: "finished-themis.mp3", phrase: "Themis.", agent: "themis" },
        { clip: "finished-flow.mp3", phrase: "Flow complete.", scope: "flow" },
      ],
    },
  },
})

type V2Plugin = {
  id: string
  setup(ctx: ReturnType<typeof createContext>["ctx"]): () => void
}

describe("OdinVoice adapter V2", () => {
  const cleanups: Array<() => void> = []

  function setup(ctx: ReturnType<typeof createContext>["ctx"]): () => void {
    const cleanup = (OdinVoice as unknown as V2Plugin).setup(ctx)
    cleanups.push(cleanup)
    return cleanup
  }

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.existsSync.mockReset()
    mocks.readFileSync.mockReset()
    mocks.spawn.mockClear()
    mocks.unref.mockClear()
    mocks.existsSync.mockReturnValue(true)
    mocks.readFileSync.mockReturnValue(config)
  })

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
    delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("odin-voice.singleton")]
    vi.useRealTimers()
    delete process.env.ODIN_VOICE_DEBUG
  })

  it("V2-1: registra el plugin con id estable y export default de Plugin.define", () => {
    expect(plugin.define).toHaveBeenCalledWith(expect.objectContaining({
      id: "odin-voice",
      setup: expect.any(Function),
    }))
    expect((OdinVoice as unknown as V2Plugin).id).toBe("odin-voice")
  })

  it("V2-2: setup se suscribe al async iterable con signal y el cleanup aborta", () => {
    const { ctx, stream } = createContext()
    const cleanup = setup(ctx)

    expect(stream.subscribe).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
    expect(stream.signal?.aborted).toBe(false)
    cleanup()
    expect(stream.signal?.aborted).toBe(true)
  })

  it("V2-3: dos idle del mismo setup respetan cooldown", async () => {
    const { ctx, stream } = createContext()
    setup(ctx)

    stream.emit(idle("top-1"))
    await waitForSpawn(1)

    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      { detached: true, stdio: "ignore" },
    )
    expect(mocks.unref).toHaveBeenCalledTimes(1)

    stream.emit(idle("top-1"))
    await vi.advanceTimersByTimeAsync(900)

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it("I1: dos locations comparten singleton, emiten un spawn y un debug play por ráfaga", async () => {
    process.env.ODIN_VOICE_DEBUG = "1"
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const first = createContext()
    const second = createContext()
    setup(first.ctx)
    setup(second.ctx)

    first.stream.emit(idle("top-1"))
    await waitForSpawn(1)

    expect(first.stream.subscribe).toHaveBeenCalledTimes(1)
    expect(second.stream.subscribe).not.toHaveBeenCalled()
    const plays = stderr.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('"decision":"play"'))
    expect(plays).toHaveLength(1)
    expect(plays[0]).toContain('"moduleInstance":')
    expect(plays[0]).toContain('"singletonShared":true')
  })

  it("I2: cleanup del dueño evacuado conserva la reproducción del setup sobreviviente", async () => {
    const first = createContext()
    const second = createContext()
    const cleanupFirst = setup(first.ctx)
    setup(second.ctx)

    expect(first.stream.subscribe).toHaveBeenCalledTimes(1)
    expect(second.stream.subscribe).not.toHaveBeenCalled()

    cleanupFirst()
    first.stream.evictSilently()
    expect(first.stream.signal?.aborted).toBe(true)
    first.stream.emit(executionSucceeded("top-1"))
    second.stream.emit(executionSucceeded("top-1"))
    await waitForSpawn(1)

    expect(spawnedArgs(0)).toContain("finished.mp3")
    expect(first.stream.subscribe).toHaveBeenCalledTimes(1)
    expect(second.stream.subscribe).toHaveBeenCalledTimes(1)
  })

  it("I3: releva el consumidor a la tercera location tras dos cleanups consecutivos", async () => {
    const first = createContext()
    const second = createContext()
    const third = createContext()
    const cleanupFirst = setup(first.ctx)
    const cleanupSecond = setup(second.ctx)
    setup(third.ctx)

    cleanupFirst()
    first.stream.evictSilently()
    expect(second.stream.subscribe).toHaveBeenCalledTimes(1)

    cleanupSecond()
    second.stream.evictSilently()
    expect(third.stream.subscribe).toHaveBeenCalledTimes(1)
    third.stream.emit(executionSucceeded("top-1"))
    await waitForSpawn(1)

    expect(first.stream.subscribe).toHaveBeenCalledTimes(1)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it("C1: el cooldown compartido sobrevive cleanup y re-init de una location", async () => {
    const first = createContext()
    const cleanup = setup(first.ctx)
    first.stream.emit(idle("top-1"))
    await waitForSpawn(1)
    cleanup()

    const second = createContext()
    setup(second.ctx)
    second.stream.emit(idle("top-1"))
    await vi.advanceTimersByTimeAsync(900)

    expect(second.stream.subscribe).toHaveBeenCalledTimes(1)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it.each(["ends", "throws"])("R1: a stream that %s resubscribes and plays from its replacement", async (outcome) => {
    const replacement = createEventStream()
    const { ctx } = createContext()
    const failed: AsyncIterable<V2Event> = {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<V2Event>> => {
            if (outcome === "throws") throw new Error("stream disconnected")
            return { done: true, value: undefined }
          },
        }
      },
    }
    const subscribe = vi.fn((options: { signal: AbortSignal }) => {
      if (subscribe.mock.calls.length === 1) return failed
      return replacement.subscribe(options)
    })
    ctx.event.subscribe = subscribe
    setup(ctx)

    await vi.advanceTimersByTimeAsync(100)
    expect(subscribe).toHaveBeenCalledTimes(2)
    replacement.emit(idle("top-1"))
    await waitForSpawn(1)
  })

  it("V2-4: relee config por cada evento recibido del iterable", async () => {
    const first = JSON.stringify({
      ...JSON.parse(config),
      categories: {
        ...JSON.parse(config).categories,
        finished: { enabled: true, cooldownMs: 0, clip: "finished-old.mp3", phrase: "Old." },
      },
    })
    const second = JSON.stringify({
      ...JSON.parse(config),
      volume: 60,
      categories: {
        ...JSON.parse(config).categories,
        finished: { enabled: true, cooldownMs: 0, clip: "finished-new.mp3", phrase: "New." },
      },
    })
    mocks.readFileSync.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const { ctx, stream } = createContext()
    setup(ctx)

    stream.emit(idle("top-1"))
    await waitForSpawn(1)
    stream.emit(idle("top-1"))
    await waitForSpawn(2)

    expect(spawnedArgs(0)).toContain("finished-old.mp3")
    expect(spawnedArgs(1)).toContain("finished-new.mp3")
    expect(mocks.readFileSync).toHaveBeenCalledTimes(2)
  })

  it("V2-5: idle ID-only consulta get/context con { sessionID } y selecciona pool de agente", async () => {
    mocks.readFileSync.mockReturnValue(agentConfig)
    const { ctx, stream, get, context } = createContext({
      "child-1": { parentID: "top-1", agent: "themis" },
    })
    setup(ctx)

    stream.emit(idle("child-1"))
    await waitForSpawn(1)

    expect(get).toHaveBeenCalledWith({ sessionID: "child-1" })
    expect(context).toHaveBeenCalledWith({ sessionID: "child-1" })
    expect(spawnedArgs(0)).toContain("finished-themis.mp3")
  })

  it("V2-5b: subagent idle seguido de top-level idle selecciona el pool flow", async () => {
    mocks.readFileSync.mockReturnValue(flowConfig)
    const { ctx, stream, get, context } = createContext({
      "child-1": { parentID: "top-1", agent: "themis" },
    })
    setup(ctx)

    stream.emit(idle("child-1"))
    await waitForSpawn(1)
    stream.emit(idle("top-1"))
    await waitForSpawn(2)

    expect(get).toHaveBeenNthCalledWith(1, { sessionID: "child-1" })
    expect(context).toHaveBeenCalledWith({ sessionID: "child-1" })
    expect(get).toHaveBeenNthCalledWith(2, { sessionID: "top-1" })
    expect(spawnedArgs(0)).toContain("finished-themis.mp3")
    expect(spawnedArgs(1)).toContain("finished-flow.mp3")
  })

  it("V2-form-question: form.created question reproduces question clip", async () => {
    const { ctx, stream } = createContext()
    setup(ctx)

    stream.emit(formCreated("question"))
    await waitForSpawn(1)

    expect(spawnedArgs(0)).toContain("question.mp3")
  })

  it("V2-form-silence: non-question created, replied and cancelled do not reproduce", async () => {
    const { ctx, stream } = createContext()
    setup(ctx)

    stream.emit(formCreated("other"))
    stream.emit({ type: "form.replied", data: { form: { sessionID: "top-1" } } })
    stream.emit({ type: "form.cancelled", data: { form: { sessionID: "top-1" } } })
    await vi.advanceTimersByTimeAsync(900)

    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it("V2-execution-succeeded: top-level completion reproduces generic finished clip", async () => {
    const { ctx, stream } = createContext()
    setup(ctx)

    stream.emit(executionSucceeded("top-1"))
    await waitForSpawn(1)

    expect(spawnedArgs(0)).toContain("finished.mp3")
  })

  it("V2-execution-succeeded: child completion selects agent finished pool", async () => {
    mocks.readFileSync.mockReturnValue(agentConfig)
    const { ctx, stream, get, context } = createContext({
      "child-1": { parentID: "top-1", agent: "themis" },
    })
    setup(ctx)

    stream.emit(executionSucceeded("child-1"))
    await waitForSpawn(1)

    expect(get).toHaveBeenCalledWith({ sessionID: "child-1" })
    expect(context).toHaveBeenCalledWith({ sessionID: "child-1" })
    expect(spawnedArgs(0)).toContain("finished-themis.mp3")
  })

  it("V2-wire-anchor: fixtures preserve the real data envelope and reject properties", () => {
    for (const event of [formCreatedQuestion, sessionExecutionSucceeded]) {
      expect(event).toHaveProperty("data")
      expect(event).not.toHaveProperty("properties")
    }
  })

  it("V2-wire-integration: real-envelope fixtures reproduce their expected clips", async () => {
    const { ctx, stream } = createContext()
    setup(ctx)

    stream.emit(formCreatedQuestion)
    await waitForSpawn(1)
    expect(spawnedArgs(0)).toContain("question.mp3")

    stream.emit(sessionExecutionSucceeded)
    await waitForSpawn(2)
    expect(spawnedArgs(1)).toContain("finished.mp3")
  })

  it("V2-execution-silence: started and interrupted do not reproduce", async () => {
    const { ctx, stream } = createContext()
    setup(ctx)

    stream.emit({ type: "session.execution.started", data: { sessionID: "top-1" } })
    stream.emit({ type: "session.execution.interrupted", data: { sessionID: "top-1" } })
    await vi.advanceTimersByTimeAsync(900)

    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it("V2-execution-failed: verified failure reproduces error clip", async () => {
    const { ctx, stream } = createContext()
    setup(ctx)

    stream.emit({ type: "session.execution.failed", data: { sessionID: "top-1" } })
    await waitForSpawn(1)

    expect(spawnedArgs(0)).toContain("error.mp3")
  })

  it("V2-6: envelope, error y timeout del lookup V2 degradan sin rechazar el consumidor", async () => {
    mocks.readFileSync.mockReturnValue(JSON.stringify({
      ...JSON.parse(agentConfig),
      categories: {
        ...JSON.parse(agentConfig).categories,
        finished: { ...JSON.parse(agentConfig).categories.finished, cooldownMs: 0 },
      },
    }))
    const combined = createContext({}, {
      get: (sessionID) => {
        if (sessionID === "child-1") return { data: { id: sessionID, parentID: "top-1" }, request: {}, response: {} }
        if (sessionID === "private-child") throw new Error("denied")
        if (sessionID === "timeout-child") return new Promise(() => {})
        return { id: sessionID }
      },
      context: (sessionID) => ({
        data: [{ info: { role: "user", sessionID, agent: "themis" }, parts: [] }],
        request: {},
        response: {},
      }),
    })
    setup(combined.ctx)
    combined.stream.emit(idle("child-1"))
    await waitForSpawn(1)
    expect(spawnedArgs(0)).toContain("finished-themis.mp3")

    combined.stream.emit(idle("private-child"))
    await waitForSpawn(2)
    expect(spawnedArgs(1)).toContain("finished.mp3")

    combined.stream.emit(idle("timeout-child"))
    await vi.advanceTimersByTimeAsync(250)
    await waitForSpawn(3)

    // Runtime OpenCode v2.0.27: @opencode-ai/sdk@1.14.19
    // ~/.opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:243-246
    // declares EventQuestionAsked with the literal `type: "question.asked"`; its Event union includes it at :1741.
    combined.stream.emit({ type: "question.asked", properties: { sessionID: "top-1" } })
    await waitForSpawn(4)
    expect(spawnedArgs(3)).toContain("question.mp3")

    // Runtime OpenCode v2.0.27: @opencode-ai/sdk@1.14.19
    // ~/.opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:191-196
    // declares EventSessionError with the literal `type: "session.error"`; its Event union includes it at :1741.
    combined.stream.emit({ type: "session.error", properties: { sessionID: "top-1" } })
    await waitForSpawn(5)
    expect(spawnedArgs(4)).toContain("error.mp3")
  })

  it("V2-7: tras cleanup no se reproduce para eventos posteriores", async () => {
    const { ctx, stream } = createContext()
    const cleanup = setup(ctx)
    cleanup()

    stream.emit(idle("top-1"))
    await vi.advanceTimersByTimeAsync(1_000)

    expect(stream.signal?.aborted).toBe(true)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
