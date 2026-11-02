export type OpenCodeV2WireEvent = {
  type: "form.created" | "session.execution.succeeded"
  data: Record<string, unknown>
  properties?: never
}

export const formCreatedQuestion: OpenCodeV2WireEvent = {
  type: "form.created",
  data: {
    form: {
      sessionID: "top-1",
      metadata: { kind: "question" },
    },
  },
}

export const sessionExecutionSucceeded: OpenCodeV2WireEvent = {
  type: "session.execution.succeeded",
  data: { sessionID: "top-1" },
}
