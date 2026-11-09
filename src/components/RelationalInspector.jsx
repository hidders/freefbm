// The Inspector for a relational schema showing its tables (relational/face.js):
// tables, views, columns, keys, foreign keys, CHECKs and assertions as
// relationalView.js reads them, read-only, with the named transformations
// that apply to the selected table or column (they open the Transform dialog
// with it filled in).

import React, { useMemo } from 'react'
import { useOrmStore } from '../store/ormStore'
import { relationalView, rmObjectOf } from '../relational/relationalView.js'
import { exportPostgresDdl } from '../relational/ddlExport.js'
import { planEnforcement, sqlSettings, targetOf } from '../relational/enforcement.js'
import { quoteIdent } from '../relational/sqlNames.js'
import { transformItems } from '../relational/transformItems.js'
import { assertionShapes, ASSERTION_KINDS } from '../relational/erdAssertions.js'

const KIND_TITLE = {
  table: 'Table', view: 'View', column: 'Column', notNull: 'NOT NULL', primaryKey: 'Primary key',
  unique: 'UNIQUE', foreignKey: 'Foreign key', check: 'CHECK', assertion: 'Assertion',
}

// The object the Inspector shows: the one picked in the browser (store.selectedRm)
// while its element stays selected, else the one the selected element stands in.
export function selectedRmObject(state, schemaId) {
  if (!state.selectedId) return null
  const view = relationalView(state, schemaId)
  const picked = state.selectedRm?.id === state.selectedId ? view.objects.get(state.selectedRm.rmId) : null
  return picked ?? rmObjectOf(view, state.selectedId)
}

export default function RelationalInspector({ schemaId, obj, tableRules }) {
  const state = useOrmStore.getState()
  const view = relationalView(state, schemaId)
  const objectTypes = useOrmStore(s => s.objectTypes)
  const facts = useOrmStore(s => s.facts)
  const constraints = useOrmStore(s => s.constraints)
  const ddl = useMemo(() => {
    try { return exportPostgresDdl(useOrmStore.getState(), schemaId).sql } catch { return '' }
  }, [objectTypes, facts, constraints, schemaId])
  const get = (id) => view.objects.get(id)
  const link = (o, text) => o ? (
    <span className="rm-link" onClick={() => useOrmStore.getState().selectRm(o)}
      style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border)' }}>{text ?? o.name ?? o.label}</span>
  ) : null
  const table = obj.kind === 'table' || obj.kind === 'view' ? obj : get(obj.table)

  return (
    <div className="relational-inspector" style={{ marginBottom: 18, fontSize: 12 }}>
      <div style={{ fontSize: 10, color: 'var(--col-schema-relational)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 2 }}>
        {obj.kind === 'table' && obj.of ? 'Stored table' : KIND_TITLE[obj.kind] ?? obj.kind}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--ink)', borderBottom: '1px solid var(--border)', paddingBottom: 6, marginBottom: 10, wordBreak: 'break-word' }}>
        {obj.kind === 'column' ? <>{link(table)}.{obj.name}</> : obj.name ?? obj.label}
      </div>
      {(obj.kind === 'table' || obj.kind === 'view') && <TableBody t={obj} view={view} link={link} />}
      {obj.kind === 'column' && <ColumnBody c={obj} view={view} link={link} />}
      {!['table', 'view', 'column'].includes(obj.kind) && <ConstraintBody o={obj} view={view} link={link} schemaId={schemaId} />}
      {!obj.enforced && obj.kind !== 'assertion' && (
        <Note>Not checked by the PostgreSQL DDL export, as it is about a view or a derived column (the export says so).</Note>
      )}
      {(obj.kind === 'table' || obj.kind === 'view' || obj.kind === 'column') && <Transformations schemaId={schemaId} obj={obj} table={table} />}
      {(obj.kind === 'table' || obj.kind === 'view') && !obj.of && tableRules}
      {(obj.kind === 'table' || obj.kind === 'view') && <Sql text={tableSql(ddl, obj, view)} title="SQL" />}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
        borderBottom: '1px solid var(--border-soft)', paddingBottom: 3, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  )
}
const Note = ({ children }) => <div style={{ color: 'var(--ink-3)', margin: '6px 0 10px', lineHeight: 1.4 }}>{children}</div>
const Line = ({ children, muted }) => <div style={{ margin: '2px 0', lineHeight: 1.4, color: muted ? 'var(--ink-3)' : 'var(--ink-1)', wordBreak: 'break-word' }}>{children}</div>
const Code = ({ children }) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{children}</span>

