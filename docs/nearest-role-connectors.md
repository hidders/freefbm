# Position-derived role connectors

## Status

**Accepted design — all five phases done (v1.2.71).** Phase 1 checked NORMA's rule in its source and corrected the rule below (two-sided, shape centres, ties).

This document replaces the current per-occurrence `roleOccurrenceMap` model
for ordinary role-player connectors. It records decisions made on 2026-11-18.

## Motivation

NORMA does not persist a connector from a fact-role shape to a particular
object-type shape. It draws the connector to the nearest suitable occurrence
on the diagram. Consequently, a fact type may occur without one or more of
its role players being shown.

FreeFBM currently stores `roleOccurrenceMap` on fact occurrences and normally
adds a fact type together with all its role players. That makes a diagram
encode visual attachment data which can be derived from its contents and
geometry. It also requires special-case cascades in adding, removing,
copying, changing role players, layout, and NORMA import/export.

FreeFBM will instead use NORMA-like, position-derived connectors. This makes
partial diagrams legitimate, gives NORMA import/export a more faithful model,
and separates schema meaning from diagram presentation.

## Core model

### Schema versus diagram

- The **schema** states that role `r` of fact type `FT` is played by object
  type `OT`, through `fact.roles[r].objectTypeId`.
- A **diagram** records only its occurrences and their presentation geometry.
- A **role connector** is derived at render time. It is not a separately
  stored diagram relationship.

### Derived-connector rule

