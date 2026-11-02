/**
 * Guard estático de resolución de módulos (contrato Themis, Engram #3279).
 *
 * Todo specifier relativo (./ o ../) de import/export en el entry fino
 * (plugins/odin-voice.ts) + src/** + test/** DEBE terminar en ".ts", para
 * que el grafo cargue bajo Node ESM con type-stripping (OpenCode Desktop).
 * node:*, bare npm y rutas absolutas quedan fuera del contrato.
 *
 * Cobertura de detección: import/export estático (incl. `type` y cláusulas
 * multi-línea), import side-effect, export * / named / namespace re-exports,
 * e import dinámico con comillas o backticks — incluso con blancos/comentario
 * entre `import` y `(` (ESM válido). NO son código (y por tanto no cuentan):
 * comentarios, literales regex, strings y templates (el código de sus
 * ${interpolaciones} sí se escanea como código). Fuera del contrato (no se
 * flaggean): member access `.import(` e `import.meta.resolve` (no cargan grafo).
 *
 * Decisión D2 (sufijos query/fragmento): "./x.ts?raw" es violación. El
 * contrato solo acepta el sufijo ".ts" plano; cualquier otra cosa falla
 * ruidosamente en vez de pasar en silencio como conforme.
 *
 * Auto-conforme (A3): los ejemplos de violación dentro de este archivo se
 * arman por concatenación de strings y viven dentro de strings, nunca como
 * literales de import relativo sin .ts, para que el escaneo del propio guard
 * no los flaggee.
 */
import { describe, expect, it } from "vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, "..")
const entryFile = resolve(packageRoot, "..", "odin-voice.ts")
const guardFile = fileURLToPath(import.meta.url)

type Violation = { file: string; line: number; specifier: string }

/**
 * Cubre: `import … from "…"`, `import type … from "…"`, `export … from "…"`,
 * `export * from "…"`, side-effect `import "…"` y dinámico `import("…")` /
 * `import(`…`)` (backticks — los dynamic imports con template literal estática
 * son ESM válido y Node también intenta resolverlos).
 * Se aplica sobre el código ya depurado de comentarios/regex/strings (ver
 * stripNonCode); los matches que arranquen dentro de un string/template se
 * descartan vía mask.
 *
 * Dinámicos: entre `import` y `(` puede haber blancos y/o comentarios
 * (`import ("./x")` e `import /* c *\/ ("./x")` son ESM válido), por eso el
 * `\s*` (los comentarios ya llegan blanqueados). El lookbehind excluye el
 * member access `.import(` (propiedad llamada import): eso no resuelve módulos.
 */
const SPECIFIER_RE =
  /(?:import|export)\b(?:\s+type)?[^"'`();]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|(?<!\.\s*)\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g

// Contextos que permiten que un `/` arranque un literal regex (vs. división).
const REGEX_PRECEDING_CHARS = "(,=:[!&|?{};+-*%~^<>"
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
])

type LexFrame = { kind: "template" } | { kind: "interp"; braces: number }

/**
 * Separa código de no-código preservando índices (mismos offsets y newlines
 * que el fuente original) para reportar líneas correctas.
 *
 * - Comentarios // y /* … *\/: se blanquean (espacios).
 * - Literales regex: se blanquean. Un `/` abre regex solo si el ÚLTIMO token
 *   (identificador-keyword o puntuación) está en contexto regex (heurística
 *   estándar); `a / b` sigue siendo división porque el último token es el
 *   identificador `a`, no el `=` previo. Sin esto, un regex con `\/\/` traga
 *   el resto de la línea como si fuera comentario (falso negativo) y un regex
 *   con texto tipo import genera falsos positivos. Limitación conocida: tras
 *   `)` o `]` se asume división (ambigüedad real de JS sin parseo completo).
 * - Strings y templates: se preservan (los specifiers viven ahí) pero quedan
 *   marcados en mask; el código dentro de ${interpolaciones} se trata como
 *   código real (mask=false).
 */
