// The rule language: parses rule files (.vr) and compiles them into the rule
// objects the engine applies ({ name, match, guard, template }), so a
// language is a rule file plus a library of functions written in JavaScript.
//
// A file holds a language declaration and rules:
//
//   language en "English"
//
//   sentence rule each-at-most {
//     # ∀x (∃ys R → ∃^{≤n} ys R) says no more than ∀x ∃^{≤n} ys R
//     match:    ForAll([?x], Implies(?a, ?q @ Count(<=, ?n, ?ys, ?c)))
//     guard:    sameUpToWild(?a, ?c, ?ys)
//     template: "each" name(?x) vp(?q, ?x)
//   }
//
// Rules are tried in file order within their phrase kind (sentence, clause,
// vp). # starts a comment.
//
// Patterns (compiled to the data patterns of match.js):
//   _  ?x  ?xs*  ?q @ P  "text"  12  <= >= = .. ≈ ≉ < > ≤ ≥ ≠  [P, …]
//   { field: P, … }
//   ForAll(vars, body)  Exists(vars, body)  Count(op, n, vars, body)
//   Not(arg)  And(args)  Or(args)  Implies(left, right)  Iff(left, right)
//   Type(T, x)  Cmp(op, l, r)  VCmp(op, l, r)  TC(vars, body, args)
//   Fact(?P, {?x, ?y}, ?rest*)   a fact atom whose arguments include ?x, ?y
//   Node("dpred")  True
//
// Guards are expressions: ?x, "text", numbers, true, false, null, lists
// [a, b], field access ?a.t, env.verb, calls f(a, b), a == b, a != b, < > <=
// >=, a in [..], not, and, or. A guard passes when its value is truthy.
//
// Templates are sequences of items; the template fails (null) when an item
// does:
//   "words"                   fixed words (kw)
//   comma colon semicolon     punctuation
//   f(a, b, key: value)       a call; an argument is a sequence of items,
//                             passed as is when it is a single item
//   (item item …)             a group
//   if cond { … } else { … }  a choice; else is optional (then empty)
//   with(key: value) { … }    the items with a changed environment
//   node                      the matched formula
//
// Calls go to the built-ins below, then to the language's library, whose
// functions take the phrase helpers h first: lib.f(h, a, b, { key: value }).
// Built-ins: name(v), typeName(T), ref(v), clause(F), sentence(F),
// vp(F, v, key: value), term(t), reading(A, subject: v), kw(text),
// punct(text), len(list), any(list, pred), all(list, pred).
//
// Errors carry the line and column: { message, line, col }.

import { tok } from './engine.js'

const KINDS = ['sentence', 'clause', 'vp']
const OPS = { '<=': '≤', '>=': '≥', '!=': '≠', '≤': '≤', '≥': '≥', '=': '=', '..': '..', '≈': '≈', '≉': '≉', '<': '<', '>': '>', '≠': '≠' }

export class RuleSyntaxError extends Error {
  constructor(message, line, col) {
    super(`${message} (line ${line}, column ${col})`)
    this.reason = message
    this.line = line
    this.col = col
  }
}

// ── Tokens ───────────────────────────────────────────────────────────────────

function tokenise(src) {
  const out = []
  let i = 0, line = 1, col = 1
  const adv = (n) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') { line++; col = 1 } else col++
      i++
    }
  }
  while (i < src.length) {
    const c = src[i]
    if (c === '#') { while (i < src.length && src[i] !== '\n') adv(1); continue }
    if (/\s/.test(c)) { adv(1); continue }
    const at = { line, col }
    let m
    const rest = src.slice(i)
    if ((m = /^"((?:[^"\\\n]|\\.)*)"/.exec(rest))) {
      out.push({ k: 'str', v: m[1].replace(/\\(.)/g, '$1'), ...at }); adv(m[0].length); continue
    }
    if (c === '"') throw new RuleSyntaxError('Unterminated string', line, col)
    if ((m = /^\?[A-Za-z_][\w]*\*?/.exec(rest))) { out.push({ k: 'meta', v: m[0], ...at }); adv(m[0].length); continue }
    if ((m = /^\d+(\.\d+)?/.exec(rest))) { out.push({ k: 'num', v: Number(m[0]), ...at }); adv(m[0].length); continue }
    if ((m = /^[A-Za-z_][\w-]*/.exec(rest))) { out.push({ k: 'id', v: m[0], ...at }); adv(m[0].length); continue }
    if ((m = /^(==|!=|<=|>=|\.\.|[≤≥≈≉≠<>=])/.exec(rest))) { out.push({ k: 'op', v: m[0], ...at }); adv(m[0].length); continue }
    if ('{}()[],:.@'.includes(c)) { out.push({ k: c, v: c, ...at }); adv(1); continue }
    throw new RuleSyntaxError(`Unexpected character '${c}'`, line, col)
  }
  out.push({ k: 'eof', v: 'end of file', line, col })
  return out
}

