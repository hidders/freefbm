// File › Export SQL DDL…: a relational schema written for its SQL target
// (schema.sql.target, or options.target): PostgreSQL (ddlExport.js) or
// Oracle (oracleDdl.js).

import { exportPostgresDdl } from './ddlExport.js'
import { exportOracleDdl } from './oracleDdl.js'
import { sqlSettings } from './enforcement.js'

export function exportSqlDdl(state, schemaId, options = {}) {
  const target = options.target ?? sqlSettings((state.schemas ?? []).find(x => x.id === schemaId)).target
  return target === 'oracle' ? exportOracleDdl(state, schemaId, options) : exportPostgresDdl(state, schemaId, options)
}