function stripNonCode(source: string): { code: string; mask: boolean[] } {
  let code = ""
  const mask: boolean[] = []
  const frames: LexFrame[] = []
  let state: "code" | "line" | "block" | "string" | "regex" | "template" = "code"
  let quote = ""
  let regexClass = false
  let word = ""
  // Clase del ÚLTIMO token completado: "div" => un `/` a continuación es
  // división (valor previo: identificador, número, ), ], string, template,
  // regex). "reg" => un `/` a continuación abre regex (operador, keyword,
  // puntuación de contexto o inicio de input). Los comentarios/blancos NO la
  // alteran.
  let prev: "" | "div" | "reg" = ""
  // Últimas dos puntuaciones (para detectar ++ / -- como valor => división).
  // Se reinician en cada newline: por ASI, un `/` en línea nueva tras `i++`
  // arranca statement nuevo (regex), no es división del statement previo.
  let punct1 = ""
  let punct2 = ""
  const notePunct = (ch: string): void => {
    punct2 = punct1
    punct1 = ch
  }
  const n = source.length

  const flushWord = (): void => {
    if (word.length > 0) {
      prev = REGEX_PRECEDING_KEYWORDS.has(word) ? "reg" : "div"
      word = ""
    }
  }
  const push = (ch: string, masked: boolean): void => {
    code += ch
    mask.push(masked)
  }
  const blank = (ch: string): void => {
    push(ch === "\n" ? "\n" : " ", false)
  }
  const topFrame = (): LexFrame | undefined => frames[frames.length - 1]
  const inInterp = (): boolean => topFrame()?.kind === "interp"

  let i = 0
  while (i < n) {
    const c = source[i]
    const next = i + 1 < n ? source[i + 1] : ""

    if (state === "code") {
      if (c === "/" && next === "/") {
        flushWord()
        state = "line"
        blank(c)
        blank(next)
        i += 2
        continue
      }
      if (c === "/" && next === "*") {
        flushWord()
        state = "block"
        blank(c)
        blank(next)
        i += 2
        continue
      }
      if (c === "/") {
        flushWord()
        const postfixUpdate =
          (punct1 === "+" || punct1 === "-") && punct1 === punct2
        if (prev !== "div" && !postfixUpdate) {
          state = "regex"
          regexClass = false
          blank(c)
          i += 1
          continue
        }
        // división / operador: sigue siendo código
        prev = "reg"
        notePunct(c)
        push(c, false)
        i += 1
        continue
      }
      if (c === '"' || c === "'") {
        flushWord()
        state = "string"
        quote = c
        push(c, true)
        i += 1
        continue
      }
      if (c === "`") {
        flushWord()
        state = "template"
        frames.push({ kind: "template" })
        push(c, true)
        i += 1
        continue
      }
      if (inInterp() && c === "}") {
        const top = topFrame() as { kind: "interp"; braces: number }
        if (top.braces === 0) {
          frames.pop()
          state = "template"
          push(c, true)
          i += 1
          continue
        }
        top.braces -= 1
      }
      if (inInterp() && c === "{") {
        ;(topFrame() as { kind: "interp"; braces: number }).braces += 1
      }
      if (/[A-Za-z0-9_$]/.test(c)) {
        word += c
      } else {
        flushWord()
        if (/\s/.test(c)) {
          if (c === "\n" || c === "\r") {
            punct1 = ""
            punct2 = ""
          }
        } else {
          prev = REGEX_PRECEDING_CHARS.includes(c) ? "reg" : "div"
          notePunct(c)
        }
      }
      push(c, false)
      i += 1
      continue
    }

    if (state === "line") {
      if (c === "\n") {
        state = "code"
        punct1 = ""
        punct2 = ""
        push("\n", false)
      } else {
        blank(c)
      }
      i += 1
      continue
    }

    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code"
        blank(c)
        blank(next)
        i += 2
        continue
      }
      // un LineTerminator (aunque viva dentro de un comentario) corta ASI:
      // `i++ /* …\n */ /re/` ya no es división del statement previo
      if (c === "\n") {
        punct1 = ""
        punct2 = ""
      }
      blank(c)
      i += 1
      continue
    }

    if (state === "string") {
      push(c, true)
      if (c === "\\") {
        i += 1
        if (i < n) push(source[i], true)
        i += 1
        continue
      }
      if (c === quote) {
        state = "code"
        prev = "div" // un string es un valor: `/` tras él es división
      }
      i += 1
      continue
    }

    if (state === "regex") {
      blank(c)
      if (c === "\\") {
        i += 1
        if (i < n) blank(source[i])
        i += 1
        continue
      }
      if (c === "[") {
        regexClass = true
      } else if (c === "]") {
        regexClass = false
      } else if (c === "/" && !regexClass) {
        i += 1
        while (i < n && /[a-zA-Z]/.test(source[i])) {
          blank(source[i])
          i += 1
        }
        state = "code"
        prev = "div" // un regex es un valor: `/` tras él es división
        continue
      }
      i += 1
      continue
    }

    // template
    if (c === "\\") {
      push(c, true)
      i += 1
      if (i < n) push(source[i], true)
      i += 1
      continue
    }
    if (c === "$" && next === "{") {
      frames.push({ kind: "interp", braces: 0 })
      state = "code"
      push(c, true)
      push(next, true)
      i += 2
      continue
    }
    if (c === "`") {
      frames.pop()
      state = "code"
      prev = "div" // un template es un valor: `/` tras él es división
      push(c, true)
      i += 1
      continue
    }
    push(c, true)
    i += 1
  }

  return { code, mask }
}

