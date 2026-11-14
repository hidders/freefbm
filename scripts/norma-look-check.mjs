// Compares FreeFBM's drawing of an imported NORMA model with NORMA's own.
//
//   node scripts/norma-look-check.mjs [--shots DIR] [--only NAME] [--list N] [--tol PX] file.orm …
//
// NORMA saves the bounds of every shape it draws (AbsoluteBounds, in inches).
// The script opens each .orm file as File › Open does, and for every shape of
// every diagram compares NORMA's rectangle (× 200 px per inch) with the box
// FreeFBM draws for the same occurrence or label: object types, fact types
// (roles and bars; objectified ones with their outline), external and ring
// constraints, notes, readings, value and cardinality ranges, role names and
// the names of objectified fact types.
//
// It prints, per kind, how many shapes there are, the mean size difference
// (FreeFBM − NORMA, so + is larger in FreeFBM), the mean absolute size and
// centre differences, and how many differ by more than --tol px (default 2)
// in size or centre. --list N lists the N worst of each kind. With --shots,
// it saves a picture of each diagram with NORMA's rectangles (red, dashed)
// and FreeFBM's boxes (blue) drawn over FreeFBM's diagram.
//
// FreeFBM's boxes are read from the drawn SVG: the parts the components mark
// with data-look (object type outline, role boxes, bars, objectified outline,
// reading, role names, ranges, objectified name), so text is measured as
// drawn (its box is the font's height, about 3 px less than NORMA's line).
// Fact types are compared by their role boxes, which NORMA's shape holds less
// its margins and a band per level of bars, and by their bars: the levels
// each draws and where the outermost bar is. Constraints and notes are
// compared by the sizes FreeFBM gives them. Nothing runs in NORMA: the .orm
// file is enough, as long as NORMA saved it after drawing the diagrams.
import { createServer } from 'vite'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

// Playwright is not a dependency of the project: use the one installed globally.
const { chromium } = createRequire(import.meta.url)('playwright')

const args = process.argv.slice(2)
let shots = null, only = null, list = 0, tol = 2
const files = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--shots') shots = args[++i]
  else if (args[i] === '--only') only = args[++i]
  else if (args[i] === '--list') list = Number(args[++i])
  else if (args[i] === '--tol') tol = Number(args[++i])
  else files.push(args[i])
}
if (!files.length) {
  console.error('usage: node scripts/norma-look-check.mjs [--shots DIR] [--only NAME] [--list N] [--tol PX] file.orm …')
  process.exit(1)
}
if (shots) fs.mkdirSync(shots, { recursive: true })

const server = await createServer({ server: { port: 5198, strictPort: false }, logLevel: 'error' })
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch()
// pictures are for people: twice the resolution
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 }, deviceScaleFactor: shots ? 2 : 1 })
page.on('pageerror', e => console.error('page error:', e.message))
await page.goto(url)
await page.waitForSelector('.canvas-bg', { timeout: 60000 })