function Sql({ text, title }) {
  if (!text) return null
  return (
    <Section title={title}>
      <pre className="copyable" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: 'var(--bg-raised)', border: '1px solid var(--border-soft)', borderRadius: 4, padding: 6, margin: 0, userSelect: 'text' }}>{text}</pre>
    </Section>
  )
}

function TableBody({ t, view, link }) {
  const cols = t.columns.map(id => view.objects.get(id))
  const keys = t.keys.map(id => view.objects.get(id)).filter(k => k.kind !== 'notNull')
  const holder = t.base ? view.objects.get(t.base) : t
  const refs = [...view.objects.values()].filter(o => o.kind === 'foreignKey' && o.refTable === holder.rmId)
  const of = t.of ? view.objects.get(t.of) : null
  // The SQL schema (namespace) the imported script put it in.
  const ns = useOrmStore.getState().objectTypes.find(o => o.sqlSchema && (t.members ?? []).includes(o.id))?.sqlSchema
  return <>
    {ns && <Line>In SQL schema <Code>{ns}</Code></Line>}
    {of && <Note>The stored part of the view {link(of)}: its rows and the columns the view does not derive.</Note>}
    {t.kind === 'view' && (
      <Note>
        {t.derived === 'rows' ? 'Its rows are derived by a rule, so it is written as a view.' : 'Some of its columns are derived by a rule, so it is written as a view'}
        {t.base && <> over its stored part {link(view.objects.get(t.base))}</>}.
        {t.error && <> Its rules have no SQL form yet ({t.error}), so the export writes it as a table.</>}
      </Note>
    )}
    <Section title={`Columns (${cols.length})`}>
      {cols.map(c => (
        <Line key={c.rmId}>
          {link(c)} <Code>{c.type ?? '?'}</Code>
          <span style={{ color: 'var(--ink-3)' }}>{[c.pk && ' PK', c.fk && ' FK', c.notNull && !c.pk && ' NOT NULL', c.derived && ` ${c.derived === 'derived' ? 'derived' : 'semi-derived'}`].filter(Boolean).join(',')}</span>
        </Line>
      ))}
    </Section>
    {t.base && <Note>Its keys and foreign keys are on {link(view.objects.get(t.base))}.</Note>}
    {keys.length > 0 && (
      <Section title="Keys and constraints">
        {keys.map(k => <Line key={k.rmId}>{link(k, k.label)} <Code>{k.kind === 'foreignKey' ? `→ ${view.objects.get(k.refTable)?.name}` : k.sql}</Code></Line>)}
      </Section>
    )}
    {refs.length > 0 && (
      <Section title="Referenced by">
        {refs.map(k => <Line key={k.rmId}>{link(view.objects.get(k.table))} {link(k, k.name)}</Line>)}
      </Section>
    )}
  </>
}

