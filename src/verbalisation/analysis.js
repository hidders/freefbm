// Tools for rule writers: which rules a model uses (coverage), and which
// rules an earlier rule of the same phrase kind gets to first (overlaps).
//
// Coverage is measured: verbalise with a stats map (engine.js) counts for
// every rule how often its pattern matched, how often its guard then failed,
// how often its template failed, and the trace says which rules built each
// sentence.
//
// Overlaps are found statically, from the patterns: rule B is overlapped by
// an earlier rule A when every formula B's pattern matches is matched by A's
// pattern too (A's pattern subsumes B's) and A has no guard, or the same
// guard as B. Then B is tried only when A's template fails; when A's
// template cannot fail (it has only fixed words), B never fires.

// ── Coverage ─────────────────────────────────────────────────────────────────

export const ruleKey = (kind, name) => `${kind}: ${name}`

// A fresh stats map for verbalise.
export const newStats = () => new Map()

// The rules of a language in file order with their counts:
//   used      sentences whose final wording uses the rule
//   matched   times its pattern matched
//   rejected  times its guard failed after a match
//   failed    times its template failed after the guard passed
// results are verbalise results ({ trace } or { error }); fallbacks are the
// indices of results built with an 'unknown' rule or with no sentence.
export function coverage(language, results, stats) {
  const used = new Map()
  const fallbacks = []
  results.forEach((r, i) => {
    const trace = r?.trace ?? []
    for (const step of new Set(trace)) used.set(step, (used.get(step) ?? 0) + 1)
    if (!r?.tokens || trace.some(s => s.endsWith(': unknown'))) fallbacks.push(i)
  })
  const rules = []
  for (const [kind, list] of Object.entries(language?.rules ?? {})) {
    for (const rule of list) {
      const key = ruleKey(kind, rule.name)
      const s = stats?.get(key) ?? {}
      rules.push({ kind, name: rule.name, line: rule.line, key, used: used.get(key) ?? 0,
        matched: s.matched ?? 0, rejected: s.rejected ?? 0, failed: s.failed ?? 0 })
    }
  }
  rules.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
  return { rules, unused: rules.filter(r => !r.used), fallbacks }
}

// ── Overlaps ─────────────────────────────────────────────────────────────────

// [{ kind, name, line, by, byLine, never }]: rule name is tried only when the
// earlier rule by fails (never: by cannot fail, so name never fires).
export function overlaps(language) {
  const out = []
  for (const [kind, list] of Object.entries(language?.rules ?? {})) {
    list.forEach((b, j) => {
      for (const a of list.slice(0, j)) {
        if (a.guard && a.guardKey !== b.guardKey) continue
        // In verb phrase rules ?subj is bound to the subject before matching.
        const seed = kind === 'vp' ? new Map([['?subj', '?subj']]) : new Map()
        if (!subsumes(a.match, b.match, seed)) continue
        out.push({ kind, name: b.name, line: b.line, by: a.name, byLine: a.line, never: !a.fallible })
        break
      }
    })
  }
  return out
}

const isMeta = (p) => typeof p === 'string' && p.startsWith('?')
const isTail = (p) => isMeta(p) && p.endsWith('*')
const isObj = (p) => !!p && typeof p === 'object' && !Array.isArray(p)

// Whether every value matching q also matches p. bound maps p's
// metavariables to the parts of q they matched: a metavariable that occurs
// twice in p needs the same part of q twice.
export function subsumes(p, q, bound = new Map()) {
  if (q?.$as) return subsumes(p, q.p, bound)
  if (p === '_') return true
  if (isMeta(p)) {
    if (bound.has(p)) return same(bound.get(p), q)
    bound.set(p, q)
    return true
  }
  if (p?.$as) return subsumes(p.p, q, bound) && subsumes(p.$as, q, bound)
  if (Array.isArray(p)) return subsumesList(p, q, bound)
  if (isObj(p)) {
    if (p.$fact) return isObj(q) && !!q.$fact && subsumesFact(p, q, bound)
    if (!isObj(q)) return false
    // A fact pattern stands for { t: 'fact', factId: … } with unknown args.
    const fields = q.$fact ? { t: 'fact', factId: q.$fact } : q
    return Object.keys(p).every(k => {
      if (k in fields) return subsumes(p[k], fields[k], bound)
      // q leaves the field open, so only an unconstrained field of p matches
      // whatever it holds.
      if (p[k] === '_') return true
      if (isMeta(p[k]) && !bound.has(p[k])) { bound.set(p[k], { open: k }); return true }
      return false
    })
  }
  return p === q
}

function subsumesList(p, q, bound) {
  if (!Array.isArray(q)) return false
  const pTail = p.length && isTail(p[p.length - 1])
  const qTail = q.length && isTail(q[q.length - 1])
  const pf = pTail ? p.slice(0, -1) : p
  const qf = qTail ? q.slice(0, -1) : q
  if (pTail ? qf.length < pf.length : qTail || qf.length !== pf.length) return false
  return pf.every((x, i) => subsumes(x, qf[i], bound))
}

// Fact patterns: p's fact type subsumes q's, every variable p requires q
// requires too, and without a rest p allows no arguments q might have.
function subsumesFact(p, q, bound) {
  if (!subsumes(p.$fact, q.$fact, bound)) return false
  const qHas = q.has ?? []
  const mapped = (p.has ?? []).map(m => (bound.has(m) ? bound.get(m) : m))
  if (!mapped.every(m => qHas.includes(m))) return false
  if (!p.rest) return !q.rest && qHas.length === mapped.length
  return true
}

function same(a, b) {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}