// ── Parser ───────────────────────────────────────────────────────────────────

// Parses a rule file into { id, label, rules: [{ kind, name, match, guard,
// template, line }] } with guard and template as syntax trees.
export function parseRules(src) {
  const ts = tokenise(src)
  let p = 0
  const peek = (o = 0) => ts[p + o]
  const fail = (msg, t = peek()) => { throw new RuleSyntaxError(msg, t.line, t.col) }
  const is = (k, v) => peek().k === k && (v === undefined || peek().v === v)
  const eat = (k, v) => {
    if (!is(k, v)) fail(`Expected ${v ?? k}, found ${peek().v === undefined ? peek().k : `'${peek().v}'`}`)
    return ts[p++]
  }

  const file = { id: null, label: null, rules: [] }
  while (!is('eof')) {
    if (is('id', 'language')) {
      p++
      file.id = eat('id').v
      file.label = is('str') ? ts[p++].v : file.id
      continue
    }
    const kindTok = eat('id')
    if (!KINDS.includes(kindTok.v)) fail(`Expected a phrase kind (${KINDS.join(', ')}) or 'language'`, kindTok)
    eat('id', 'rule')
    const name = eat('id').v
    eat('{')
    const rule = { kind: kindTok.v, name, line: kindTok.line }
    while (!is('}')) {
      const f = eat('id')
      if (!['match', 'guard', 'template'].includes(f.v)) fail(`Expected match, guard or template, found '${f.v}'`, f)
      if (rule[f.v]) fail(`Rule ${name} has two ${f.v} fields`, f)
      eat(':')
      if (f.v === 'match') rule.match = pattern()
      else if (f.v === 'guard') rule.guard = expr()
      else rule.template = items(() => is('}') || (is('id') && ['match', 'guard', 'template'].includes(peek().v) && peek(1).k === ':'))
    }
    eat('}')
    if (rule.match === undefined) fail(`Rule ${name} has no match`, kindTok)
    if (!rule.template) fail(`Rule ${name} has no template`, kindTok)
    file.rules.push(rule)
  }
  return file

  // Patterns
  function pattern() {
    const t = peek()
    if (t.k === 'meta') {
      p++
      if (is('@')) { p++; return { $as: t.v, p: pattern() } }
      return t.v
    }
    if (t.k === 'id' && t.v === '_') { p++; return '_' }
    if (t.k === 'str' || t.k === 'num') { p++; return t.v }
    if (t.k === 'op') { p++; if (!OPS[t.v]) fail(`Unknown operator ${t.v}`, t); return OPS[t.v] }
    if (t.k === '[') { p++; const xs = list(']', pattern); return xs }
    if (t.k === '{') {
      p++
      const obj = {}
      while (!is('}')) {
        const k = eat('id').v
        eat(':')
        obj[k] = pattern()
        if (!is('}')) eat(',')
      }
      p++
      return obj
    }
    if (t.k === 'id') {
      p++
      if (t.v === 'True') return { t: 'true' }
      if (!is('(')) fail(`Unknown pattern ${t.v}`, t)
      p++
      if (t.v === 'Fact') {
        const fact = pattern()
        eat(',')
        eat('{')
        const has = list('}', () => eat('meta').v)
        let rest
        if (is(',')) { p++; rest = eat('meta').v; if (!rest.endsWith('*')) fail('The rest of a Fact pattern is a ?name* list') }
        eat(')')
        return { $fact: fact, has, ...(rest ? { rest } : {}) }
      }
      const args = list(')', pattern)
      const node = NODES[t.v]
      if (!node) fail(`Unknown pattern ${t.v}`, t)
      const arity = node[0] === null ? 1 : node.length - 1
      if (args.length !== arity) fail(`${t.v} takes ${arity} argument${arity > 1 ? 's' : ''}`, t)
      return node.slice(1).reduce((o, f, i) => ({ ...o, [f]: args[i] }), node[0] === null ? { t: args[0] } : { t: node[0] })
    }
    fail(`Unexpected ${t.v} in a pattern`)
  }

  function list(close, item) {
    const xs = []
    while (!is(close)) {
      xs.push(item())
      if (!is(close)) eat(',')
    }
    p++
    return xs
  }

  // Expressions (guards and conditions)
  function expr() { return orExpr() }
  function orExpr() {
    let l = andExpr()
    while (is('id', 'or')) { p++; l = { e: 'or', l, r: andExpr() } }
    return l
  }
  function andExpr() {
    let l = notExpr()
    while (is('id', 'and')) { p++; l = { e: 'and', l, r: notExpr() } }
    return l
  }
  function notExpr() {
    if (is('id', 'not')) { p++; return { e: 'not', x: notExpr() } }
    const l = postfix(primary())
    if (is('op') && ['==', '!=', '<', '>', '<=', '>=', '≤', '≥', '≠'].includes(peek().v)) {
      const op = OPS[ts[p++].v] ?? ts[p - 1].v
      return { e: 'cmp', op, l, r: postfix(primary()) }
    }
    if (is('id', 'in')) { p++; return { e: 'in', l, r: postfix(primary()) } }
    return l
  }
  function postfix(x) {
    while (is('.') ) { p++; x = { e: 'field', x, f: eat('id').v } }
    return x
  }
  function primary() {
    const t = peek()
    if (t.k === 'str') { p++; return { e: 'lit', v: t.v } }
    if (t.k === 'num') { p++; return { e: 'lit', v: t.v } }
    if (t.k === 'meta') { p++; return { e: 'meta', v: t.v, at: t } }
    if (t.k === 'op' && OPS[t.v]) { p++; return { e: 'lit', v: OPS[t.v] } }
    if (t.k === '[') { p++; return { e: 'list', xs: list(']', expr) } }
    if (t.k === '(') { p++; const x = expr(); eat(')'); return x }
    if (t.k === 'id') {
      p++
      if (t.v === 'true' || t.v === 'false' || t.v === 'null') return { e: 'lit', v: JSON.parse(t.v) }
      if (is('(')) { p++; return call(t, expr) }
      return { e: 'id', v: t.v, at: t }
    }
    fail(`Unexpected ${t.v}`)
  }

  // A call; arguments are parsed by arg, named ones as key: value.
  function call(t, arg) {
    const args = [], named = {}
    while (!is(')')) {
      if (is('id') && peek(1).k === ':') {
        const k = ts[p].v
        p += 2
        named[k] = arg()
      } else args.push(arg())
      if (!is(')')) eat(',')
    }
    p++
    return { e: 'call', f: t.v, args, named, at: t }
  }

  // Templates
  function items(stop) {
    const xs = []
    while (!stop()) {
      if (is('eof')) fail('Unexpected end of file in a template')
      xs.push(item())
    }
    return { e: 'group', xs }
  }
  function block() {
    eat('{')
    const g = items(() => is('}'))
    p++
    return g
  }
  function item() {
    const t = peek()
    if (t.k === 'id' && t.v === 'if') {
      p++
      const cond = expr()
      const then = block()
      let otherwise = { e: 'group', xs: [] }
      if (is('id', 'else')) { p++; otherwise = is('id', 'if') ? { e: 'group', xs: [item()] } : block() }
      return { e: 'if', cond, then, otherwise }
    }
    if (t.k === 'id' && t.v === 'with' && peek(1).k === '(') {
      p += 2
      const c = call(t, expr)
      return { e: 'with', env: c.named, body: block(), at: t }
    }
    if (t.k === '(') { p++; const g = items(() => is(')')); p++; return g }
    if (t.k === 'id' && peek(1).k === '(') {
      p += 2
      return postfix(call(t, () => items(() => is(',') || is(')'))))
    }
    return postfix(primary())
  }
}

