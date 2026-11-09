// File › Export SQL DDL…: a relational schema written for its SQL target
// (schema.sql.target, or options.target): PostgreSQL (ddlExport.js), Oracle
// (oracleDdl.js) or SQL Server (mssqlDdl.js).

import { exportPostgresDdl } from './ddlExport.js'
import { exportOracleDdl } from './oracleDdl.js'
import { exportSqlServerDdl } from './mssqlDdl.js'
import { sqlSettings } from './enforcement.js'

export function exportSqlDdl(state, schemaId, options = {}) {
  const target = options.target ?? sqlSettings((state.schemas ?? []).find(x => x.id === schemaId)).target
  if (target === 'oracle') return exportOracleDdl(state, schemaId, options)
  if (target === 'sqlserver') return exportSqlServerDdl(state, schemaId, options)
  return exportPostgresDdl(state, schemaId, options)
}
