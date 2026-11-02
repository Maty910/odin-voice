export type Category = "finished" | "error" | "question" | "permission"

const TABLE: Record<string, Category> = {
  "session.idle": "finished",
  "session.error": "error",
  "question.asked": "question",
  "permission.asked": "permission",
}

export function mapEventToCategory(eventType: string): Category | null {
  return TABLE[eventType] ?? null
}
