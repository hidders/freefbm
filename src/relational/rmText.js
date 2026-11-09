// Constraints of a relational schema in table terms (RM schemas first-class,
// step 4): an English sentence for each key, NOT NULL, foreign key, CHECK and
// assertion of relationalView, and the population's violations of them as
// messages about rows. The ORM2 verbalisation (verbalisation/) stays for the
// logical view; these sentences are what the tables view shows.

// "a, b and c" in a language.
const AND = { en: 'and', nl: 'en', fr: 'et', it: 'e', es: 'y', pl: 'i' }
const listIn = (lang) => (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${AND[lang] ?? 'and'} ${xs.at(-1)}`)
const list = listIn('en')

// Column names of an object's columns.
const colNames = (view, ids) => (ids ?? []).map(id => view.objects.get(id)?.name ?? '?')
const tableName = (view, obj) => view.objects.get(obj.table)?.name ?? '?'

// The condition of a CHECK's SQL text.
const condOf = (sql) => (sql ?? '').replace(/^CHECK \(/, '').replace(/\)$/, '')

// The sentences per language. Each gets { t (table), cols, several, l (list),
// ref, refCols, same, c (a CHECK column), vals, cond }. Column and table
// names are used as they are, so the sentences avoid inflecting them.
const SENTENCES = {
  en: {
    notNull: (x) => `Each ${x.t} row has ${/^[aeiou]/i.test(x.cols[0]) ? 'an' : 'a'} ${x.cols[0]}.`,
    primaryKey: (x) => `Each ${x.t} row is identified by its ${x.l(x.cols)}: every row has ${x.several ? 'them' : 'one'}, and no two rows have the same ${x.several ? `combination of ${x.l(x.cols)}` : x.cols[0]}.`,
    unique: (x) => `No two ${x.t} rows have the same ${x.several ? `combination of ${x.l(x.cols)}` : x.cols[0]}${x.several ? ' (rows where one of them is NULL are not compared)' : ''}.`,
    fk1: (x) => `Each ${x.cols[0]} given in a ${x.t} row is the ${x.refCols[0]} of some ${x.ref} row.`,
    fkN: (x) => `For each ${x.t} row whose ${x.l(x.cols)} are ${x.cols.length === 2 ? 'both' : 'all'} given, some ${x.ref} row has the same ${x.same ? 'values' : `values as ${x.l(x.refCols)}`}.`,
    checkIn: (x) => `Each ${x.c} given in a ${x.t} row is one of ${x.vals}.`,
    check: (x) => `Each ${x.t} row satisfies ${x.cond}, unless a NULL in the row leaves that unknown.`,
  },
  nl: {
    notNull: (x) => `Elke rij van ${x.t} heeft een ${x.cols[0]}.`,
    primaryKey: (x) => `Elke rij van ${x.t} wordt geïdentificeerd door ${x.l(x.cols)}: ${x.several ? 'geen ervan is' : `${x.cols[0]} is nooit`} NULL, en geen twee rijen hebben dezelfde ${x.several ? `combinatie van ${x.l(x.cols)}` : x.cols[0]}.`,
    unique: (x) => `Geen twee rijen van ${x.t} hebben dezelfde ${x.several ? `combinatie van ${x.l(x.cols)}` : x.cols[0]}${x.several ? ' (rijen waarin een ervan NULL is, worden niet vergeleken)' : ''}.`,
    fk1: (x) => `Elke ${x.cols[0]} die in een rij van ${x.t} gegeven is, is de ${x.refCols[0]} van een rij van ${x.ref}.`,
    fkN: (x) => `Voor elke rij van ${x.t} waarin ${x.l(x.cols)} ${x.cols.length === 2 ? 'beide' : 'alle'} gegeven zijn, heeft een rij van ${x.ref} dezelfde ${x.same ? 'waarden' : `waarden als ${x.l(x.refCols)}`}.`,
    checkIn: (x) => `Elke ${x.c} die in een rij van ${x.t} gegeven is, is een van ${x.vals}.`,
    check: (x) => `Elke rij van ${x.t} voldoet aan ${x.cond}, tenzij een NULL in de rij dat onbepaald laat.`,
  },
  fr: {
    notNull: (x) => `Chaque ligne de ${x.t} a une valeur pour ${x.cols[0]}.`,
    primaryKey: (x) => `Chaque ligne de ${x.t} est identifiée par ${x.l(x.cols)} : ${x.several ? 'aucune de ces colonnes n’est' : `${x.cols[0]} n’est jamais`} NULL, et deux lignes n’ont jamais ${x.several ? `la même combinaison de ${x.l(x.cols)}` : `la même valeur de ${x.cols[0]}`}.`,
    unique: (x) => `Deux lignes de ${x.t} n’ont jamais ${x.several ? `la même combinaison de ${x.l(x.cols)}` : `la même valeur de ${x.cols[0]}`}${x.several ? ' (les lignes où l’une de ces colonnes est NULL ne sont pas comparées)' : ''}.`,
    fk1: (x) => `Chaque valeur de ${x.cols[0]} donnée dans une ligne de ${x.t} est la valeur de ${x.refCols[0]} d’une ligne de ${x.ref}.`,
    fkN: (x) => `Pour chaque ligne de ${x.t} dont les valeurs de ${x.l(x.cols)} sont données, une ligne de ${x.ref} a les mêmes valeurs${x.same ? '' : ` pour ${x.l(x.refCols)}`}.`,
    checkIn: (x) => `Chaque valeur de ${x.c} donnée dans une ligne de ${x.t} est l’une de ${x.vals}.`,
    check: (x) => `Chaque ligne de ${x.t} satisfait ${x.cond}, sauf si un NULL dans la ligne le rend indéterminé.`,
  },
  it: {
    notNull: (x) => `Ogni riga di ${x.t} ha un valore per ${x.cols[0]}.`,
    primaryKey: (x) => `Ogni riga di ${x.t} è identificata da ${x.l(x.cols)}: ${x.several ? 'nessuna di queste colonne è' : `${x.cols[0]} non è mai`} NULL, e due righe non hanno mai ${x.several ? `la stessa combinazione di ${x.l(x.cols)}` : `lo stesso valore di ${x.cols[0]}`}.`,
    unique: (x) => `Due righe di ${x.t} non hanno mai ${x.several ? `la stessa combinazione di ${x.l(x.cols)}` : `lo stesso valore di ${x.cols[0]}`}${x.several ? ' (le righe in cui una di queste colonne è NULL non vengono confrontate)' : ''}.`,
    fk1: (x) => `Ogni valore di ${x.cols[0]} dato in una riga di ${x.t} è il valore di ${x.refCols[0]} di una riga di ${x.ref}.`,
    fkN: (x) => `Per ogni riga di ${x.t} in cui i valori di ${x.l(x.cols)} sono dati, una riga di ${x.ref} ha gli stessi valori${x.same ? '' : ` per ${x.l(x.refCols)}`}.`,
    checkIn: (x) => `Ogni valore di ${x.c} dato in una riga di ${x.t} è uno tra ${x.vals}.`,
    check: (x) => `Ogni riga di ${x.t} soddisfa ${x.cond}, a meno che un NULL nella riga lo renda indeterminato.`,
  },
  es: {
    notNull: (x) => `Cada fila de ${x.t} tiene un valor para ${x.cols[0]}.`,
    primaryKey: (x) => `Cada fila de ${x.t} se identifica por ${x.l(x.cols)}: ${x.several ? 'ninguna de estas columnas es' : `${x.cols[0]} nunca es`} NULL, y dos filas nunca tienen ${x.several ? `la misma combinación de ${x.l(x.cols)}` : `el mismo valor de ${x.cols[0]}`}.`,
    unique: (x) => `Dos filas de ${x.t} nunca tienen ${x.several ? `la misma combinación de ${x.l(x.cols)}` : `el mismo valor de ${x.cols[0]}`}${x.several ? ' (las filas en las que una de estas columnas es NULL no se comparan)' : ''}.`,
    fk1: (x) => `Cada valor de ${x.cols[0]} dado en una fila de ${x.t} es el valor de ${x.refCols[0]} de alguna fila de ${x.ref}.`,
    fkN: (x) => `Para cada fila de ${x.t} en la que se dan los valores de ${x.l(x.cols)}, alguna fila de ${x.ref} tiene los mismos valores${x.same ? '' : ` en ${x.l(x.refCols)}`}.`,
    checkIn: (x) => `Cada valor de ${x.c} dado en una fila de ${x.t} es uno de ${x.vals}.`,
    check: (x) => `Cada fila de ${x.t} cumple ${x.cond}, salvo que un NULL en la fila lo deje indeterminado.`,
  },
  pl: {
    notNull: (x) => `Każdy wiersz tabeli ${x.t} ma wartość w kolumnie ${x.cols[0]}.`,
    primaryKey: (x) => `Każdy wiersz tabeli ${x.t} jest identyfikowany przez ${x.several ? 'kolumny' : 'kolumnę'} ${x.l(x.cols)}: ${x.several ? 'żadna z nich nie ma' : 'nie ma ona nigdy'} wartości NULL, a żadne dwa wiersze nie mają ${x.several ? `tej samej kombinacji wartości ${x.l(x.cols)}` : `tej samej wartości ${x.cols[0]}`}.`,
    unique: (x) => `Żadne dwa wiersze tabeli ${x.t} nie mają ${x.several ? `tej samej kombinacji wartości ${x.l(x.cols)}` : `tej samej wartości ${x.cols[0]}`}${x.several ? ' (wiersze, w których któraś z tych kolumn ma wartość NULL, nie są porównywane)' : ''}.`,
    fk1: (x) => `Każda wartość kolumny ${x.cols[0]} podana w wierszu tabeli ${x.t} jest wartością kolumny ${x.refCols[0]} jakiegoś wiersza tabeli ${x.ref}.`,
    fkN: (x) => `Dla każdego wiersza tabeli ${x.t}, w którym podane są wartości ${x.l(x.cols)}, jakiś wiersz tabeli ${x.ref} ma te same wartości${x.same ? '' : ` w kolumnach ${x.l(x.refCols)}`}.`,
    checkIn: (x) => `Każda wartość kolumny ${x.c} podana w wierszu tabeli ${x.t} jest jedną z ${x.vals}.`,
    check: (x) => `Każdy wiersz tabeli ${x.t} spełnia ${x.cond}, chyba że wartość NULL w wierszu czyni to nieokreślonym.`,
  },
}
export const RM_SENTENCE_LANGUAGES = Object.keys(SENTENCES)

// One sentence for an object (kind notNull, primaryKey, unique, foreignKey,
// check, assertion), or null, in a language (en, nl, fr, it, es, pl; English
// for any other). sentence: the assertion's ORM2 sentence, if any.
export function rmSentence(view, obj, { sentence = null, lang = 'en' } = {}) {
  const S = SENTENCES[lang] ?? SENTENCES.en
  const cols = colNames(view, obj.columns)
  const x = { t: tableName(view, obj), cols, several: cols.length > 1, l: listIn(lang) }
  switch (obj.kind) {
    case 'notNull': return S.notNull(x)
    case 'primaryKey': return S.primaryKey(x)
    case 'unique': return S.unique(x)
    case 'foreignKey': {
      x.ref = view.objects.get(obj.refTable)?.name ?? '?'
      x.refCols = colNames(view, obj.refColumns)
      x.same = cols.join() === x.refCols.join()
      return x.several ? S.fkN(x) : S.fk1(x)
    }
    case 'check': {
      x.cond = condOf(obj.sql)
      const m = x.cond.match(/^"?([A-Za-z_][\w$]*)"? IN \((.*)\)$/)
      if (m) { x.c = m[1]; x.vals = m[2]; return S.checkIn(x) }
      return S.check(x)
    }
    case 'assertion':
      return sentence ?? null
    default:
      return null
  }
}

// The population's violations of each object: Map(rmId → [message]).
// issues: store.populationIssues. A row is named by its key (the entity
// instance: one value, or a list of values).
export function rmViolations(view, issues) {
  const out = new Map()
  const push = (rmId, text) => { if (!out.has(rmId)) out.set(rmId, []); out.get(rmId).push(text) }
  const show = (v) => (Array.isArray(v) ? `(${v.map(show).join(', ')})` : v == null ? 'NULL' : String(v))
  const objOf = (ormId, kinds) => (view.ofOrm.get(ormId) ?? []).map(id => view.objects.get(id)).find(o => o && kinds.includes(o.kind))
  // The key object over exactly this column.
  const keyOver = (factId) => [...view.objects.values()].find(o => (o.kind === 'primaryKey' || o.kind === 'unique')
    && o.columns?.length === 1 && (o.columns[0] === `col:${factId}` || o.columns[0] === `bcol:${factId}`))
  for (const i of issues ?? []) {
    if (i.kind === 'mandatoryRoleNotPlayed' && i.factId) {
      const o = view.objects.get(`nn:${i.factId}`)
      if (o) { push(o.rmId, `The ${tableName(view, o)} row ${show(i.value)} has no ${colNames(view, o.columns)[0]}.`); continue }
    }
    if (i.kind === 'uniquenessViolation') {
      const o = i.factId ? keyOver(i.factId) : objOf(i.constraintId ?? i.elementId, ['primaryKey', 'unique'])
      if (o) {
        const v = i.values ? (i.values.length === 1 ? i.values[0] : i.values) : i.value
        push(o.rmId, `Several ${tableName(view, o)} rows have ${list(colNames(view, o.columns))} = ${show(v)}.`)
        continue
      }
    }
    if (i.kind === 'subsetViolation') {
      const o = objOf(i.constraintId ?? i.elementId, ['foreignKey'])
      if (o) {
        const ref = view.objects.get(o.refTable)?.name ?? '?'
        push(o.rmId, `A ${tableName(view, o)} row has ${list(colNames(view, o.columns))} = ${show(i.value)}, which no ${ref} row has.`)
        continue
      }
    }
    // Others (CHECKs, assertions): their own message, under the object.
    const o = objOf(i.constraintId ?? i.elementId, ['check', 'assertion', 'primaryKey', 'unique', 'foreignKey', 'notNull'])
    if (o) push(o.rmId, i.message)
  }
  return out
}

// The RM object the selection is (selectRm's choice, else the first object
// the selected ORM2 element stands for), or null.
export function selectedRmObject(state, view) {
  if (!state.selectedId) return null
  return (state.selectedRm?.id === state.selectedId ? view.objects.get(state.selectedRm.rmId) : null)
    ?? view.ofOrm.get(state.selectedId)?.map(id => view.objects.get(id)).find(Boolean) ?? null
}

// The table (entity id) the selection is about: a table, view or stored
// part, a part of one (column, key, CHECK), or its entity type; or null.
export function selectedTableId(state, view) {
  const obj = selectedRmObject(state, view)
  const tbl = obj && (obj.kind === 'table' || obj.kind === 'view' ? obj : view.objects.get(obj.table))
  return tbl?.entityId ?? null
}