This is NORMA's rule, read from its source (`MultiShapeUtility
.FindNearestShapeForElement` and `ReconfigureLink` in
`ORMModel/Framework/Diagrams/MultiShapeUtility.cs`, `RolePlayerLink.cs`).
NORMA never saves role connectors (`RolePlayerLink` is an omitted class in
its serializer) and rebuilds them with this function on load and after
every move. FreeFBM's one implementation is `src/diagram/roleLinks.js`.

For every visible occurrence `F` of a fact type and every role `r` of that
fact type:

1. Read the role's schema player `T = role.objectTypeId`.
2. Find visible, compatible occurrences of `T` in the same diagram.
3. If none exist, draw no connector for `r`.
4. Otherwise take the compatible occurrence `P` nearest to `F`.
5. Draw the connector from `F` to `P` unless another occurrence of the same
   fact type is strictly nearer to `P`. In that case `r` on `F` has no
   connector. NORMA does not fall back to the second-nearest player.

So each player occurrence takes at most one connector per role, unless two
fact occurrences are exactly as near to it. A role can therefore be
unconnected while its player is shown. That is NORMA's behaviour and
FreeFBM's NORMA import already reproduces it (`unlinkedRoles`).

Distance is the squared Euclidean distance between the centres of the two
shapes as NORMA has them. An object type's box is centred on its occurrence
point. A fact type's shape is its role boxes plus one band per level of
uniqueness bars on the bars' side, so its centre lies half the bands
towards the bars (`factShapeCentre`), not at the middle of the role boxes.
Centres are kept for NORMA parity, although a large shape (a long fact
type, an objectified fact type) has its centre far from its edges, so
"nearest" can look odd there. That choice is deliberate.

Ties: NORMA walks shapes last to first and keeps the first strictly nearer
one, so on an exact tie the occurrence later in `diagram.occurrences` wins.
This is deterministic and needs no id ordering.

Each role is decided on its own. Both roles of a ring fact type therefore
go to the same occurrence of their player, and no diagram can draw them to
two copies of it. NORMA has the same limitation. This is a known limitation,
not a bug.

A compatible occurrence is an ordinary visible occurrence of the role's
object type, including an occurrence of an objectified fact type when it is a
role player. An occurrence hidden as part of a collapsed reference mode is
not a candidate. An entity type occurrence that shows its reference mode
collapsed takes no connector from that reference mode's fact type: the next
nearest occurrence is used instead (NORMA's `Defer`).

Moving, adding, or removing an occurrence may therefore change one or more
rendered connectors. That is intended behaviour, not a schema change.

Cost: candidates are indexed by schema element, so one role costs
(fact type occurrences) × (player occurrences + fact type occurrences)
distance tests. Links are worked out per role when they are asked for, so
the index can be rebuilt on every drag frame.

### Data that remains explicit

Only ordinary role-player attachment becomes derived. The following remain
explicit occurrence-level data because proximity cannot express their meaning:

| Data | Reason |
|---|---|
| Constraint `roleOccurrenceRefs` and `queryOccurrenceRefs` | A constraint denotes deliberately selected role/fact occurrences. |
| Subtype endpoint occurrence pairs | The same schema subtype can be shown between several selected occurrence pairs. |
| `refModeOwnerOccId` and expansion state | A collapsed or expanded reference mode has a particular owning occurrence. |
| Mapping-rule membership and placement | Mapping diagrams represent transformation structure, not visual adjacency. |

## Persisted format and migration

`diagram.occurrences[]` remains the sole source of ordinary element
membership and position. Its entries retain visual settings such as
`orientation`, `roleOrder`, and label offsets, but no longer persist
`roleOccurrenceMap` or `unlinkedRoles`.

### Legacy models

On load:

- Ignore and discard legacy ordinary `roleOccurrenceMap` entries.
- Ignore and discard legacy `unlinkedRoles` entries.
- Retain the explicit occurrence references listed above.
- Immediately use the new nearest-occurrence rule, even for old FreeFBM
  files. There is no compatibility mode: FreeFBM is not yet deployed to a
  user base, and one unambiguous semantic model is preferable.

On the next save, the simplified representation is written. Loading alone
must not mark a document dirty. The file-format version should be incremented
when the serializer stops writing ordinary role maps.

## User interaction

### Adding items from the Schema Browser

The basic `+` action adds exactly the selected item:

| Item | Result |
|---|---|
| Object type | Add one occurrence. |
| Fact type | Add one occurrence only; existing visible role players connect if nearest. |
| Subtype | Add missing endpoint occurrences if needed, then add its endpoint pair. |
| External constraint | Add its selected member elements and its constraint occurrence. |
| Mapping rule | Retain the current rule-plus-named-elements behaviour for mapping diagrams. |

The fact-type `+` is a dropdown/context-menu action. It offers:

- **Add** — the primitive operation above.
- **Add with players** — add the fact occurrence and one suitable occurrence
  of each currently missing role player.

This visible distinction is deliberate. There is no separate new “grow
diagram” affordance. The existing **Add neighbours…** command remains a
topology-oriented convenience command.

### Revealing a missing player

Double-clicking an unconnected role reveals its player:

1. If no visible occurrence of its schema player exists, add one near the
   clicked role, outward from the fact occurrence with collision avoidance.
2. Select the new occurrence.
3. Recompute all connectors by the ordinary nearest-occurrence rule.

The role context menu exposes the same command as **Reveal player** for
discoverability and keyboard accessibility. It does not store or force a
connection to the added occurrence. A newly placed occurrence can affect
other nearby fact occurrences; a short interaction highlight should make
changed connectors visible.

### Moving occurrences

Connectors update continuously during a drag. When a move changes their
targets, the affected connectors should be highlighted during the drag and,
where useful, summarised on mouse-up. Undoing a move restores the old geometry
and thus the old derived connectors; no connector-specific undo state exists.

### Removing occurrences

Removing from a diagram is local and never cascades through ordinary role
connectors:

| Removed item | Result |
|---|---|
| Object-type occurrence | Affected roles reconnect to another nearest occurrence, or become unconnected. |
| Fact-type occurrence | Its connectors disappear with it; object types remain. |
| Constraint occurrence | Only the displayed constraint disappears. |
| Subtype endpoint pair | Only that displayed pair disappears. |

An unconnected role is valid diagram state. It does not imply a schema
validation error. Optional presentation diagnostics may report, for example,
that an object type is not shown, but they are informational only.

### Role-player reassignment in the schema

Changing a role's schema player from `OldOT` to `NewOT` applies globally:

- Keep every occurrence of the fact type on every diagram.
- Remove the old derived connector.
- Draw a connector to the nearest visible occurrence of `NewOT`, if any.
- Otherwise leave the role visually unconnected.

No fact occurrence is removed because the new player is absent from a
diagram.

### Copy, cut, paste, and duplicate

Diagram operations copy exactly what the user selected. They do not close the
selection under fact-role players.

| Operation | Semantics |
|---|---|
| Copy | Copy selected occurrences, selected constraint occurrences, subtype pairs, and notes only. |
| Cut | Copy those items, remove them from this diagram, then recompute connectors. |
| Paste | Paste exactly the copied items at preserved relative positions. |
| Duplicate occurrence(s) | Add fresh occurrences of the same schema elements with an offset. |
| Duplicate schema element(s) | Create fresh schema elements. Roles are remapped to duplicated object types only when those types were explicitly included in the schema fragment; otherwise they retain their original schema players. |

A pasted or duplicated fact occurrence may validly have no visible role
players.

## Layout

### Layout an existing diagram

Auto-layout operates on precisely the occurrences already shown. It must not
silently add missing role players. It derives connector targets after each
candidate placement and scores those derived connectors for length, crossings,
and box intersections.

### Complete local layout

**Add with players** is the explicit operation for completing a fact type's
immediate local view before layout. No new general “grow diagram” mode is
introduced.

The layout engine, layout scorer, connector renderer, PDF exporter, and
NORMA handling must all use one shared nearest-player helper. There must not
be several subtly different implementations of proximity.

## Constraints, queries, reference modes, and mappings

- Adding an external constraint still brings the elements needed to display
  its selected role/fact/subtype/query members. Its explicit occurrence refs
  determine its graphical connectors.
- Query atoms remain anchored by query occurrence references, not proximity.
- Collapsed reference-mode support occurrences stay hidden and are excluded
  as ordinary player candidates. Expanded visible occurrences participate in
  the normal rule where appropriate.
- An occurrence of an objectified fact type is a valid player occurrence.
- Mapping diagrams retain their current explicit rule membership and their
  special treatment of relational-schema sides.

## NORMA interoperability

### Import

Import exactly the shapes NORMA draws. Do not manufacture ordinary player
occurrences merely because a shown fact type has a role played by that object
type. Derive connectors from imported geometry. Continue to import
reference-mode and subtype information where NORMA supplies it.

### Export

Export exactly the occurrences FreeFBM displays. NORMA itself derives
ordinary role links, so FreeFBM writes no separate link information. Once the
same proximity rule is shared, the existing “NORMA would relink this role”
warning is no longer needed for ordinary roles.

## Implementation plan

### Phase 1 — Shared derived-connector foundation

1. Extract one pure helper, conceptually
   `nearestPlayerOccurrence(factOccurrence, roleIndex, visibleOccurrences, schema)`.
2. Define its inputs, compatibility rules, tie-breaking, hidden-reference-mode
   filtering, and objectified-fact support with unit tests.
3. Make `RoleConnectors`, layout scoring, and all geometry consumers use it.
4. Verify that moving occurrences changes connectors only through geometry.

**Acceptance:** a diagram with two occurrences of one fact type and two of
its player type consistently selects the nearest player for each fact
occurrence; exact ties are stable.

**Done (2026-11-19):** `src/diagram/roleLinks.js` (`nearestPairs`,
`roleLinkIndex`, `factShapeCentre`, `playerLookup`) with unit tests
(`npm run test:role-links`). Role connectors, link fact types, the layout
score, the NORMA import (role and subtype links) and the export's relinking
check use it. Stored `roleOccurrenceMap` and `unlinkedRoles` still win
where present, so nothing looks different yet. Dropping them, which makes
connectors follow geometry only (step 4), is Phase 2. In NORMA's own
sample and test files (about 120 files), 106 role links have a player or
fact type drawn twice on a diagram; 4 of them NORMA leaves unconnected by
the two-sided rule, and none are ties.

### Phase 2 — Eliminate ordinary stored connector state

1. Stop creating `roleOccurrenceMap` for ordinary fact occurrences in new,
   copied, duplicated, generated, and laid-out diagrams.
2. Make model loading discard legacy `roleOccurrenceMap` and `unlinkedRoles`.
3. Remove ordinary map reads from rendering and layout.
4. Preserve only reference-mode ownership mechanics needed for collapsed and
   expanded modes, replacing map reliance there where feasible.
5. Increment the saved-format version and omit legacy fields on save.

**Acceptance:** opening a legacy `.ffbm` file immediately follows the new
rule; saving and reopening it leaves no ordinary role map in the file and
does not change its derived connector behaviour.

**Done (2026-11-20):** nothing writes `roleOccurrenceMap` or `unlinkedRoles`
any more (adding an occurrence, reference modes, auto layout, Add
neighbours, the DDL import, Guess ORM2 schema, transformations, the NORMA
import). Store code that needs a link asks `occurrenceRoleLinks`
(`src/diagram/roleLinks.js`), which follows the rule for shown occurrences
and ownership for a collapsed reference mode's hidden ones. Loading drops
the old fields (after `repairDrawnRefModes`, which still reads them in old
DDL imports) without marking the file changed; files are saved as format 3
(`version: 3`). The role reconnect mode, which nothing started any more, is
gone, as is the export's "NORMA would relink" warning. In the sample, 1 of
172 stored links differed from the rule, on an ERD diagram, so nothing
visible changed. Fact type occurrences are still removed when a player is
missing after reassignment: that is Phase 3.

### Phase 3 — Diagram operations and UI

1. Change basic Schema Browser fact-type `+` to add only the fact occurrence.
2. Add the `+` dropdown/context-menu action **Add with players**.
3. Implement role double-click and context-menu **Reveal player**.
4. Remove ordinary role-player closure from copy, cut, paste, and occurrence
   duplication.
5. Change removal and schema role reassignment to retain fact occurrences.
6. Add drag-time feedback for connector target changes.

**Acceptance:** a fact type can be added, copied, pasted, moved, and retained
on a diagram with no player occurrences; revealing a player produces a
derived connector without persisted connector state.

**Done (2026-11-19):** `addElementToDiagram` takes `{ withPlayers }` (the
Schema Browser's `+` on a fact type or objectified fact type passes false;
its row menu has **Add to diagram** and **Add with players**,
`store.addWithPlayers`); `store.revealPlayers` adds an occurrence of a role's
player next to the role (double-click a role with a player and no
connector, or **Reveal player** in the role menu), placed by `placeRevealed`
in `src/layout/growPlacement.js`, as one undo step; removal from a diagram
(one element, one occurrence, a multi-selection, cut) no longer cascades in
ORM2 diagrams, and `assignObjectTypeToRole` keeps the fact type's
occurrences; copy and paste no longer close the selection under role
players (`closeUnderPrinciple3` is unused there); duplication keeps players
not duplicated. RoleConnectors highlights connectors whose target changed
for 1.5 s (during a drag too, since connectors follow each move). Found on
the way: a reference mode fact type shown on its own was linked to an
entity occurrence showing the mode collapsed; `playerLookup` now takes
`refModeFacts` (every drawn entity type's reference mode fact type) so
NORMA's Defer applies to it too. Left for Phase 4: Copy/Move selection to a
new diagram still brings the selection's players, and newly added fact
types still go to their schema position.

### Phase 4 — Layout and specialised workflows

1. Update auto-layout and `layoutScore` to score derived connectors.
2. Update transformations and relational-to-ORM generation so they do not
   create ordinary role maps.
3. Audit constraint, query, reference-mode, objectification, and mapping
   diagram behaviour against the retained explicit-reference rules.
4. Update PDF export and any minimap/selection paths that assume stored role
   maps.

**Acceptance:** auto-layout never adds missing players; all specialised
diagram forms render correctly using the same shared nearest-player helper.

**Done (2026-11-20):** auto layout (`prepareLayout`) no longer adds value
types that are not on the diagram (it used to draw every value type a shown
fact type used; now only shown ones, and those of an expanded reference
mode), so a role whose player is not shown stays unconnected; it already
orients fact types and scores layouts by derived connectors (`orientFact`,
`layoutScore` via `playerLookup`). Copy/Move selection to a new diagram takes
exactly the selection. A fact type added with the Schema Browser's `+`
(`store.addFactAlone`, also Add with players) is placed by `placeOrmUnits`
between its shown players, or beside the one shown, instead of at its schema
position. The minimap draws role connectors by the rule (it drew them to the
first occurrence). Audited, no change needed: transformations, Generate
tables, Guess ORM2 schema and carried diagrams add fact types with their
players on purpose (complete generated diagrams) and store no maps; mapping
diagrams remove rule elements fact types first and keep object types other
fact types need; external constraints still bring their member fact types
and keep their occurrence references; PDF export draws the canvas's SVG.

### Phase 5 — NORMA import/export and regression suite

1. Simplify NORMA import to preserve only shapes that NORMA drew.
2. Simplify NORMA export and remove ordinary relinking warnings.
3. Add fixture-driven tests for FreeFBM → NORMA → FreeFBM geometry and
   connector behaviour.
4. Add regression fixtures for all scenarios below.

**Acceptance:** imported NORMA diagrams can contain fact occurrences with
missing player occurrences, and FreeFBM/NORMA agree on derived links where
the same shapes are present.

**Done (2026-11-20):** the NORMA import keeps exactly the shapes NORMA drew
(`finishDiagram` no longer adds an occurrence for a player without a shape;
the role is left unconnected, as in NORMA). The export had no relinking
warnings left after Phase 2. `scripts/role-links-check.mjs [file …]` runs
scenarios 6–14 below in a browser page against the store, auto layout and
the NORMA import and export (scenarios 1–5 are the rule's unit tests in
`tests/diagram/roleLinks.test.mjs`): on the sample it copies, cuts, pastes,
reassigns, reveals, adds with players, uses an objectified player and
reference modes, adds a second constrained fact occurrence and lays out a
partial diagram; for each file it exports to NORMA and imports back
(a FreeFBM model first gets a diagram with duplicate fact and player
occurrences and an absent player) and checks that every fact type
occurrence and role connector comes back, and for a NORMA file that the
import keeps every object type and fact type shape and adds none. Found on
the way: Add with players on a reference mode's own fact type left it
unconnected, since the new entity occurrence showed the mode collapsed;
`revealPlayers` now shows that occurrence's reference mode expanded, owning
the fact type occurrence.

## Required regression scenarios

1. One fact occurrence, one shown compatible player occurrence.
2. One fact occurrence, no shown compatible player occurrence.
3. Two fact occurrences and two player occurrences, each choosing its nearest
   player.
4. Moving a fact or player across a nearest-player boundary.
5. Deterministic equal-distance tie.
6. Copy/paste and cut/paste of a fact occurrence alone.
7. Copy/paste of a partial diagram containing fact and one of several player
   types.
8. Role-player reassignment where the new player is absent in some diagrams.
9. Add with players and Reveal player placement.
10. Objectified fact types as role players.
11. Collapsed and expanded reference modes.
12. Constraints and queries that select one of several fact occurrences.
13. Auto-layout of a partial diagram.
14. NORMA import/export with duplicate fact and player occurrences, and with
    intentionally absent player shapes.

## Implementation notes for the current codebase

The primary replacement sites are currently `RoleConnectors.jsx`,
`storeHelpers.js`, `elementSlice.js`, `diagramSlice.js`, `modelSlice.js`,
`layout/ormLayout.js`, `layout/layoutScore.js`, `import/norma.js`, and
`export/norma.js`. The existing code already has a nearest-player fallback in
`RoleConnectors.jsx`; the implementation should promote that fallback into the
single authoritative helper rather than creating a second mechanism.
