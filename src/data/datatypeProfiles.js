// Built-in datatype profiles.
// Each profile is a named family of datatypes for a specific target platform.

export const PROFILES = [
  {
    id: 'abstract',
    name: 'Abstract',
    datatypes: [
      { id: 'text',     name: 'text',     params: [] },
      { id: 'integer',  name: 'integer',  params: [] },
      { id: 'decimal',  name: 'decimal',  params: [] },
      { id: 'boolean',  name: 'boolean',  params: [] },
      { id: 'date',     name: 'date',     params: [] },
      { id: 'datetime', name: 'datetime', params: [] },
    ],
  },
  {
    id: 'sql2016',
    name: 'SQL:2016',
    datatypes: [
      { id: 'CHAR',             name: 'CHAR',             params: [{ name: 'length',    type: 'integer', optional: true,  default: 1 }] },
      { id: 'VARCHAR',          name: 'VARCHAR',          params: [{ name: 'length',    type: 'integer', optional: false }] },
      { id: 'INTEGER',          name: 'INTEGER',          params: [] },
      { id: 'SMALLINT',         name: 'SMALLINT',         params: [] },
      { id: 'BIGINT',           name: 'BIGINT',           params: [] },
      { id: 'NUMERIC',          name: 'NUMERIC',          params: [
          { name: 'precision', type: 'integer', optional: true },
          { name: 'scale',     type: 'integer', optional: true },
        ] },
      { id: 'REAL',             name: 'REAL',             params: [] },
      { id: 'DOUBLE PRECISION', name: 'DOUBLE PRECISION', params: [] },
      { id: 'BOOLEAN',          name: 'BOOLEAN',          params: [] },
      { id: 'DATE',             name: 'DATE',             params: [] },
      { id: 'TIME',             name: 'TIME',             params: [] },
      { id: 'TIMESTAMP',        name: 'TIMESTAMP',        params: [] },
      { id: 'BLOB',             name: 'BLOB',             params: [] },
    ],
  },
  {
    id: 'xmlschema',
    name: 'XML Schema',
    datatypes: [
      // String
      { id: 'xs:string',           name: 'xs:string',           params: [] },
      { id: 'xs:normalizedString', name: 'xs:normalizedString', params: [] },
      { id: 'xs:token',            name: 'xs:token',            params: [] },
      { id: 'xs:language',         name: 'xs:language',         params: [] },
      { id: 'xs:anyURI',           name: 'xs:anyURI',           params: [] },
      { id: 'xs:ID',               name: 'xs:ID',               params: [] },
      { id: 'xs:IDREF',            name: 'xs:IDREF',            params: [] },
      { id: 'xs:NMTOKEN',          name: 'xs:NMTOKEN',          params: [] },
      // Numeric
      { id: 'xs:decimal',          name: 'xs:decimal',          params: [
          { name: 'totalDigits',    type: 'integer', optional: true },
          { name: 'fractionDigits', type: 'integer', optional: true },
        ] },
      { id: 'xs:integer',          name: 'xs:integer',          params: [] },
      { id: 'xs:long',             name: 'xs:long',             params: [] },
      { id: 'xs:int',              name: 'xs:int',              params: [] },
      { id: 'xs:short',            name: 'xs:short',            params: [] },
      { id: 'xs:byte',             name: 'xs:byte',             params: [] },
      { id: 'xs:nonNegativeInteger', name: 'xs:nonNegativeInteger', params: [] },
      { id: 'xs:positiveInteger',  name: 'xs:positiveInteger',  params: [] },
      { id: 'xs:float',            name: 'xs:float',            params: [] },
      { id: 'xs:double',           name: 'xs:double',           params: [] },
      // Boolean
      { id: 'xs:boolean',          name: 'xs:boolean',          params: [] },
      // Date / time
      { id: 'xs:dateTime',         name: 'xs:dateTime',         params: [] },
      { id: 'xs:date',             name: 'xs:date',             params: [] },
      { id: 'xs:time',             name: 'xs:time',             params: [] },
      { id: 'xs:duration',         name: 'xs:duration',         params: [] },
      { id: 'xs:gYear',            name: 'xs:gYear',            params: [] },
      { id: 'xs:gYearMonth',       name: 'xs:gYearMonth',       params: [] },
      { id: 'xs:gMonth',           name: 'xs:gMonth',           params: [] },
      // Binary
      { id: 'xs:base64Binary',     name: 'xs:base64Binary',     params: [] },
      { id: 'xs:hexBinary',        name: 'xs:hexBinary',        params: [] },
    ],
  },
  {
    id: 'typescript',
    name: 'TypeScript',
    datatypes: [
      { id: 'string',  name: 'string',  params: [] },
      { id: 'number',  name: 'number',  params: [] },
      { id: 'bigint',  name: 'bigint',  params: [] },
      { id: 'boolean', name: 'boolean', params: [] },
      { id: 'Date',    name: 'Date',    params: [] },
      { id: 'Buffer',  name: 'Buffer',  params: [] },
    ],
  },
]

export const PROFILE_MAP = Object.fromEntries(PROFILES.map(p => [p.id, p]))

/** Returns the Datatype object for the given profile and datatype id, or null. */
export function getDatatypeById(profileId, datatypeId) {
  return PROFILE_MAP[profileId]?.datatypes.find(d => d.id === datatypeId) ?? null
}

/** Returns a display string for a datatype assignment, e.g. "VARCHAR(255)" or "NUMERIC(10, 2)". */
export function formatDatatype(profileId, datatypeId, params) {
  const dt = getDatatypeById(profileId, datatypeId)
  if (!dt) return datatypeId
  if (!dt.params.length) return dt.name
  const paramValues = dt.params
    .map(p => params?.[p.name] ?? '')
    .filter(v => v !== '' && v !== null && v !== undefined)
  return paramValues.length ? `${dt.name}(${paramValues.join(', ')})` : dt.name
}