/**
 * Clasificación: solo los relativos (./ o ../) están bajo contrato y DEBEN
 * terminar en ".ts" (D2: sufijos como "?raw" no terminan en ".ts" y por tanto
 * son violación — fail loud). node:*, absolutos (/…) y bare npm se ignoran.
 * import.meta.url/import.meta.resolve no matchean SPECIFIER_RE: el primero no
 * tiene string literal; el segundo no carga el grafo (fuera del contrato).
 * `.import(` (member access) queda excluido por el lookbehind de la rama dinámica.
 */
function isRelativeWithoutTs(specifier: string): boolean {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../")
  if (!isRelative) return false
  return !specifier.endsWith(".ts")
}

function extractViolations(source: string, file: string): Violation[] {
  const { code, mask } = stripNonCode(source)
  const violations: Violation[] = []
  for (const m of code.matchAll(SPECIFIER_RE)) {
    const start = m.index ?? 0
    // keyword import/export dentro de un string/template: no es código real
    if (mask[start]) continue
    const specifier = m[1] ?? m[2] ?? m[3]
    if (specifier === undefined) continue
    if (!isRelativeWithoutTs(specifier)) continue
    const line = code.slice(0, start).split("\n").length
    violations.push({ file, line, specifier })
  }
  return violations
}

/** entry fino + *.ts recursivos de src/ y test/ (excluye node_modules y scripts/). */
function collectFiles(candidateEntryFile = entryFile): string[] {
  const files: string[] = []
  // El wrapper ../odin-voice.ts vive fuera del repo por diseño y puede no
  // existir en clones o CI.
  if (existsSync(candidateEntryFile)) files.push(candidateEntryFile)
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "scripts") continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(full)
      }
    }
  }
  walk(join(packageRoot, "src"))
  walk(join(packageRoot, "test"))
  return files
}

// === Fixtures A3-safe: concatenación, nunca literales de import relativo sin .ts ===
const badFrom = 'import { x } from ' + '"./mod"'
const badSideEffect = 'import ' + '"./side-effect"'
const badDynamic = 'import(' + '"./dynamic")'
const badDynamicBacktick = 'import(' + '`./backtick`' + ')'
const badSingleQuote = "import { x } from " + "'./single'"
const badNamespaceImport = 'import * as ns from ' + '"./ns-import"'
const badTypeImport = 'import type { T } from ' + '"./type-only"'
const badExportStar = 'export * from ' + '"./star"'
const badExportNamed = 'export { a } from ' + '"./named"'
const badExportNs = 'export * as ns from ' + '"./ns"'
const badMultiLineClause = 'import {\n  a,\n} from ' + '"./multi-clause"'
const badMultiLineSpecifier = 'import { b } from\n  ' + '"./multi-spec"'
const badQuerySuffix = 'import ' + '"./mod.ts?raw"'
const badTrailingSpace = 'import ' + '"./mod.ts "'
const badUpperExt = 'import ' + '"./mod.TS"'

// Hueco H1: separador (blancos / comentario) entre `import` y `(` en dinámicos;
// `import ("./x")` e `import /* c */ ("./x")` son ESM válido (whitespace entre
// el keyword y Arguments) y Node también intenta resolverlos.
const badDynamicSpace = 'import ' + '("./space-paren")'
const badDynamicComment = 'import /* c */ ' + '("./comment-paren")'
const badDynamicNewlineInside = 'import(\n' + '"./nl-dyn"' + '\n)'
const badDynamicNewlineBefore = 'import\n' + '("./nl-before")'
// comentario entre from y specifier; comillas simples en side-effect/dinámico
const badFromWithComment = 'import { a } from /* c */ ' + '"./comment-from"'
const badSideEffectSingle = "import " + "'./se-single'"
const badDynamicSingle = "import(" + "'./dyn-single'" + ")"
// el código dentro de ${interpolaciones} de un template se escanea como código
const badInsideInterp = 'const t = ' + '`pre ${import("./interp-bad")} post`'