function ColumnBody({ c, view, link }) {
  const table = view.objects.get(c.table)
  const holder = table?.base ? view.objects.get(table.base) : table
  const own = c.of ?? c.rmId
  const inKeys = [...(holder?.keys ?? [])].map(id => view.objects.get(id))
    .filter(k => k.kind !== 'notNull' && (k.columns ?? []).some(x => x === c.rmId || x === `bcol:${c.factId}` || x === own))
  const refs = [...view.objects.values()].filter(o => o.kind === 'foreignKey' && (o.refColumns ?? []).some(x => x === c.rmId || x === `bcol:${c.factId}`))
  return <>
    <Section title="Column">
      <Line>Type <Code>{c.type ?? 'none set'}</Code></Line>
      <Line>{c.notNull ? 'NOT NULL' : 'May be NULL'}</Line>
      {c.generated && <Line>Generated: {c.generated}</Line>}
      {c.derived && <Line>{c.derived === 'derived' ? 'Derived by a table rule' : 'Semi-derived: the stored value, else the rule\'s'}</Line>}
    </Section>
    {inKeys.length > 0 && (
      <Section title="In">
        {inKeys.map(k => <Line key={k.rmId}>{link(k, k.label)} <Code>{k.kind === 'foreignKey' ? `→ ${view.objects.get(k.refTable)?.name}` : k.sql}</Code></Line>)}
      </Section>
    )}
    {refs.length > 0 && (
      <Section title="Referenced by">
        {refs.map(k => <Line key={k.rmId}>{link(view.objects.get(k.table))} {link(k, k.name)}</Line>)}
      </Section>
    )}
  </>
}

function ConstraintBody({ o, view, link, schemaId }) {
  const cols = (o.columns ?? []).map(id => view.objects.get(id)).filter(Boolean)
  return <>
    {o.table && <Line>On {link(view.objects.get(o.table))}{cols.length > 0 && <> ({cols.map((c, i) => <React.Fragment key={c.rmId}>{i ? ', ' : ''}{link(c)}</React.Fragment>)})</>}</Line>}
    {o.kind === 'foreignKey' && (
      <Line>References {link(view.objects.get(o.refTable))} ({(o.refColumns ?? []).map((id, i) => {
        const c = view.objects.get(id)
        return <React.Fragment key={id}>{i ? ', ' : ''}{link(c)}</React.Fragment>
      })})</Line>
    )}
    {o.kind !== 'assertion' && o.sql && <Sql text={o.sql} title="SQL" />}
    {o.kind === 'assertion' && <AssertionAbout o={o} view={view} link={link} />}
    {o.kind === 'assertion' && <>
      <Note>{o.query ? <EnforcedAs o={o} schemaId={schemaId} /> : `It has no SQL form${o.error ? `: ${o.error}` : ''}.`}</Note>
      {o.formula && <Sql text={o.formula} title="Formula" />}
      {o.query && <Sql text={`${o.query};`} title="Violations" />}
    </>}
  </>
}

// How the schema's SQL target enforces an assertion (relational/enforcement.js).
function EnforcedAs({ o, schemaId }) {
  const state = useOrmStore.getState()
  const schemas = useOrmStore(s => s.schemas)
  const item = useMemo(() => {
    try { return planEnforcement(state, schemaId).items.find(x => x.rmId === o.rmId) ?? null } catch { return null }
  }, [o, schemaId, schemas])   // eslint-disable-line react-hooks/exhaustive-deps
  const target = targetOf(sqlSettings(schemas.find(x => x.id === schemaId)).target).name
  const lead = 'A constraint with no table form. Many SQL databases do not support assertions'
  if (!item) return `${lead}.`
  if (item.technique === 'foreignKey' && item.entry?.fk?.existing) return `${lead}, but this one says ${item.note}, which enforces it.`
  if (item.technique === 'foreignKey') return `${lead}, but this one is a foreign key: the ${target} DDL export writes it as FOREIGN KEY ${item.note}.`
  if (item.technique === 'trigger') return `${lead}, so the ${target} DDL export enforces it with a trigger that runs the query below${item.note ? ` (${item.note})` : ''}.`
  return `${lead}. The ${target} DDL export writes the query below as an audit query (not enforced)${item.note ? `: ${item.note}` : ''}.`
}