// The node patterns: [t, fields…]; t null takes t from the first argument.
const NODES = {
  ForAll: ['forall', 'vars', 'body'],
  Exists: ['exists', 'vars', 'body'],
  Count: ['count', 'op', 'n', 'vars', 'body'],
  Not: ['not', 'arg'],
  And: ['and', 'args'],
  Or: ['or', 'args'],
  Implies: ['implies', 'left', 'right'],
  Iff: ['iff', 'left', 'right'],
  Type: ['type', 'typeId', 'arg'],
  Cmp: ['cmp', 'op', 'left', 'right'],
  VCmp: ['vcmp', 'op', 'left', 'right'],
  TC: ['tc', 'vars', 'body', 'args'],
  Node: [null],
}

// ── Compiler ─────────────────────────────────────────────────────────────────

const PUNCT = { comma: ',', colon: ':', semicolon: ';' }

// The built-in functions: (h, args, named) → value.
const BUILTINS = {
  name: (h, [v]) => tok(h.name(v), 'type'),
  typeName: (h, [T]) => tok(h.ctx.typeName(T), 'type'),
  ref: (h, [v]) => h.ref(v),
  clause: (h, [f], named) => h.clause(f, named),
  sentence: (h, [f]) => h.sentence(f),
  vp: (h, [f, v], named) => h.vp(f, v, named),
  term: (h, [t]) => h.term(t),
  reading: (h, [a], named) => h.reading(a, named.subject),
  kw: (h, [text]) => tok(text, 'kw'),
  punct: (h, [text]) => tok(text, 'punct'),
  len: (h, [xs]) => xs?.length ?? 0,
  any: (h, [xs, pred]) => (xs ?? []).some(x => pred(x)),
  all: (h, [xs, pred]) => (xs ?? []).every(x => pred(x)),
}