// Runs in the page: opens the file and pairs each NORMA shape with what
// FreeFBM draws for it (the parts the components mark with data-look).
async function measure({ content, name }) {
  const { useOrmStore } = await import('/src/store/ormStore.js')
  const { openModelFile } = await import('/src/import/openModelFile.js')
  const { freqStadiumW } = await import('/src/components/ConstraintNodes.jsx')
  const { formatFrequencyRange } = await import('/src/components/ObjectTypeNode.jsx')
  const { NORMA, px } = await import('/src/diagram/normaGeometry.js')
  openModelFile({ path: `${name}.orm`, content })
  const doc = new DOMParser().parseFromString(content.replace(/^﻿/, ''), 'application/xml')
  const byId = new Map()
  for (const el of doc.getElementsByTagName('*')) { const id = el.getAttribute('id'); if (id) byId.set(id, el) }
  const kids = (el, n) => el ? [...el.children].filter(c => !n || c.localName === n) : []
  const kid = (el, n) => kids(el, n)[0] ?? null
  const subjectOf = (sh) => kid(sh, 'Subject')?.getAttribute('ref')
  const rect = (sh) => {
    const b = (sh.getAttribute('AbsoluteBounds') ?? '').split(',').map(Number)
    if (b.length !== 4 || b.some(n => !Number.isFinite(n))) return null
    return { l: px(b[0]), t: px(b[1]), r: px(b[0] + b[2]), b: px(b[1] + b[3]) }
  }
  const box = (cx, cy, w, h) => ({ l: cx - w / 2, t: cy - h / 2, r: cx + w / 2, b: cy + h / 2 })
  const inset = (b, l, t, r, bt) => ({ l: b.l + l, t: b.t + t, r: b.r - r, b: b.b - bt })
  const union = (bs) => bs.length ? { l: Math.min(...bs.map(b => b.l)), t: Math.min(...bs.map(b => b.t)), r: Math.max(...bs.map(b => b.r)), b: Math.max(...bs.map(b => b.b)) } : null
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  const PEN = px(1 / 72), BAND = px(NORMA.constraintBand)

  // The world box of a drawn element: its bounding box in the diagram's coordinates.
  let world = null
  const worldBox = (el) => {
    const bb = el.getBBox()
    const m = world.getCTM().inverse().multiply(el.getCTM())
    const pts = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]
      .map(([x, y]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }))
    return { l: Math.min(...pts.map(p => p.x)), t: Math.min(...pts.map(p => p.y)), r: Math.max(...pts.map(p => p.x)), b: Math.max(...pts.map(p => p.y)) }
  }
  const drawn = (look, occId, extra = '') => [...document.querySelectorAll(`[data-look="${look}"][data-occ="${occId}"]${extra}`)].map(worldBox)

  // The role (or object type) a value or cardinality constraint belongs to, from the XML.
  function rangeOwner(id) {
    let el = byId.get(id)
    while (el && !['Role', 'EntityType', 'ValueType', 'ObjectifiedType'].includes(el.localName)) el = el.parentElement
    return el ? el.getAttribute('id') : null
  }

  const pairs = []
  const diagrams = []
  let unsized = 0
  for (const d of doc.getElementsByTagNameNS('*', 'ORMDiagram')) {
    const s = useOrmStore.getState()
    const diag = s.diagrams.find(x => x.id === d.getAttribute('id'))
    if (!diag) continue
    diagrams.push({ id: diag.id, name: diag.name })
    s.setActiveDiagram(diag.id)
    await frame()
    const t = `translate(${useOrmStore.getState().pan.x},${useOrmStore.getState().pan.y}) scale(${useOrmStore.getState().zoom})`
    world = [...document.querySelectorAll('svg g')].find(g => g.getAttribute('transform') === t)
    const st = useOrmStore.getState()
    const otMap = new Map(st.objectTypes.map(o => [o.id, o]))
    const factMap = new Map(st.facts.map(f => [f.id, f]))
    const conMap = new Map(st.constraints.map(c => [c.id, c]))
    const seen = new Map()   // element id → occurrences used so far
    const nextOcc = (elId) => {
      const occs = diag.occurrences.filter(o => o.schemaElementId === elId && !o.refModeOwnerOccId)
      const k = seen.get(elId) ?? 0
      seen.set(elId, k + 1)
      return occs[k] ?? null
    }
    const noteSeen = new Map()
    const add = (kind, label, norma, ours, extra) => {
      // a label NORMA has not sized yet (it saves 0.05 × 0.05 in until it draws one) says nothing
      if (norma && norma.r - norma.l <= 10.5 && norma.b - norma.t <= 10.5 && !/type|constraint|note/.test(kind)) { unsized++; return }
      if (norma && ours) pairs.push({ diagram: diag.name, diagramId: diag.id, kind, label, norma, ours, ...extra })
    }
    for (const sh of kids(kid(d, 'Shapes'))) {
      const subj = subjectOf(sh)
      const N = rect(sh)
      if (!N) continue
      const rel = kids(kid(sh, 'RelativeShapes')).filter(r => rect(r))
      if (sh.localName === 'ObjectTypeShape') {
        const ot = otMap.get(subj), occ = ot && nextOcc(subj)
        if (!occ) continue
        add(ot.kind === 'value' ? 'value type' : 'entity type', ot.name, N, drawn('shape', occ.id)[0])
        for (const r of rel) {
          const card = r.localName === 'CardinalityConstraintShape'
          if (!card && r.localName !== 'ValueConstraintShape') continue
          add(card ? 'cardinality range' : 'value range', ot.name, rect(r), drawn(card ? 'cardinality-range' : 'value-range', occ.id)[0])
        }
      } else if (sh.localName === 'FactTypeShape') {
        const f = factMap.get(subj), occ = f && nextOcc(subj)
        if (!occ) continue
        const label = f.objectified ? f.objectifiedName ?? f.id : (f.readingParts ?? []).filter(Boolean).join(' … ') || f.id
        const vertical = occ.orientation === 'vertical'
        // NORMA's role boxes: its shape less the margins (factBorder, or the
        // objectified margins along and across the roles) and half a pen all
        // round, less a band per level of bars on the bars' side.
        const along = f.objectified ? px(NORMA.objectified.marginX) : px(NORMA.factBorder)
        const across = f.objectified ? px(NORMA.objectified.marginY) : px(NORMA.factBorder)
        const size = vertical ? N.r - N.l : N.b - N.t
        const levels = Math.max(0, Math.round((size - px(NORMA.roleBox.height) - 2 * across - PEN) / BAND))
        const a = along + PEN / 2, c = across + PEN / 2, lv = levels * BAND
        // bars above a horizontal fact type (below with uniquenessBelow), right of a vertical one (left)
        const below = !!occ.uniquenessBelow
        const NR = vertical ? inset(N, c + (below ? lv : 0), a, c + (below ? 0 : lv), a) : inset(N, a, c + (below ? 0 : lv), a, c + (below ? lv : 0))
        const roles = drawn('roles', occ.id)[0]
        const kind = f.objectified ? 'objectified fact type' : `fact type (${f.arity === 1 ? 'unary' : f.arity === 2 ? 'binary' : 'n-ary'})`
        if (f.objectified) add('objectified outline', label, N, drawn('outline', occ.id)[0])
        add(`${kind} roles`, label, NR, roles)
        // the bars: how many levels each draws, and how far the outermost bar's middle is from the role boxes
        if (roles) {
          const bars = drawn('bar', occ.id)
          const dist = bars.map(b => vertical ? (below ? roles.l - (b.l + b.r) / 2 : (b.l + b.r) / 2 - roles.r) : (below ? (b.t + b.b) / 2 - roles.b : roles.t - (b.t + b.b) / 2))
          const ours = [...new Set(dist.map(x => Math.round(x)))].filter(x => x > 0).sort((x, y) => x - y)
          if (levels || ours.length) pairs.push({ diagram: diag.name, diagramId: diag.id, kind: `${kind} bars`, label, bars: { normaLevels: levels, ourLevels: ours.length,
            normaOuter: levels ? (levels - 0.5) * BAND : 0, ourOuter: ours.length ? ours[ours.length - 1] : 0, ourFirst: ours[0] ?? 0 } })
        }
        for (const r of rel) {
          const R = rect(r)
          if (r.localName === 'ReadingShape') add('reading', label, R, drawn('reading', occ.id)[0])
          else if (r.localName === 'ValueConstraintShape') {
            const ri = f.roles.findIndex(x => x.id === rangeOwner(subjectOf(r)))
            if (ri >= 0) add('role value range', label, R, drawn('role-value-range', occ.id, `[data-role="${ri}"]`)[0])
          } else if (r.localName === 'RoleNameShape') {
            const ri = f.roles.findIndex(x => x.id === subjectOf(r))
            const el = ri >= 0 && document.querySelector(`[data-look="role-name"][data-key="${occ.id}-${ri}"]`)
            if (el) add('role name', `${label} [${f.roles[ri].roleName}]`, R, worldBox(el))
          } else if (r.localName === 'ObjectifiedFactTypeNameShape') add('objectified name', label, R, drawn('name', occ.id)[0])
        }
      } else if (sh.localName === 'ModelNoteShape') {
        const k = noteSeen.get(subj) ?? 0
        noteSeen.set(subj, k + 1)
        const n = diag.notes.find(x => x.id === (k ? `${subj}_${k}` : subj))
        if (n) add('note', (n.text ?? '').slice(0, 30).replace(/\s+/g, ' '), N, box(n.x, n.y, n.w, n.h))
      } else if (/ConstraintShape$/.test(sh.localName)) {
        const co = diag.constraintOccurrences.find(x => x.id === `cocc_${sh.getAttribute('id')}`)
        const c = co && conMap.get(co.schemaConstraintId)
        if (!c) continue
        const type = c.constraintType ?? c.type ?? 'constraint'
        const ring = /ring/i.test(type), freq = /frequency/i.test(type)
        let w = px(NORMA.externalConstraint.diameter), h = w
        if (ring) w = h = px(NORMA.ringConstraint.diameter)
        else if (freq) w = freqStadiumW(formatFrequencyRange(c.frequency) ?? '')
        add(ring ? 'ring constraint' : freq ? 'external frequency' : 'external constraint', c.name || type, N, box(co.x, co.y, w, h),
          freq ? { note: 'a pill, FreeFBM’s own shape' } : undefined)
      }
    }
  }
  return { pairs, diagrams, unsized }
}

