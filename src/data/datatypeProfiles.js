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
      // Character
      { id: 'CHAR',             name: 'CHAR',             params: [{ name: 'length',    type: 'integer', optional: true,  default: 1 }] },
      { id: 'VARCHAR',          name: 'VARCHAR',          params: [{ name: 'length',    type: 'integer', optional: true }] },
      { id: 'CLOB',             name: 'CLOB',             params: [] },
      { id: 'NCHAR',            name: 'NCHAR',            params: [{ name: 'length',    type: 'integer', optional: true,  default: 1 }] },
      { id: 'NVARCHAR',         name: 'NVARCHAR',         params: [{ name: 'length',    type: 'integer', optional: true }] },
      { id: 'NCLOB',            name: 'NCLOB',            params: [] },
      // Binary
      { id: 'BINARY',           name: 'BINARY',           params: [{ name: 'length',    type: 'integer', optional: true,  default: 1 }] },
      { id: 'VARBINARY',        name: 'VARBINARY',        params: [{ name: 'length',    type: 'integer', optional: true }] },
      { id: 'BLOB',             name: 'BLOB',             params: [] },
      // Numeric (exact)
      { id: 'NUMERIC',          name: 'NUMERIC',          params: [
          { name: 'precision', type: 'integer', optional: true },
          { name: 'scale',     type: 'integer', optional: true },
        ] },
      { id: 'DECIMAL',          name: 'DECIMAL',          params: [
          { name: 'precision', type: 'integer', optional: true },
          { name: 'scale',     type: 'integer', optional: true },
        ] },
      { id: 'INTEGER',          name: 'INTEGER',          params: [] },
      { id: 'SMALLINT',         name: 'SMALLINT',         params: [] },
      { id: 'BIGINT',           name: 'BIGINT',           params: [] },
      // Numeric (approximate)
      { id: 'FLOAT',            name: 'FLOAT',            params: [{ name: 'precision', type: 'integer', optional: true }] },
      { id: 'REAL',             name: 'REAL',             params: [] },
      { id: 'DOUBLE PRECISION', name: 'DOUBLE PRECISION', params: [] },
      { id: 'DECFLOAT',         name: 'DECFLOAT',         params: [{ name: 'precision', type: 'integer', optional: true,  default: 34 }] },
      // Boolean
      { id: 'BOOLEAN',          name: 'BOOLEAN',          params: [] },
      // Datetime
      { id: 'DATE',             name: 'DATE',             params: [] },
      { id: 'TIME',             name: 'TIME',             params: [{ name: 'precision', type: 'integer', optional: true }, { name: 'withTimeZone', type: 'boolean', optional: true }] },
      { id: 'TIMESTAMP',        name: 'TIMESTAMP',        params: [{ name: 'precision', type: 'integer', optional: true }, { name: 'withTimeZone', type: 'boolean', optional: true }] },
      { id: 'INTERVAL',         name: 'INTERVAL',         params: [{ name: 'startField', type: 'string', optional: true }, { name: 'endField',   type: 'string', optional: true }] },
      // SQL:2016 additions
      { id: 'JSON',             name: 'JSON',             params: [] },
      { id: 'XML',              name: 'XML',              params: [] },
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
      { id: 'xs:Name',             name: 'xs:Name',             params: [] },
      { id: 'xs:NCName',           name: 'xs:NCName',           params: [] },
      { id: 'xs:ID',               name: 'xs:ID',               params: [] },
      { id: 'xs:IDREF',            name: 'xs:IDREF',            params: [] },
      { id: 'xs:NMTOKEN',          name: 'xs:NMTOKEN',          params: [] },
      { id: 'xs:ENTITY',           name: 'xs:ENTITY',           params: [] },
      { id: 'xs:NOTATION',         name: 'xs:NOTATION',         params: [] },
      { id: 'xs:QName',            name: 'xs:QName',            params: [] },
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
      { id: 'xs:dateTimeStamp',    name: 'xs:dateTimeStamp',    params: [] },
      { id: 'xs:date',             name: 'xs:date',             params: [] },
      { id: 'xs:time',             name: 'xs:time',             params: [] },
      { id: 'xs:duration',         name: 'xs:duration',         params: [] },
      { id: 'xs:dayTimeDuration',  name: 'xs:dayTimeDuration',  params: [] },
      { id: 'xs:yearMonthDuration', name: 'xs:yearMonthDuration', params: [] },
      { id: 'xs:gYear',            name: 'xs:gYear',            params: [] },
      { id: 'xs:gYearMonth',       name: 'xs:gYearMonth',       params: [] },
      { id: 'xs:gMonth',           name: 'xs:gMonth',           params: [] },
      { id: 'xs:gMonthDay',        name: 'xs:gMonthDay',        params: [] },
      { id: 'xs:gDay',             name: 'xs:gDay',             params: [] },
      // Binary
      { id: 'xs:base64Binary',     name: 'xs:base64Binary',     params: [] },
      { id: 'xs:hexBinary',        name: 'xs:hexBinary',        params: [] },
    ],
  },
  {
    id: 'json',
    name: 'JSON',
    datatypes: [
      { id: 'string',  name: 'string',  params: [] },
      { id: 'number',  name: 'number',  params: [] },
      { id: 'integer', name: 'integer', params: [] },
      { id: 'boolean', name: 'boolean', params: [] },
      { id: 'null',    name: 'null',    params: [] },
    ],
  },
  {
    id: 'typescript',
    name: 'TypeScript',
    datatypes: [
      { id: 'string',      name: 'string',      params: [] },
      { id: 'number',      name: 'number',      params: [] },
      { id: 'bigint',      name: 'bigint',      params: [] },
      { id: 'boolean',     name: 'boolean',     params: [] },
      { id: 'null',        name: 'null',        params: [] },
      { id: 'Date',        name: 'Date',        params: [] },
      { id: 'Uint8Array',  name: 'Uint8Array',  params: [] },
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
