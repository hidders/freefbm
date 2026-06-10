// Maps datatype IDs from any profile to the 6 abstract typeKinds used for
// validation and input-type selection (text/integer/decimal/boolean/date/datetime).
// Types without a mapping → null → treated as free-form text with no validation.

const ABSTRACT = {
  text: 'text', integer: 'integer', decimal: 'decimal',
  boolean: 'boolean', date: 'date', datetime: 'datetime',
}

const SQL = {
  CHAR: 'text', VARCHAR: 'text', CLOB: 'text',
  NCHAR: 'text', NVARCHAR: 'text', NCLOB: 'text',
  BINARY: 'text', VARBINARY: 'text', BLOB: 'text',
  NUMERIC: 'decimal', DECIMAL: 'decimal',
  INTEGER: 'integer', SMALLINT: 'integer', BIGINT: 'integer',
  FLOAT: 'decimal', REAL: 'decimal', 'DOUBLE PRECISION': 'decimal', DECFLOAT: 'decimal',
  BOOLEAN: 'boolean',
  DATE: 'date',
  TIME: 'datetime', TIMESTAMP: 'datetime',
  INTERVAL: 'text',
  JSON: 'text', XML: 'text',
}

const XSD = {
  'xs:string': 'text', 'xs:normalizedString': 'text', 'xs:token': 'text',
  'xs:language': 'text', 'xs:anyURI': 'text',
  'xs:Name': 'text', 'xs:NCName': 'text', 'xs:ID': 'text', 'xs:IDREF': 'text',
  'xs:NMTOKEN': 'text', 'xs:ENTITY': 'text', 'xs:NOTATION': 'text', 'xs:QName': 'text',
  'xs:decimal': 'decimal',
  'xs:integer': 'integer', 'xs:long': 'integer', 'xs:int': 'integer',
  'xs:short': 'integer', 'xs:byte': 'integer',
  'xs:nonNegativeInteger': 'integer', 'xs:positiveInteger': 'integer',
  'xs:float': 'decimal', 'xs:double': 'decimal',
  'xs:boolean': 'boolean',
  'xs:dateTime': 'datetime', 'xs:dateTimeStamp': 'datetime',
  'xs:date': 'date',
  'xs:time': 'datetime',
  'xs:duration': 'text', 'xs:dayTimeDuration': 'text', 'xs:yearMonthDuration': 'text',
  'xs:gYear': 'text', 'xs:gYearMonth': 'text', 'xs:gMonth': 'text',
  'xs:gMonthDay': 'text', 'xs:gDay': 'text',
  'xs:base64Binary': 'text', 'xs:hexBinary': 'text',
}

const JSON_PROFILE = {
  string: 'text', number: 'decimal', integer: 'integer',
  boolean: 'boolean', null: 'text',
}

const TYPESCRIPT = {
  string: 'text', number: 'decimal', bigint: 'integer',
  boolean: 'boolean', null: 'text', Date: 'datetime', Uint8Array: 'text',
}

const MAPPING = {
  abstract: ABSTRACT,
  sql2016: SQL,
  xmlschema: XSD,
  json: JSON_PROFILE,
  typescript: TYPESCRIPT,
}

export function datatypeToKind(profileId, datatypeId) {
  if (!profileId || !datatypeId) return null
  const profile = MAPPING[profileId]
  if (!profile) return null
  return profile[datatypeId] ?? null
}

export function datatypeAssignmentToKind(assignment) {
  if (!assignment) return null
  return datatypeToKind(assignment.profileId, assignment.datatypeId)
}