const goodFrom = 'import { x } from ' + '"./mod.ts"'
const goodParent = 'import { y } from ' + '"../parent.ts"'
const goodDynamicBacktick = 'import(' + '`./dyn.ts`' + ')'
const goodExportNamed = 'export { a } from ' + '"./named.ts"'

const okNode = 'import { spawn } from ' + '"node:child_process"'
const okBare = 'import { describe } from ' + '"vitest"'
const okAbsolute = 'import { x } from ' + '"/abs/mod"'
const okImportMeta = "const here = import.meta.url"
// import.meta.resolve NO carga el grafo (resuelve en runtime y falla loud por
// sí solo si no existe): fuera del contrato, no se flaggea ni con relativo sin .ts
const okImportMetaResolve = 'const p = import.meta.resolve(' + '"./tool")'
const okDynamicNode = 'const fs = import(' + '"node:fs"' + ')'
const okDynamicBare = 'const v = import(' + '"vitest"' + ')'

// No-código: comentarios, strings, templates y regex jamás deben contar
const fpLineComment = '// import ' + '"./ghost"'
const fpBlockComment = '/* export * from ' + '"./ghost"' + ' */'
const fpInsideString = 'const s = "import ' + "'./ghost'" + '"'
const fpInsideTemplate = 'const t = ' + '`' + 'export * from "./ghost"' + '`'
const fpRegexLiteral = 'const re = /import ' + '"\\.\\/ghost"' + '/'
// Hueco H2: `.import(` es member access (propiedad llamada import), NO un
// dynamic import; no debe flaggearse (incluida la forma con espacios ` . `).
const fpMemberImport = 'const m = obj.import(' + '"./member")'
const fpMemberImportSpaced = 'const n = foo . import(' + '"./member2")'

// Huecos de lexing ingenuo: el regex no debe esconder imports reales ni crear fantasmas
const fnRegexThenImport = 'const url = /https:\\/\\//; import ' + '"./after-regex"'
const fnDivisionThenImport = 'const r = a / b\nimport ' + '"./after-div"'
// ++/-- son valor (división), pero en línea nueva ASI arranca regex
const fnPostfixDivision = 'let i = 0\ni++ / 2\nimport ' + '"./after-postfix"'
const fpNewlineRegexAfterPostfix = 'i++\n' + '/re/.test(x)'
const fpPostfixThenCommentNewline = 'i++ // c\n' + '/re/.test(x)'

