import type { Category } from "./events.ts"

export type CooldownVerdict = "allow" | "deny"

export interface CooldownDeps {
  now: () => number
  cooldowns: Record<Category, number>
}

export interface Cooldown {
  check(category: Category): CooldownVerdict
}

export function createCooldown(deps: CooldownDeps): Cooldown {
  const last = new Map<Category, number>()

  return {
    check(category: Category): CooldownVerdict {
      const cooldownMs = deps.cooldowns[category]
      const now = deps.now()
      const t0 = last.get(category)

      // R13: cooldownMs=0 siempre allow
      if (cooldownMs === 0) {
        last.set(category, now)
        return "allow"
      }

      // Primera vez: allow
      if (t0 === undefined) {
        last.set(category, now)
        return "allow"
      }

      const elapsed = now - t0
      // R11: borde inclusivo (>=)
      if (elapsed >= cooldownMs) {
        last.set(category, now)
        return "allow"
      }

      // R10: dentro de ventana
      return "deny"
    },
  }
}