// What an assertion checks (the kind its formula has the shape of), the
// tables it constrains and refers to (relational/erdAssertions.js), and where
// it comes from.
function AssertionAbout({ o, view, link }) {
  const shape = assertionShapes(view).find(s => s.rmId === o.rmId)
  const st = useOrmStore.getState()
  const c = st.constraints.find(x => x.id === o.members[0])
  const tableLinks = (role) => (shape?.tables ?? []).filter(t => t.role === role).map(t => view.objects.get(`table:${t.id}`)).filter(Boolean)
  const list = (ts) => ts.map((t, i) => <React.Fragment key={t.rmId}>{i ? ', ' : ''}{link(t)}</React.Fragment>)
  const constrained = tableLinks('constrained'), referenced = tableLinks('referenced')
  const from = c?.carriedFrom
  const fromSchema = from && st.schemas?.find(x => x.id === from.schemaId)
  const fromMapping = from && st.mappings?.find(m => m.id === from.mappingId)
  return <>
    {shape && <Line>Kind: {ASSERTION_KINDS[shape.kind] ?? shape.kind}</Line>}
    {constrained.length > 0 && <Line>Constrains {list(constrained)}</Line>}
    {referenced.length > 0 && <Line>Refers to {list(referenced)}</Line>}
    <Section title="Origin">
      {from
        ? <Line>Carried from {from.text ? <Code>{from.text}</Code> : 'a constraint'}{fromSchema ? <> of {fromSchema.name}</> : null}{fromMapping ? <> through the mapping {fromMapping.name}</> : null}</Line>
        : c?.sqlSource?.kind === 'assertion' ? <Line>Read from the CREATE ASSERTION of an imported script: <Code>CHECK ({c.sqlSource.text})</Code></Line>
        : c?.sqlSource?.kind === 'check' ? <Line>Read from a CHECK of {c.sqlSource.table} in an imported script that reads other tables: <Code>CHECK ({c.sqlSource.text})</Code></Line>
        : c?.sqlCheck ? <Line>Read from the CHECK <Code>{c.sqlCheck.text}</Code> of an imported script</Line>
        : <Line muted>Not recorded: added in this schema, or carried before origins were kept</Line>}
    </Section>
  </>
}

// The named transformations that apply to a table or column, each opening the
// Transform dialog with it filled in (store.transformDialog { schemaId, kind, params }).
function Transformations({ schemaId, obj, table }) {
  const facts = useOrmStore(s => s.facts)
  const constraints = useOrmStore(s => s.constraints)
  const objectTypes = useOrmStore(s => s.objectTypes)
  const items = useMemo(() => transformItems(useOrmStore.getState(), schemaId, table?.entityId,
    { colId: obj.kind === 'column' ? obj.factId : null }), [facts, constraints, objectTypes, schemaId, obj.rmId, table?.rmId])
  if (!items.length) return null
  return (
    <Section title="Transform">
      {items.map(x => (
        <div key={x.key} className="rm-transform" onClick={() => useOrmStore.setState({ transformDialog: { schemaId, kind: x.kind, params: x.params } })}
          style={{ cursor: 'pointer', margin: '3px 0', lineHeight: 1.35 }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--accent)' }}
          onMouseLeave={e => { e.currentTarget.style.color = '' }}>
          {x.label}{x.detail && <span style={{ color: 'var(--ink-3)' }}> · {x.detail}</span>}…
        </div>
      ))}
    </Section>
  )
}

// The statements of the DDL export about a table: its CREATE TABLE (or
// CREATE VIEW, and its base table's), and the foreign keys from it.
function tableSql(ddl, t, view) {
  if (!ddl) return ''
  const names = [t.name, ...(t.base ? [view.objects.get(t.base).name] : [])].map(quoteIdent)
  const starts = (line) => names.some(n => line === `CREATE TABLE ${n} (` || line.startsWith(`CREATE VIEW ${n} AS`) || line.startsWith(`ALTER TABLE ${n} ADD`))
  const out = []
  let cur = null
  for (const line of ddl.split('\n')) {
    if (!cur && starts(line)) cur = []
    if (!cur) continue
    cur.push(line)
    if (line.trimEnd().endsWith(';')) { out.push(cur.join('\n')); cur = null }
  }
  return out.join('\n')
}
