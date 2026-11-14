# Exporting NORMA `.orm` files

Design for File › Export NORMA .orm…: writing a FreeFBM ORM2 schema as a file
that NORMA (the Natural ORM Architect for Visual Studio) opens. Decisions are
Jan's, 2026-11-14, unless marked as a proposal.

## Why, and what counts as success

Many ORM users see NORMA as the reference tool. The export is there to
reassure them: a model drawn in FreeFBM with ORM's basic constructs can be
moved to NORMA at any time, and a NORMA model can be edited in FreeFBM and
taken back. Round trips through NORMA will be rare and are fragile anyway
(editing in NORMA soon loses whatever only FreeFBM knows), so the export does
not try to be lossless for FreeFBM's own features.

1. **Target.** Only the latest NORMA: NORMA2022 1.0.3051.5 (Visual Studio
   2022, x64), with the schemas of the current NORMA sources
   (github.com/ormsolutions/NORMA). The file format has kept the 2006 ORMCore,
   ORMDiagram and ORMRoot namespaces for years, so older NORMAs will probably
   open the files too, but that is neither tested nor promised.
2. **Clean in NORMA.** An exported file opens in NORMA with nothing in its
   error list, as far as the model allows. Two kinds of error are told apart:
   - *Errors the export causes* (malformed XML, dangling references, pieces
     NORMA expects and does not find, NORMA repairing the file as it loads):
     there must be none.
   - *Errors the model has* (a fact type without a uniqueness constraint, an
     entity type without a reference scheme, a value type without a data
     type): NORMA is right to show them. FreeFBM's validation should report
     the same ones, the export says beforehand which errors NORMA will show,
     and each gets a "FreeFBM:" note beside the element (below).
3. **Dropped content becomes notes.** Whatever NORMA cannot hold is said in
   a note, so that users notice what was left out and understand why.
   After the first check in NORMA (Jan, 2026-11-14: notes beside every
   element were far too noisy), the remarks go into the note of the element
   concerned (NORMA's Notes window shows it), as paragraphs starting with
   "FreeFBM:" after the element's own note; derivation formulas go only into
   the informal rule; the diagram keeps one summary note, above everything
   else on the first diagram. The importer strips the "FreeFBM:" paragraphs
   and the summary note. The first proposal, kept for the record:
   - a note beside the element it is about, joined to it by a note connector
     (NORMA's ModelNote ReferencedBy); content with no element of its own (a
     mapping, a query) goes on the diagram where its elements are drawn;
   - each note starts with "FreeFBM:" and says what was left out and why, and
     what it was, e.g. "FreeFBM: this fact type has a derivation rule that
     NORMA cannot express as a derivation path, so it was not exported. The
     rule was: …";
   - one summary note per file counts what was left out and names the
     FreeFBM version;
   - the same list is shown in FreeFBM after the export, as an export report
     in the style of the import log;
   - the importer recognises these notes (the "FreeFBM:" prefix) and leaves
     them out when the file comes back.
4. **Diagrams from the start.** A file without diagrams would be unpleasant
   to open (NORMA does not lay out a model by itself), and seeing the
   diagrams look right in NORMA is what builds trust. Milestone 1 exports
   them.
5. **Faithful re-export of imported files.** Exporting a file that was
   imported from NORMA gives back the original as closely as possible: same
   ids, same order, same geometry, NORMA-only parts kept, so that NORMA shows
   the user's edits and nothing else. Users will try exactly this to see
   whether they can swap between the two tools. See Milestone 4.

## The FreeFBM side: what the export reads

The export reads the file FreeFBM saves (`store.serialize()`, version 2) and
exports one ORM2 schema (`schema.schemas[]` with profile `orm2`; files without
`schemas` have one implicit schema). Relational schemas, mappings, views and
exchanges are not exported; a note says so.

The diagrams already follow NORMA's geometry (v1.2.12–v1.2.23,
`src/diagram/normaGeometry.js`): one scale of 200 px per inch, NORMA's sizes
for object types, role boxes, bar bands, constraint shapes and notes, Tahoma
text (Wine Tahoma), NORMA's colours, readings shown as "forward / reverse",
NORMA's stacking of uniqueness bars, and a fact type occurrence placed at the
middle of its role boxes. So the export's geometry is mostly the importer's
read backwards. The deliberate differences:

- **Implied bars.** FreeFBM draws the uniqueness and mandatory constraint a
  preferred identifier implies (the entity role of a reference mode fact
  type) without storing them; NORMA needs them stored. The export writes them
  as real internal constraints (uniqueness on the role the preferred
  identifier leaves out, simple mandatory on it).
- **Text widths.** FreeFBM measures its own text; NORMA sizes object type
  shapes from its own measurement when it draws them. The export writes
  NORMA-sized shapes around the same centre (`otBoxSize` gives Tahoma
  widths), and NORMA's own sizing has the last word.
- **External frequency constraints** are pills in FreeFBM and circles in
  NORMA: the export writes NORMA's circle at the pill's centre.

## Mapping

Mostly the importer's table (`src/import/norma.js`) read backwards. The
exporter keeps its own small helpers, but the shared facts (scale, sizes,
datatype names, ring words, colour roles) come from one place so import and
export cannot drift apart.

### File and model

| FreeFBM | NORMA |
|---|---|
| file | `ormRoot:ORM2` with the `orm`, `ormDiagram` and `ormRoot` namespaces (plus `cp` for custom properties, milestone 3) |
| schema name (else the file name) | `orm:ORMModel` `Name` |
| — | `orm:DataTypes` (one element per data type used), `orm:ReferenceModeKinds` (NORMA's three standard kinds) |
| diagram | `ormDiagram:ORMDiagram` `Name`, `BaseFontName="Tahoma"`, `BaseFontSize="0.0972222238779068"`, `IsCompleteView="false"`, `Subject` the model |

### Ids

NORMA ids are GUIDs written `_XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`. An
element imported from NORMA keeps its GUID (the importer keeps them as
FreeFBM ids), so a re-export writes it again. Every other id is derived from
the FreeFBM id and its role in the file (`ot_Person`, `ot_Person#cdt`,
`f_Has#reading0`) by a 128-bit hash written as a GUID: repeated exports give
the same file, and diffs between exports are readable.

### Object types

| FreeFBM | NORMA |
|---|---|
| entity type | `orm:EntityType` `Name`, `IsIndependent`, `IsPersonal`, `_ReferenceMode` (informational), `PlayedRoles`, `PreferredIdentifier` |
| value type | `orm:ValueType` `Name`, `IsIndependent`, `PlayedRoles`, `ConceptualDataType` |
| reference mode (value type + identifying fact type + preferred uniqueness) | written as they are (value type, binary fact type, uniqueness `PreferredIdentifierFor`); NORMA recognises the pattern and draws it collapsed, as FreeFBM does |
| data type, NORMA profile (`NumericUnsignedInteger`) | `orm:UnsignedIntegerNumericDataType` (the category moves to the end), `Length`/`Scale` from the parameters |
| data type of another profile | the nearest NORMA type by kind (text, integer, decimal, boolean, date, time, date and time) and a "FreeFBM:" note naming the original |
| no data type | `orm:UnspecifiedDataType`; NORMA reports it, a model error (point 2) |
| value range, cardinality range | `ValueRestriction`/`CardinalityRestriction` (milestone 2) |
| derivation rule of a subtype | milestone 3 (paths), else a note with the formula |

### Fact types

| FreeFBM | NORMA |
|---|---|
| fact type | `orm:Fact` with `FactRoles`, `ReadingOrders`, `InternalConstraints` |
| role | `orm:Role` `Name` (role name), `RolePlayer`; the player's `PlayedRoles` lists it |
| objectified fact type, and NORMA's implied objectification (more than two roles, or an alethic internal uniqueness over more than one role, not fully derived) | `orm:ObjectifiedType` with `NestedPredicate` (`IsImplied` for implied ones), its preferred identifier (`objectifiedIdentifier`, else the first such uniqueness), and per role an `orm:ImpliedFact` link fact type: a `RoleProxy` for the role, the objectifying type's role with a uniqueness and a simple mandatory, readings "is involved in" / "involves" (or the link's own) |
| unary | a fact type with one role, `UnaryPattern="Negatable"` not written (milestone 2 checks what current NORMA expects) |
| readings: `readingParts` (role order 0…n−1), `alternativeReadings` (`roleOrder`, `parts`) | one `ReadingOrder` per role order (`RoleSequence`), a `Reading` per text; `Data` is the parts around `{0}`…`{n−1}` (placeholders numbered in the order's sequence), hyphen binding written as typed |
| internal uniqueness `uniqueness[]` | `orm:UniquenessConstraint IsInternal="true"` in `Constraints`, referenced from the fact's `InternalConstraints`; `Modality="Deontic"` when in `deonticUniqueness` |
| preferred uniqueness `preferredUniqueness[]` | that constraint's `PreferredIdentifierFor` the player of the role it leaves out; the entity type's `PreferredIdentifier` points back |
| `objectifiedIdentifier` | `PreferredIdentifierFor` the objectifying type (milestone 2, with objectification) |
| implied uniqueness and mandatory of a preferred identifier | written as real constraints (see above) |
| mandatory role | `orm:MandatoryConstraint IsSimple="true"` on that role; `Modality="Deontic"` for `mandatoryDeontic` |
| derived fact type | milestone 3 (derivation paths), else a note with the rule |

### Subtypes

| FreeFBM | NORMA |
|---|---|
| subtype link | `orm:SubtypeFact` with `SubtypeMetaRole` (player the subtype) and `SupertypeMetaRole`, `PreferredIdentificationPath` from `inheritsPreferredIdentifier`; NORMA's own internal constraints on it: a simple mandatory on the subtype role and a uniqueness on each role |
| constraints on subtype links | milestone 2 |

### External constraints (milestone 2)

Exclusion, equality, subset, inclusive-or and exclusive-or (NORMA's exclusion
plus mandatory pair), external uniqueness and preferred identifiers,
frequency, ring, value comparison: the importer's mapping read backwards,
with join paths from query graphs where NORMA can express them, else a note.

### Diagrams

| FreeFBM occurrence | NORMA shape |
|---|---|
| object type at (x, y) | `ObjectTypeShape` `AbsoluteBounds` centred there, `otBoxSize` (one line 0.2295 in, two lines 0.359 in) |
| entity with an expanded reference mode (`expandedRefModeOccs`) | `ExpandRefMode="true"`; its value type and fact type shapes written too |
| collapsed reference mode occurrences (`refModeOwnerOccId`) | no shapes (NORMA draws the mode in the entity shape) |
| fact type at (x, y), the middle of its role boxes | `FactTypeShape` whose role boxes have that middle: the role boxes, a band of 0.07 in per level of bars on the bars' side, 0.025 in all round and one pen width (1/72 in); `DisplayOrientation` (`VerticalRotatedRight` for vertical), `ConstraintDisplayPosition="Bottom"` for `uniquenessBelow`, `RoleDisplayOrder` when `roleOrder` differs from the roles' order |
| reading position (`readingOffsetAbove/Below`) | `ReadingShape` in `RelativeShapes` (proposal: the importer's `placeLabel` in reverse) |
| role names, ranges, objectified name | `RoleNameShape`, `ValueConstraintShape`, `ObjectifiedFactTypeNameShape` (milestone 2) |
| role connectors, subtype links | none: NORMA draws them from the shapes |
| external constraint | `ExternalConstraintShape` (milestone 2) |
| note | `ModelNote` + `ModelNoteShape` (milestone 3) |

### Groups, custom properties, notes (milestone 3)

Groups with their colours (`ORMShapeColorGroupType`, the importer's
`COLOR_ROLES` backwards), custom property definitions and values (`cp:`),
model notes with their connectors, definitions and notes of elements.

### Not exported, as notes

Relational schemas, mappings, views and exchanges; query graphs and formulas
NORMA cannot hold; derivation rules NORMA cannot express as paths; FreeFBM's
temporal and modality extras; populations (proposal: NORMA's sample
populations in a later milestone); translations of names and readings into
other languages (NORMA has one language).

## Milestones

1. **Core model and its diagrams.** Entity and value types (data types,
   reference modes), fact types with readings, internal uniqueness
   (preferred ones included), simple mandatory roles, subtype links,
   objectifications (implied ones too, as NORMA keeps them), and the
   diagram shapes for all of them, with the export report. Enough for most
   models people draw, and enough to judge in NORMA whether the diagrams look
   right.
2. **The other constraints.** External constraints with their shapes, value
   and cardinality ranges, internal frequency, ring constraints,
   constraints on subtype links, unaries as current NORMA
   writes them, reading and label positions.
3. **The rest NORMA has.** Groups and colours, custom properties, model notes
   and element notes, derivation rules (informal now; as paths where
   possible later), and the "FreeFBM:" notes for everything left out (with
   the summary note).
4. **Faithful re-export.** The import keeps, hidden in the .ffbm file, what
   it needs from the original: shape ids, element order, exact geometry in
   inches, implied elements and the NORMA-only parts it skips (generated
   relational and Barker views, generation settings, recognised phrases).
   The export writes what the user has not changed exactly as it came in and
   regenerates only edited elements. (NORMA rebuilds its relational view on
   load, so a stale view is no risk.)

## Tests

All but the last run on a Mac or Linux machine with the NORMA sources only
(the schemas and the 114 sample files, about 8 MB; fetched by the test's own
script through the GitHub API, since git clones and raw downloads can be cut
off on some networks).

1. **Schema validation.** Every exported file validates against NORMA's XSDs
   (`ORM2Root.xsd`, `ORM2Core.xsd`, `ORM2Diagram.xsd`, `DiagramDisplay.xsd`,
   `CustomProperties.xsd`) with xmllint.
2. **Reference check.** Every `ref` names an element of the file, every
   GUID is unique and well formed, every role is in its player's
   `PlayedRoles`, every shape's subject exists: the rules the schemas do not
   catch.
3. **Export → import.** Exporting a FreeFBM model and importing the file
   gives the same model (in what milestone n exports): same object types,
   fact types, readings, constraints, subtype links, and occurrences within
   a pixel.
4. **Import → export on NORMA's samples.** For each sample: import, export,
   compare with the original, ignoring order and formatting, per element
   kind, listing what differs. Until milestone 4 this measures how close the
   export is; after it, an unedited file must come back unchanged.
5. **In NORMA.** On a Windows VM with Visual Studio 2022 and NORMA (the Azure
   VM "norma-vm"): open the exports of the sample model and of the NORMA
   samples, check the error list (empty for clean models; for a NORMA sample
   the same list as the original), compare the diagrams side by side with
   the originals, save from NORMA and diff the saved file with the export.
   NORMA's `ORM2CommandLineTest` may let this run without clicking (to try).

`node scripts/norma-export-check.mjs [--norma DIR] [--out DIR] [file.ffbm|file.orm …]`
runs 1–4: FreeFBM models are exported and checked (1–3), NORMA files are
imported, exported and checked (1, 2, 4).

## Status

Milestone 1 is in `src/export/norma.js` (File › Export NORMA .orm…), checked
with `scripts/norma-export-check.mjs` (2026-11-14, on a Mac with xmllint and
Chrome):

- FreeFBM's sample model: valid against NORMA's schemas, references sound,
  and export → import gives the same model, all 41 occurrences within a
  pixel.
- NORMA's samples: all 104 files in the current format export valid files
  with sound references. Shapes come back where NORMA had them (2,023
  object type and fact type shapes, mean centre offset 0.4 px); the
  differences left are object type widths (FreeFBM's text measurement) and
  objectified fact types (milestone 2). Six old test files in the 2006-01
  namespaces are not read by the importer.
- Not yet tried in NORMA itself (test 5).

First check in NORMA (sample model, 2026-11-14): the file opens and the
diagram looks as in FreeFBM; NORMA's error list has only the model's own
errors (two value types without a data type, Room and Term without a
reference scheme because external constraints are milestone 2). NORMA's
debug build stopped once with a failed assertion while loading: it had to
add the implied objectifications it keeps for every fact type with more
than two roles or a uniqueness over more than one role. The export now
writes them (and explicit objectifications) as NORMA saves them, with their
link fact types, so this moved from milestone 2 into milestone 1. A file
saved by NORMA also showed that NORMA rebuilds implied mandatory
constraints (ImpliedByObjectType) and reading shapes itself.

Second check (2026-11-14): the sample model and the re-export of a real
NORMA model (SamplePopulationExtraction) both load in NORMA without the
assertion; their error lists hold only the models' own errors and what
milestone 2 adds (identification by external uniqueness: Room, Term,
DataValue). Fact types whose derivation rule is not exported also get
NORMA's implied objectification, since NORMA sees them as stored.

Milestone 2 (v1.2.27): external constraints (uniqueness and preferred
identifiers, inclusive-or, exclusive-or as NORMA's mandatory and exclusion
pair, exclusion, equality, subset, frequency, value comparison, ring;
subtype links are constrained through their supertype meta role), internal
frequency, value ranges of value types and roles (an entity type's on its
reference mode's role), cardinality ranges, their shapes, and the labels
FreeFBM keeps at a set place (reading, role names, ranges, objectified
name), placed by the importer's rule read backwards. An external preferred
identifier writes the uniqueness and mandatory it implies on the
identified type's roles. Join paths are left to NORMA where it builds them
itself (roles in binaries joined through one object type); other queries
are reported and wait for milestone 3. The checks pass on the sample model
and all 104 current-format NORMA samples; labels come back within 6 px (the
importer keeps a label reaching a little into its shape beside it).

Milestone 3 (v1.2.28): diagram notes as NORMA model notes with their
shapes and references; definitions and notes of elements; groups with
their members and colours (NORMA's shape grouping extension); custom
property definitions and values; derived fact types and derived subtypes
as NORMA derivation rules whose informal rule holds FreeFBM's formula
(NORMA's role paths are not written yet), so NORMA marks them derived and
no longer objectifies derived fact types implicitly. The "FreeFBM:" notes
are in: one beside each element whose content NORMA cannot hold as it is
(derivation rules, join paths, data types of other profiles, constraints
NORMA has no form for), with FreeFBM's formula where there is one, and a
summary note on the first diagram. The importer leaves "FreeFBM:" notes
out. The check now also runs export → import on imported NORMA files: all
104 samples pass except one (two value type shapes NORMA did not draw,
which the import adds), and a 4 MB real model (ATOP, 58 diagrams) passes
but for six labels that come back at their default place.

Formal derivation paths (v1.2.32): conjunctive rules (∃, ∧, fact atoms,
link fact types of objectifications, subtype tests, equalities) are written
as NORMA role paths (`src/export/normaPathsOut.js`). Since v1.2.35 the
path walks from the subject as NORMA's own paths do (NORMA refused
projections from subpaths with roots of their own: "must project derived
roles from at least one source path"): at each object, every part that
mentions it is a subpath from there; a fact atom is entered through that
object's role and walks its other roles, once per object the path goes on
from; object unifiers join the places that are one variable; a derived
fact type's roles are projected from them. Re-importing gives the same rule up
to typing (a subtype test comes back as the variable's type). Since v1.2.33 negation
and disjunction nest (a disjunction is a subpath split Or into one subpath
per part, a negation a subpath whose split is negated), and a type test
walks the subtype link into the type, so that it stays in its branch.
Rules with closures, value conditions, comparisons or computed roles stay
informal, with a remark in the element's note saying why (SamplePopulation:
11 of 15 formal; the ATOP model's 81 fact type rules all come back the
same).

Join paths (v1.2.37): a sequence of an external constraint whose roles
NORMA cannot join by itself gets FreeFBM's query as a NORMA join path
(JoinRule/JoinPath with ConstraintRoleProjections), built as the derivation
paths are, from the query's target (or its first position). The sample
model, SamplePopulation and ATOP (195 external constraints) come back with
the same constraint formulas.

Milestone 4a (v1.2.38): the import keeps each NORMA shape's id and bounds
on the occurrence, note or constraint occurrence (`normaShape: { id,
bounds, key }`) and on its labels (`normaLabels`), with the key of what the
shape was drawn from (`src/diagram/normaShapeKeys.js`: position, and for a
fact type its orientation, bar side, role order and role names). The
export writes a shape whose key is unchanged, and a label at the same
offset of an unchanged shape, exactly as NORMA had it; a copied occurrence
gets an id of its own. Over NORMA's samples 3,479 of 3,522 shapes come back
with the same id and bounds (the rest are shapes the import adds or
merges).

Check in NORMA (2026-11-14, SamplePopulationExtraction): the error list
holds only the five rules that stay informal (closures, a value
condition, rules without a complete FreeFBM formula); join paths and the
other eleven derivation rules are accepted.

Still open after milestone 3: derivation rules with closures or value
conditions as NORMA paths, sample populations, and milestone 4 (faithful
re-export of imported files).

Open points for the NORMA check: whether a value type without a data type should get NORMA's error or a
default type.