describe("module-resolution guard (contrato Themis #3279)", () => {
  it("A1: detecta relativo sin .ts y acepta relativo con .ts", () => {
    const bad = [
      badFrom,
      badSideEffect,
      badDynamic,
      badSingleQuote,
      badNamespaceImport,
      badTypeImport,
    ].join("\n")
    expect(extractViolations(bad, "<A1>").map((v) => v.specifier)).toEqual([
      "./mod",
      "./side-effect",
      "./dynamic",
      "./single",
      "./ns-import",
      "./type-only",
    ])
    expect(extractViolations([goodFrom, goodParent].join("\n"), "<A1>")).toEqual([])
  })

  it("A2: ignora node:, bare npm, absolutos, import.meta, meta.resolve y dinámicos no relativos", () => {
    const source = [okNode, okBare, okAbsolute, okImportMeta, okImportMetaResolve, okDynamicNode, okDynamicBare].join("\n")
    expect(extractViolations(source, "<A2>")).toEqual([])
  })

  it("A3: el guard está en el inventario y es auto-conforme", () => {
    expect(collectFiles()).toContain(guardFile)
    const source = readFileSync(guardFile, "utf8")
    expect(extractViolations(source, guardFile)).toEqual([])
  })

  it("omite un entry externo inexistente del inventario", () => {
    const missingEntry = resolve(packageRoot, "..", "odin-voice-entry-missing-for-test.ts")
    expect(existsSync(missingEntry)).toBe(false)
    expect(collectFiles(missingEntry)).not.toContain(missingEntry)

    const files = collectFiles()
    if (existsSync(entryFile)) {
      expect(files).toContain(entryFile)
    } else {
      expect(files).not.toContain(entryFile)
    }
  })

  it("todo specifier relativo del inventario termina en .ts", () => {
    const violations = collectFiles().flatMap((file) =>
      extractViolations(readFileSync(file, "utf8"), file),
    )
    const detail = violations
      .map((v) => `  ${v.file}:${v.line} -> ${v.specifier}`)
      .join("\n")
    expect(violations, `Specifiers relativos sin extensión .ts:\n${detail}`).toEqual([])
  })

  it("formas export: re-exports *, named y namespace se detectan", () => {
    const bad = [badExportStar, badExportNamed, badExportNs].join("\n")
    expect(extractViolations(bad, "<export>").map((v) => v.specifier)).toEqual([
      "./star",
      "./named",
      "./ns",
    ])
    expect(extractViolations(goodExportNamed, "<export>")).toEqual([])
  })

  it("multi-línea: cláusula o specifier en líneas separadas se detectan", () => {
    const source = [badMultiLineClause, "", badMultiLineSpecifier].join("\n")
    const violations = extractViolations(source, "<ml>")
    expect(violations.map((v) => v.specifier)).toEqual(["./multi-clause", "./multi-spec"])
    // la línea reportada es la del keyword que abre la sentencia
    expect(violations.map((v) => v.line)).toEqual([1, 5])
  })

  it("import dinámico con backticks está bajo contrato igual que con comillas", () => {
    expect(extractViolations(badDynamicBacktick, "<bt>").map((v) => v.specifier)).toEqual([
      "./backtick",
    ])
    expect(extractViolations(goodDynamicBacktick, "<bt>")).toEqual([])
  })

  it("decisión D2: sufijo estricto — query, espacio final y .TS fallan ruidosamente", () => {
    const source = [badQuerySuffix, badTrailingSpace, badUpperExt].join("\n")
    expect(extractViolations(source, "<d2>").map((v) => v.specifier)).toEqual([
      "./mod.ts?raw",
      "./mod.ts ",
      "./mod.TS",
    ])
  })

  it("no-código: comentarios, strings, templates y regex jamás cuentan", () => {
    const source = [fpLineComment, fpBlockComment, fpInsideString, fpInsideTemplate, fpRegexLiteral].join("\n")
    expect(extractViolations(source, "<fp>")).toEqual([])
  })

  it("literales regex: no esconden imports reales ni crean violaciones fantasma", () => {
    // un regex con barras escapadas no debe tragar el import que le sigue
    expect(extractViolations(fnRegexThenImport, "<re>").map((v) => v.specifier)).toEqual([
      "./after-regex",
    ])
    // una división real no debe tratarse como inicio de regex
    expect(extractViolations(fnDivisionThenImport, "<re>").map((v) => v.specifier)).toEqual([
      "./after-div",
    ])
    // i++ / 2: el ++ no vuelve regex al `/` (postfix update es valor)
    expect(extractViolations(fnPostfixDivision, "<re>").map((v) => v.specifier)).toEqual([
      "./after-postfix",
    ])
    // …pero en la línea siguiente ASI arranca statement: `/re/` es regex
    expect(extractViolations(fpNewlineRegexAfterPostfix, "<re>")).toEqual([])
    // el newline que cierra un // comment también corta el postfix
    expect(extractViolations(fpPostfixThenCommentNewline, "<re>")).toEqual([])
  })

  it("dinámico con separador antes del paréntesis se detecta (blancos, comentario, newline interno)", () => {
    const source = [
      badDynamicSpace,
      badDynamicComment,
      badDynamicNewlineInside,
      badDynamicNewlineBefore,
    ].join("\n")
    expect(extractViolations(source, "<dyn>").map((v) => v.specifier)).toEqual([
      "./space-paren",
      "./comment-paren",
      "./nl-dyn",
      "./nl-before",
    ])
  })

  it("comentario entre from y specifier, comillas simples y dinámico en interpolación se detectan", () => {
    const source = [badFromWithComment, badSideEffectSingle, badDynamicSingle, badInsideInterp].join("\n")
    expect(extractViolations(source, "<sep>").map((v) => v.specifier)).toEqual([
      "./comment-from",
      "./se-single",
      "./dyn-single",
      "./interp-bad",
    ])
  })

  it("member access .import(...) no es un dynamic import (sin falso positivo)", () => {
    const source = [fpMemberImport, fpMemberImportSpaced].join("\n")
    expect(extractViolations(source, "<fp-member>")).toEqual([])
  })
})