// Compiles a parsed file against a library into rule objects per kind.
// Unknown functions and names are reported here, not when a rule runs.
export function compileRules(file, lib) {
  const rules = Object.fromEntries(KINDS.map(k => [k, []]))
  for (const r of file.rules) {
    const guard = r.guard && compileExpr(r.guard, lib)
    const template = compileExpr(r.template, lib)
    rules[r.kind].push({
      name: r.name,
      line: r.line,
      match: r.match,
      ...(guard ? { guard: (b, h, node) => !!guard({ b, h, node }) } : {}),
      template: (b, h, node) => phrase(template({ b, h, node })),
    })
  }
  return rules
}

// A value as a phrase: words become kw tokens, a failed part fails the whole.
function phrase(v) {
  if (v === null || v === undefined || v === false) return null
  if (typeof v === 'string') return tok(v, 'kw')
  if (Array.isArray(v)) {
    const out = []
    for (const x of v) {
      const y = phrase(x)
      if (y === null) return null
      out.push(y)
    }
    return out
  }
  return v
}

function compileExpr(n, lib) {
  const c = (x) => compileExpr(x, lib)
  const err = (msg, at) => { throw new RuleSyntaxError(msg, at?.line ?? 0, at?.col ?? 0) }
  switch (n.e) {
    case 'lit': return () => n.v
    case 'meta': return ({ b }) => b[n.v]
    case 'list': { const xs = n.xs.map(c); return (s) => xs.map(x => x(s)) }
    case 'field': { const x = c(n.x); return (s) => x(s)?.[n.f] }
    case 'not': { const x = c(n.x); return (s) => !x(s) }
    case 'and': { const l = c(n.l), r = c(n.r); return (s) => l(s) && r(s) }
    case 'or': { const l = c(n.l), r = c(n.r); return (s) => l(s) || r(s) }
    case 'in': { const l = c(n.l), r = c(n.r); return (s) => (r(s) ?? []).includes(l(s)) }
    case 'cmp': {
      const l = c(n.l), r = c(n.r)
      const f = {
        '==': (a, b) => (a ?? null) === (b ?? null), '≠': (a, b) => (a ?? null) !== (b ?? null),
        '<': (a, b) => a < b, '>': (a, b) => a > b, '≤': (a, b) => a <= b, '≥': (a, b) => a >= b,
      }[n.op]
      return (s) => f(l(s), r(s))
    }
    case 'id': {
      if (n.v === 'env') return ({ h }) => h.env
      if (n.v === 'node') return ({ node }) => node
      if (PUNCT[n.v]) { const t = tok(PUNCT[n.v], 'punct'); return () => t }
      if (typeof lib[n.v] === 'function') return ({ h }) => (...args) => lib[n.v](h, ...args)
      return err(`Unknown name ${n.v}`, n.at)
    }
    case 'call': {
      const fn = BUILTINS[n.f] ?? (typeof lib[n.f] === 'function' ? (h, args, named) =>
        lib[n.f](h, ...args, ...(Object.keys(named).length ? [named] : [])) : null)
      if (!fn) return err(`Unknown function ${n.f}`, n.at)
      const args = n.args.map(c)
      const named = Object.entries(n.named).map(([k, v]) => [k, c(v)])
      return (s) => {
        const vals = args.map(a => a(s))
        // A failed argument (a sub-phrase that could not be built) fails the call.
        if (vals.some(v => v === null)) return null
        return fn(s.h, vals, Object.fromEntries(named.map(([k, v]) => [k, v(s)])))
      }
    }
    case 'group': {
      const xs = n.xs.map(c)
      if (xs.length === 1) return xs[0]
      return (s) => {
        const out = []
        for (const x of xs) {
          const v = phrase(x(s))
          if (v === null) return null
          out.push(v)
        }
        return out
      }
    }
    case 'if': {
      const cond = c(n.cond), then = c(n.then), otherwise = c(n.otherwise)
      return (s) => (cond(s) ? then(s) : otherwise(s))
    }
    case 'with': {
      const env = Object.entries(n.env).map(([k, v]) => [k, c(v)])
      const body = c(n.body)
      return (s) => body({ ...s, h: s.h.with(Object.fromEntries(env.map(([k, v]) => [k, v(s) ?? undefined]))) })
    }
    default:
      return err(`Cannot compile ${n.e}`)
  }
}

// A language from a rule file and its library: { id, label, rules, …the
// library's language hooks (term, refNP, wildNP, reflexive, verbForm,
// pluralise, shapeReading) }. Throws RuleSyntaxError.
export function compileLanguage(src, lib) {
  const file = parseRules(src)
  const { functions, ...hooks } = lib
  return { ...hooks, id: file.id ?? lib.id, label: file.label ?? lib.label, rules: compileRules(file, functions) }
}
