// The named transformations that apply to a table, one of its columns or one
// of its foreign keys, each as { key, label, detail, kind, params } for the
// Transform dialog (store.transformDialog { schemaId, kind, params }). Used by
// the relational Inspector and the ERD's context menus.
import { sideContext } from '../mapping/mapping.js'
import { TRANSFORMATIONS } from '../mapping/transformations.js'

// tableId: the table's entity type; colId: a column's fact type; fkColIds: the
// columns of a foreign key of the table (only transformations about exactly
// those columns).
export function transformItems(state, schemaId, tableId, { colId = null, fkColIds = null } = {}) {
  let ctx
  try { ctx = sideContext(state, schemaId) } catch { return [] }
  const t = ctx.tableById?.get(tableId)
  if (!t) return []
  const sameCols = (ids) => fkColIds && ids?.length === fkColIds.length && ids.every(id => fkColIds.includes(id))
  const out = []
  for (const tr of TRANSFORMATIONS.filter(x => x.profile === 'relational')) {
    if (tr.options) {
      let opts = []
      try { opts = tr.options(ctx) } catch { opts = [] }
      for (const o of opts) {
        const p = o.params ?? {}
        const onTable = p.tableId === tableId || (p.tableIds ?? []).includes(tableId)
        const onPart = fkColIds ? sameCols(p.columnIds)
          : colId ? (p.columnId === colId || (p.columnIds ?? []).includes(colId) || (p.keyIds ?? []).includes(colId)) : true
        if (onTable && onPart) out.push({ key: `${tr.id}|${o.key}`, label: tr.label, detail: o.label, kind: tr.id, params: { optionKey: o.key } })
      }
    } else if (fkColIds) {
      continue
    } else if (tr.id === 'split' && !colId && t.pk?.length && t.columns.some(c => !c.pk)) {
      out.push({ key: 'split', label: tr.label, kind: 'split', params: { tableId } })
    } else if (tr.id === 'split' && colId && t.pk?.length && !t.columns.find(c => c.fact.id === colId)?.pk) {
      const c = t.columns.find(x => x.fact.id === colId)
      out.push({ key: 'split', label: tr.label, detail: `move ${c?.name ?? 'this column'}`, kind: 'split', params: { tableId, columnIds: [colId] } })
    } else if (tr.id === 'absorb' && !colId && tr.targets(ctx, tableId).length) {
      out.push({ key: 'absorb', label: tr.label, detail: `into ${tr.targets(ctx, tableId).map(x => x.name).join(' or ')}`, kind: 'absorb', params: { fromId: tableId } })
    }
  }
  return out
}