// Draws NORMA's and FreeFBM's rectangles over the active diagram and returns nothing.
async function overlay(rects) {
  const { useOrmStore } = await import('/src/store/ormStore.js')
  const s = useOrmStore.getState()
  const t = `translate(${s.pan.x},${s.pan.y}) scale(${s.zoom})`
  const g0 = [...document.querySelectorAll('svg g')].find(g => g.getAttribute('transform') === t)
  if (!g0) return false
  document.getElementById('norma-look-overlay')?.remove()
  const NS = 'http://www.w3.org/2000/svg'
  const g = document.createElementNS(NS, 'g')
  g.id = 'norma-look-overlay'
  g.setAttribute('pointer-events', 'none')
  for (const { norma, ours } of rects) {
    for (const [b, col, dash] of [[ours, '#1f6feb', null], [norma, '#d62828', '3 2']]) {
      const r = document.createElementNS(NS, 'rect')
      r.setAttribute('x', b.l); r.setAttribute('y', b.t)
      r.setAttribute('width', Math.max(0, b.r - b.l)); r.setAttribute('height', Math.max(0, b.b - b.t))
      r.setAttribute('fill', 'none'); r.setAttribute('stroke', col); r.setAttribute('stroke-width', 0.8)
      r.setAttribute('vector-effect', 'non-scaling-stroke')
      if (dash) r.setAttribute('stroke-dasharray', dash)
      g.appendChild(r)
    }
  }
  g0.appendChild(g)
  return true
}

