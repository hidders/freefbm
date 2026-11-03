# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # Install dependencies
npm run dev        # Start dev (Vite on :5173 + Electron, with DevTools)
npm run build      # Bundle with Vite then package with electron-builder → release/
npm run preview    # Preview the Vite production build
```

No test runner or linter is configured.

## Architecture

This is an **Electron desktop application** for editing ORM2 (Object-Role Modeling 2) conceptual diagrams. The UI renders entirely in SVG on a pannable/zoomable canvas.

### Process split

- **Electron main** (`electron/main.cjs`) — window lifecycle, native menus, file dialogs (`.ffbm` JSON files; `.orm2`/`.json` still open; NORMA `.orm` is imported)
- **Preload** (`electron/preload.cjs`) — exposes `window.electronAPI` (openFile, saveFile, onMenuEvent) via context bridge
- **Renderer** — React 18 SPA served by Vite; communicates with main only through `window.electronAPI`

### State management

All application state lives in a single **Zustand store** (`src/store/ormStore.js`). This includes:
- ORM2 element data: `objectTypes`, `facts`, `subtypes`, `constraints`
- Interaction state: `selectedTool`, `selectedId`, `linkDraft` (multi-step operations), `pan`, `zoom`
- Undo/redo stacks: JSON snapshots, max 60 history entries (managed by `src/hooks/useUndoRedo.js`)

### ORM2 data model

| Element | Shape | Key fields |
|---|---|---|
| ObjectType | rect (entity) or ellipse (value) | `name`, `isValueType`, `x`, `y` |
| FactType | row of role boxes | `roles[]` (each has `objectTypeId`, uniqueness constraints) |
| Subtype | arrow between ObjectTypes | `superTypeId`, `subTypeId` |
| Constraint | graphical badge | `type` (Exclusion/Equality/Subset/Ring/Frequency), `roleGroups[]` |
| Group | none (colours its members) | `name`, `colors{outline,fill,text,graphics,floating,constraint,deontic,connector}` (NORMA colour roles), `priority`, `members[]` (element, role or note ids); see `src/utils/groups.js` |
| Schema | none (schema strip above the diagram tabs) | `name`, `profile` (`orm2` or `relational`); elements and diagrams carry `schemaId`, the active schema is the active diagram's; panels use `scopeToSchema`/`useScopedStore`. A relational schema is encoding B (table = entity type, column = binary fact type to a value type, see docs/logic/schema-mappings.tex), checked by the Relational Profile validation category, with PostgreSQL datatypes |
| Mapping | none (Mappings tab in the bottom panel) | `name`, `sourceSchemaId`, `targetSchemaId`, `rules[]` of `{name, source, target}`; each side is a pattern in the rule-tree format (∃, ∧, fact, type, `x ≈ $y`/`x ≈ 'c'` as vcmp, table row `rel`, optional `opt` [$y], `not`); see `src/mapping/mapping.js` and docs/logic/schema-mappings.tex |
| PropertyDefinition | none (values in each element's `properties`) | `name`, `category`, `type` (string/number/boolean/date/enum), `options`, `default`, `appliesTo[]`; see `src/utils/customProperties.js` |

Roles connect FactTypes to ObjectTypes; `RoleConnectors.jsx` draws the SVG lines.

### Component responsibilities

- `App.jsx` — mounts all panels, registers global keyboard shortcuts, calls `useElectronMenu`
- `Canvas.jsx` — SVG viewport; owns mouse/wheel events, drag, pan, grid snapping
- `ObjectTypeNode.jsx` — entity/value rendering + drag + subtype/role link initiation
- `FactTypeNode.jsx` — n-ary fact box + uniqueness constraint toggle
- `Inspector.jsx` — right-panel property editor for the selected element
- `useElectronMenu.js` — translates Electron menu IPC events (New, Open, Save, Undo, Redo…) into store actions

### Tool modes

The active `selectedTool` in the store determines how canvas clicks are interpreted: `select`, `addEntity`, `addValue`, `addFact`, `assignRole`, `addSubtype`, `addConstraint`.

### File format

Files are saved as `.ffbm` (JSON; the legacy `.orm2` and `.json` extensions still open). The store's `exportModel()` / `importModel()` functions serialise/deserialise all four element collections.

File › Import PostgreSQL DDL… reads a `.sql` script into a new relational schema of the open file (`src/relational/ddlParse.js` parses CREATE TABLE / ALTER TABLE ADD CONSTRAINT / enums / domains / unique indexes; `ddlImport.js` builds encoding B with one diagram, as one undo step via `store.historyBatch`); File › Export PostgreSQL DDL… writes the active relational schema (`ddlExport.js`).

A diagram of a relational schema can be drawn as an ERD (crow's foot, read-only): the ORM2 | ERD switch at the right of the diagram tabs sets `diagram.notation`; `src/components/ErdView.jsx` draws the tables that `src/relational/relationalModel.js` reads from encoding B (shared with the DDL export), with box positions in `diagram.erdPositions` (Auto layout clears them); `src/relational/erdRouting.js` places tables in columns by FK depth and routes FK lines at right angles around the boxes, one attachment point per FK end (assignPorts); clicking a line selects the FK's subset constraint and highlights its columns.

Mappings (workbench step 7): `src/mapping/mapping.js` holds the pattern format, its flat form (`treeToSide`), the expansion of table-row atoms into encoding B (`expandSide`), and `checkRule` (well-formedness, types, the P2 binding rules for frontier variables, key-safety via `determined`); the Mappings tab (`MappingsTab.jsx`) lists mappings and their rules as formulas with check messages, and rules are edited live in the floating `MappingRuleEditor.jsx` (`store.mappingRuleEditor`), a pattern mode of the derivation rule editor's click-to-select tree editing (it reuses VarSelect/ConstInput from `DerivationRuleEditor.jsx`). Mappings are saved in the file (`schema.mappings`) and are part of undo.

Mapping diagrams (workbench step 7b): a diagram with `mappingId` draws that mapping; it belongs to the mapping's source schema (`schemaId`, where new elements go) but may hold occurrences of both schemas (`activeScopeIdsOf`/`scopeToSchema` then scope panels to both). The schema strip lists mappings as chips and the Mappings tab has a Diagram button; both call `store.openMappingDiagram`, which makes the first diagram with the elements the rules name (`addMappingRuleElements`: home positions from each schema's own diagrams, target side to the right). `src/components/MappingLayer.jsx` tints elements by side (MappingTints) and draws each rule as a node linked to its elements (MappingRules; hover highlights via `store.ruleHighlight`, click opens the rule editor, drag stores `diagram.mappingRulePositions`). Mapping diagrams are always drawn in ORM2.

Running mappings (workbench step 8): `src/mapping/runMapping.js` matches one side of each rule against its schema's population (`matchSide`, backtracking with fact indexes; opt binds $y to null, not filters) and builds the other side's population (`buildSide`: entity instances come from their reference schemes, ref mode or composite identifier, so the same key gives the same instance; identifying facts are not stored as tuples). `runMapping(state, mapping, 'forward'|'backward')` returns the built populations with per-rule match counts and a log; `withRunApplied` swaps them into the target schema (`store.applyMappingRun`, one undo step); `roundTrip` runs there and back and compares each type and fact population of the source (lost/gained, plus types and facts no rule reads). The Mappings tab has Run →, Run ← and Round trip buttons. Sample rows come from `INSERT … VALUES` statements in an imported DDL script (`ddlParse` `inserts`, `ddlImport.samplePopulation`, max 20,000 rows); `COPY` blocks are not read.

Guessing an ORM2 schema (workbench step 9): `src/relational/guessOrm.js` reads a relational schema (`relationalModel`) back as ORM2 and writes the mapping to it. `analyseTables` classifies each table (entity, subtype when its primary key is a foreign key to another table's key, junction when all columns are in its foreign keys and its key and nothing references it, nokey) and finds surrogates (a one-column key with generated values: SERIAL, IDENTITY, a sequence or UUID default) and natural keys (UNIQUE, NOT NULL, not generated); `guessOrmSchema` builds entity types (singular Pascal-case names), reference modes or preferred external uniqueness constraints, attribute and foreign-key fact types (readings from column names), m:n fact types, and one mapping rule per entity type, attribute and foreign key, joining over a dropped surrogate in the source pattern. The dialog `GuessOrmDialog.jsx` (store `guessOrmDialog`, opened from the schema strip's + menu) lets the user keep or drop each surrogate; `store.guessOrmFromRelational` adds schema, diagram (rows by foreign-key depth) and mapping as one undo step. When a run builds a table whose surrogate nothing gives, `runMapping` invents it from another key (`⟨values⟩`, `altKeysOf`), and `roundTrip` compares such surrogates up to renaming (`surrogateRenaming`).

File › Open also accepts NORMA `.orm` files: `src/import/norma.js` (`importNorma`) turns the XML into a FreeFBM model, which opens as a new unsaved model with an import log (`ImportLogPanel.jsx`); `src/import/openModelFile.js` routes the file. NORMA role paths (derivation rules of fact types and subtypes, hand-drawn join paths) become rule-tree formulas via `src/import/normaPaths.js`; positive linear self-recursion in a fully derived fact type's rule is rewritten as a TC* closure (`closeLinearRecursion`); outer joins and calculated values are not translated yet. Semi-derived rules may use themselves positively (least fixpoint over the stored population, `derivedPopulation.js`).

### Styling

`src/index.css` defines CSS custom properties for the entire design system (parchment/navy palette, ORM2 element colours, fonts). Components use these variables directly — no CSS-in-JS or utility framework.