const r1 = (x) => Math.round(x * 10) / 10
const sizeOf = (b) => ({ w: b.r - b.l, h: b.b - b.t, cx: (b.l + b.r) / 2, cy: (b.t + b.b) / 2 })
function diff(p) {
  const n = sizeOf(p.norma), o = sizeOf(p.ours)
  return { dw: o.w - n.w, dh: o.h - n.h, dx: o.cx - n.cx, dy: o.cy - n.cy, nw: n.w, nh: n.h }
}
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
const sign = (x) => (x > 0 ? '+' : '') + r1(x)

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8')
  const name = path.basename(file).replace(/\.\w+$/, '')
  const { pairs: all, diagrams, unsized } = await page.evaluate(measure, { content, name })
  const pairs = all.filter(p => !only || p.diagram.includes(only))
  console.log(`\n${path.basename(file)}: ${pairs.length} shapes on ${diagrams.length} diagrams (FreeFBM − NORMA, px; tolerance ${tol} px)${unsized ? `; ${unsized} labels NORMA has not sized left out` : ''}`)
  console.log(`${'kind'.padEnd(28)} ${'n'.padStart(5)}  ${'mean dw'.padStart(8)} ${'mean dh'.padStart(8)}  ${'|dw|'.padStart(6)} ${'|dh|'.padStart(6)} ${'|dxy|'.padStart(6)}  ${'size>tol'.padStart(8)} ${'pos>tol'.padStart(8)}`)
  const kinds = [...new Set(pairs.filter(p => !p.bars).map(p => p.kind))].sort()
  for (const k of kinds) {
    const ps = pairs.filter(p => p.kind === k).map(p => ({ ...p, d: diff(p) }))
    const ds = ps.map(p => p.d)
    const sizeOff = ds.filter(d => Math.abs(d.dw) > tol || Math.abs(d.dh) > tol).length
    const posOff = ds.filter(d => Math.hypot(d.dx, d.dy) > tol).length
    console.log(`${k.padEnd(28)} ${String(ps.length).padStart(5)}  ${sign(mean(ds.map(d => d.dw))).padStart(8)} ${sign(mean(ds.map(d => d.dh))).padStart(8)}  ${String(r1(mean(ds.map(d => Math.abs(d.dw))))).padStart(6)} ${String(r1(mean(ds.map(d => Math.abs(d.dh))))).padStart(6)} ${String(r1(mean(ds.map(d => Math.hypot(d.dx, d.dy))))).padStart(6)}  ${String(sizeOff).padStart(8)} ${String(posOff).padStart(8)}${ps[0].note ? `  ${ps[0].note}` : ''}`)
    if (list) {
      const bad = (d) => Math.abs(d.dw) + Math.abs(d.dh) + Math.hypot(d.dx, d.dy)
      for (const p of [...ps].sort((a, b) => bad(b.d) - bad(a.d)).slice(0, list)) {
        const d = p.d
        if (bad(d) <= tol) break
        console.log(`    ${p.diagram.slice(0, 22).padEnd(22)} ${String(p.label).slice(0, 34).padEnd(34)} NORMA ${r1(d.nw)}×${r1(d.nh)}  dw ${sign(d.dw)} dh ${sign(d.dh)} dx ${sign(d.dx)} dy ${sign(d.dy)}`)
      }
    }
  }
  // Uniqueness bars: levels drawn, and the distance of the outermost bar's middle from the role boxes
  const barKinds = [...new Set(pairs.filter(p => p.bars).map(p => p.kind))].sort()
  if (barKinds.length) console.log(`\n${'bars'.padEnd(28)} ${'n'.padStart(5)}  ${'same levels'.padStart(11)} ${'more'.padStart(5)} ${'fewer'.padStart(5)}  ${'outer bar (same levels)'.padStart(24)}`)
  for (const k of barKinds) {
    const ps = pairs.filter(p => p.kind === k)
    const same = ps.filter(p => p.bars.ourLevels === p.bars.normaLevels)
    const outer = same.filter(p => p.bars.normaLevels).map(p => p.bars.ourOuter - p.bars.normaOuter)
    console.log(`${k.padEnd(28)} ${String(ps.length).padStart(5)}  ${String(same.length).padStart(11)} ${String(ps.filter(p => p.bars.ourLevels > p.bars.normaLevels).length).padStart(5)} ${String(ps.filter(p => p.bars.ourLevels < p.bars.normaLevels).length).padStart(5)}  ${`mean ${sign(mean(outer))}, max |${r1(Math.max(0, ...outer.map(Math.abs)))}|`.padStart(24)}`)
    if (list) {
      for (const p of ps.filter(p => p.bars.ourLevels !== p.bars.normaLevels).slice(0, list)) {
        const b = p.bars
        console.log(`    ${p.diagram.slice(0, 22).padEnd(22)} ${String(p.label).slice(0, 34).padEnd(34)} levels NORMA ${b.normaLevels}, FreeFBM ${b.ourLevels}; outer bar ${r1(b.normaOuter)} vs ${r1(b.ourOuter)}`)
      }
    }
  }
  if (shots) {
    for (const d of diagrams) {
      if (only && !d.name.includes(only)) continue
      const rects = all.filter(p => p.diagramId === d.id && p.norma).map(p => ({ norma: p.norma, ours: p.ours }))
      await page.evaluate(async (id) => {
        const { useOrmStore } = await import('/src/store/ormStore.js')
        const s = useOrmStore.getState()
        s.setImportLog(null)
        s.setShowMinimap(false)
        s.setActiveDiagram(id)
        const svg = document.querySelector('.canvas-bg')?.closest('svg')
        const r = svg?.getBoundingClientRect()
        s.fitToContent(r?.width || 1200, r?.height || 700)
      }, d.id)
      await page.waitForTimeout(300)
      await page.evaluate(overlay, rects)
      const el = await page.$('.canvas-bg')
      const svg = await el.evaluateHandle(e => e.closest('svg'))
      const safe = `${name}-${d.name}`.replace(/\+/g, 'p').replace(/[^\w.-]+/g, '_')
      await svg.asElement().screenshot({ path: path.join(shots, `${safe}.png`) })
    }
  }
}

await browser.close()
await server.close()
