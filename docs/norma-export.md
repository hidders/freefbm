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

The export reads the file FreeFBM saves (`store.serialize()`, format 3) and
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
| derivation rule of a subtype | `orm:SubtypeDerivationPath` (`PartiallyDerived` when semi-derived): a NORMA role path when the rule is conjunctive (`src/export/normaPathsOut.js`, see Status), else an informal rule holding FreeFBM's formula and a "FreeFBM:" remark saying why |

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
| derived fact type | `orm:FactTypeDerivationPath` (`PartiallyDerived` when semi-derived) with role projections: a NORMA role path when the rule is conjunctive, else an informal rule holding FreeFBM's formula and a "FreeFBM:" remark saying why |

### Subtypes

| FreeFBM | NORMA |
|---|---|
| subtype link | `orm:SubtypeFact` with `SubtypeMetaRole` (player the subtype) and `SupertypeMetaRole`, `PreferredIdentificationPath` from `inheritsPreferredIdentifier`; NORMA's own internal constraints on it: a simple mandatory on the subtype role and a uniqueness on each role |
| constraints on subtype links | milestone 2 |

### External constraints (milestone 2)

Exclusion, equality, subset, inclusive-or and exclusive-or (NORMA's exclusion
plus mandatory pair), external uniqueness and preferred identifiers,
frequency, ring, value comparison: the importer's mapping read backwards,
with join paths: left to NORMA where it builds them itself (roles in binaries joined through one object type), else FreeFBM's query written as a NORMA join path (`JoinRule`/`JoinPath` with `ConstraintRoleProjections`, the same builder as derivation paths), else a "FreeFBM:" remark with the formula, and NORMA asks for a join path.

### Diagrams

| FreeFBM occurrence | NORMA shape |
|---|---|
| object type at (x, y) | `ObjectTypeShape` `AbsoluteBounds` centred there, `otBoxSize` (one line 0.2295 in, two lines 0.359 in) |
| entity with an expanded reference mode (`expandedRefModeOccs`) | `ExpandRefMode="true"`; its value type and fact type shapes written too |
| collapsed reference mode occurrences (`refModeOwnerOccId`) | no shapes (NORMA draws the mode in the entity shape) |
| fact type at (x, y), the middle of its role boxes | `FactTypeShape` whose role boxes have that middle: the role boxes, a band of 0.07 in per level of bars on the bars' side, 0.025 in all round and one pen width (1/72 in); `DisplayOrientation` (`VerticalRotatedRight` for vertical), `ConstraintDisplayPosition="Bottom"` for `uniquenessBelow`, `RoleDisplayOrder` when `roleOrder` differs from the roles' order |
| reading position (`readingOffsetAbove/Below`) | `ReadingShape` in `RelativeShapes` (proposal: the importer's `placeLabel` in reverse) |
| role names, ranges, objectified name | `RoleNameShape`, `ValueConstraintShape`, `ObjectifiedFactTypeNameShape` (milestone 2) |
| role connectors, subtype links | none: NORMA draws them from the shapes. Since v1.2.71 FreeFBM derives them by NORMA's own rule too (`src/diagram/roleLinks.js`; docs/nearest-role-connectors.md) and stores none, so the export writes the shapes and NORMA draws the same connectors; there is no relinking warning any more |
| external constraint | `ExternalConstraintShape` (milestone 2) |
| note | `ModelNote` + `ModelNoteShape` (milestone 3) |

### Groups, custom properties, notes (milestone 3)

Groups with their colours (`ORMShapeColorGroupType`, the importer's
`COLOR_ROLES` backwards), custom property definitions and values (`cp:`),
model notes with their connectors, definitions and notes of elements.

Groups come back from NORMA unchanged (Jan, 2026-11-20): the importer keeps
each group's types as NORMA wrote them (`group.normaTypes`: type, id, and
colour roles with their values as written, so .NET colour names stay names),
including the Model Browser colours (`ORMModelBrowserColorGroupType`) and
NORMA's own "shapes missing" groups (`ORMShapeMissingGroupType`, imported
since then), the reading orders a group holds (`normaReadingOrders`; FreeFBM
puts the fact type in the group) and the order of the members (`normaOrder`).
The export writes the types back in their order with their ids; a shape
colour changed in FreeFBM is written as R, G, B, one still the same as
written. Not kept: a group's membership of model notes NORMA shows on no
diagram but attaches to elements (the importer folds those into the
elements' notes), and the stored ORMElementsNotOnDiagramError, which NORMA
works out again. On ATOP every group comes back with the same types, ids,
colours and members in the same order, except 3 such notes.

### Not exported, as notes

Relational schemas, mappings, views and exchanges; join paths and
derivation rules that are not conjunctive (see Status, What is left out); FreeFBM's
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
   and element notes, derivation rules (as NORMA role paths when
   conjunctive, else informal rules), join paths of external constraints, and the "FreeFBM:" notes for everything left out (with
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

Labels (v1.2.59): NORMA saves a label shape for every reading, value and
cardinality range, role name and objectified fact type name, and adds a
missing one itself while it loads a file, but other viewers (the web viewer
at ormsolutions.com) draw only the labels that have a shape. The export
therefore writes one for each label: at the place FreeFBM keeps, or else
where FreeFBM draws it by default (a reading centred below the fact type,
above when its reading is above, left or right of a vertical one; a role
value range above its role box; an object type's ranges at
`defaultRangeOffset`, NORMA's own default; an objectified fact type's name
centred above its outline), and role names not moved at NORMA's own default
place (up and left of the shape, cascading per role). Model notes are as
wide as their longest line measured in the note font (they were estimated
at 4.4 px a character, so text ran past the note in the web viewer).

Third check in NORMA (2026-11-15, Jan's test-tabs model on the VM): two
export faults. A custom reference mode named like one of NORMA's own
(intrinsic Code and code, Nr and nr, …; names compare case-sensitively) is
renamed when NORMA loads the file, and every entity type whose value type
its format matched lost its reference mode value type ("[Missing]" role
players); the export now spells the mode as the value type does and writes
a clashing custom mode as a general one. And NORMA folds a path with a
single plain subpath into it on load but deletes that subpath's own
subpaths (RemoveIntraFactTypeSplits moves the parent's subpath links, not
the child's), dropping projections from their roles ("must project all
constrained roles"); the export now writes paths folded as NORMA keeps
them. NORMA without the shape grouping extension also asks to disable Save
for a file with group colours; answering No keeps Save.

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

Value conditions, recursion and Xor (v1.2.76): a value condition on a
variable (x ≈ 'c', x < 'c', …; a lower and an upper bound in one
conjunction are one range, a disjunction of conditions on one variable
one restriction with several ranges, x ≉ 'c' a negated one) is a value
restriction on a pathed role of the variable in the same part of the path,
as NORMA writes them, or, when that part walks no role of the variable, on
the root of a subpath of its own unified with it (not yet tried in NORMA).
¬(φ ↔ ψ) is a split Xor. A fact type's rule that is a disjunction as a
whole is one lead path per case, each with its own projection, as NORMA
writes it, so a case may project one object to two roles. NORMA has no
closure, but a fully derived fact type may use itself (the least
fixpoint): a rule ∃y ([TC*_{u,w} φ](x, y) ∧ ψ(y, n)) in which x occurs
nowhere else is written as ψ(x, n) ∨ ∃w (φ(x, w) ∧ F(w, n)), one recursive
case per case of φ (`openRecursion`, the inverse of the importer's
`closeLinearRecursion`); other closures stay informal. A negation of a
single part is written as NORMA does, its first pathed role negated
(IsNegated): until then the exported negated split was folded into its
part and the negation lost on import (8 rules of ATOP, 1 of
SamplePopulationExtraction). The check now compares each re-imported
rule's atoms and conditions with the original's: ATOP 149 of 153 rules
formal and all the same (was 98), SamplePopulationExtraction 15 of 15
(was 11); `test-schemas/norma/path-export.ffbm` (project files) has
FreeFBM rules of these shapes.

A type test walks into the subtype through both roles of its subtype link
(supertype role, then subtype role), climbing first through the object's
own subtype links when the object is of another subtype of that supertype,
and the rest of what is said about the object goes on from the subtype
(NORMA reported "joins to a path role with an incompatible role player"
for ATOP's VariableArrayPacketFieldUsesPacketFieldTypeCode, whose rule
tests a sibling subtype). The importer reads such a walk as a variable of
the subtype, so a type test may come back as its variable's type.

An informal rule (a rule FreeFBM cannot write as a path) is written with
ExternalDerivation="true", as NORMA writes its own informal rules; without
it NORMA reports that the rule "must project derived roles from at least
one source path" (found on the VM, 2026-11-20). NORMA then treats the fact
type as stored, so it gets the flag only when it has an internal uniqueness
constraint over one role and at most two roles and is not objectified: a
stored fact type with more roles or a longer uniqueness is objectified by
NORMA while loading, which its debug build reports as an assertion
("A fixup phase after phase 200 added elements to …
UnaryDebinarizationFixupListener"). Those keep the "must project" error
until FreeFBM can write their rule as a path.

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

Milestone 4b (v1.2.39): the import also keeps NORMA's names of
constraints (external, internal uniqueness, simple mandatory, frequency,
exclusive-or's exclusion half) and the ids and names of value and
cardinality constraints and of reading orders and readings; the export
writes them back (names are reserved, so new ones do not clash). Over
NORMA's samples: 1,604 of 2,363 readings, 1,627 of 2,658 uniqueness and 816
of 1,370 mandatory constraints keep their id; the rest belong mostly to
objectification link fact types and subtype links, whose parts the
import does not keep yet (milestone 4c, with NORMA-only parts such as
generation settings and element order).

Milestone 4c (v1.2.40): the import also keeps the ids and names of the
parts of subtype links (meta roles and their constraints) and of
objectifications, implied ones included (objectifying type, nested
predicate, link fact types with their roles, role proxies, readings and
constraints), and each object type's and fact type's place in the file.
The export writes them back, Objects and Facts in the imported order (new
elements follow the one they came after). Over NORMA's samples every
entity type, fact type, subtype fact, objectified type, link fact type and
mandatory constraint keeps its id, and so do 2,514 of 2,658 uniqueness
constraints and 2,044 of 2,363 readings (the rest belong to old-style
unaries, which FreeFBM reads as unaries). Not kept: NORMA-only parts that
NORMA regenerates (relational and Barker views, generation settings).

Round-trip diagram fixes (v1.2.41, after Jan's check in NORMA on
2026-11-15): the summary note stays inside NORMA's canvas (beside the
diagram when there is no room above it). Subtype links: NORMA saves none;
it links each shape of the subtype to the nearest shape of the supertype,
as far as the shapes' DisplayRelatedTypes allow (v1.2.42; v1.2.41 wrongly
linked every pair); the import keeps that per occurrence
(`displayRelatedTypes`) and draws exactly the pairs NORMA draws
(`subtypeEndpointOccs`), and the export derives the attribute from
FreeFBM's pairs. The Inspector shows the setting for an object type occurrence as "Subtype links: all / from subtypes / to supertypes / none" (Jan's wording; `store.setSubtypeLinksShown` updates the diagram's pairs as NORMA draws them, and the drawing leaves out pairs the setting excludes); an occurrence's own setting is exported as it is. Drawn link fact types of
objectifications (such as "is typed as") are imported as FreeFBM's shown
implied links (`shownImplicitLinks`, `implicitLinkPositions` with NORMA's
shape kept) and exported as FactTypeShapes of the link fact types.

Second round (v1.2.43, Jan's check on 2026-11-15): the summary note goes to
the free place nearest the top left corner (no overlap, 15 px gap) and is
in a group "FreeFBM export note" (the importer leaves that group out;
its soft yellow background was dropped on 2026-11-20, as a colour needs
NORMA's shape grouping extension and a NORMA without it offers to disable
Save). An entity type's reference mode value
range is drawn at its shape (ValueConstraintShape of the role value
constraint). A drawn link fact type keeps its reading's place and which
reading order is shown, so FreeFBM marks the reading direction as NORMA
does (`implicitLinkPositions` readingOffset…, readingAbove, readingOrder).
NORMA's DisplayAsObjectType is a FreeFBM option: Inspector › Display › As
object type on this diagram (occurrence `displayAsObjectType`), drawn as
an object type box with the objectified name; its own roles' connectors
are not drawn. Over NORMA's samples 3,508 of 3,522 shapes come back with
the same id and bounds.

Check in NORMA (2026-11-14, SamplePopulationExtraction): the error list
holds only the five rules that stay informal (closures, a value
condition, rules without a complete FreeFBM formula); join paths and the
other eleven derivation rules are accepted.

Role connectors (v1.2.71): FreeFBM no longer stores role connectors. It
links each role of a fact type shape to the nearest shape of its player,
centre to centre, unless another shape of the same fact type is nearer to
that shape, with ties to the later shape, as NORMA's MultiShapeUtility does
(`nearestPairs` in `src/diagram/roleLinks.js`, the one place FreeFBM decides
this, also for subtype links). So an exported diagram shows in NORMA
exactly the connectors it shows in FreeFBM, and the export's "NORMA would
relink this role" warning is gone. The import keeps exactly the shapes
NORMA drew: a role whose player has no shape on the diagram stays
unconnected, as in NORMA. `node scripts/role-links-check.mjs [file …]` runs
a NORMA export → import round trip per file and checks that every fact type
occurrence and role connector comes back (design and tests in
docs/nearest-role-connectors.md).

## Aggregates and subqueries (v1.2.76)

Import: a calculated value whose function has a bag parameter (BagInput)
is an aggregate over its lead path, grouped by the path roots and pathed
roles of its AggregationContext (all of them with
UniversalAggregationContext): the aggregate's variables are the path's
other objects and its condition the path again (with its conditions), so
SamplePopulationExtraction's UniquenessConstraintHasArity is
`Arity ≈ Count{Role, Position : UniquenessConstraint restricts Role at
Position}`. A rule's Subqueries (QueryRoles with a QueryDerivationPath of
their own) are inlined where a path enters a query role, as the query's
rule (each lead path a case, a path of its root alone an instance of the
root's type) with its roles renamed to the path's objects;
ObjectTypeAllowsValuesFromDataType's identity-or-supertype query becomes
`x = y ∨ R(x, y)`.

Export: a computed role whose term is an aggregate over the rule's own
body (its condition the body with its variables for the rule's ∃
variables, in order) is a CalculatedValue of the lead path, grouped by
the rule's variables the condition reads, its input the term's variable
(count: the first variable), projected to the role; the functions used
are written as the model's Functions (count, sum, avg, min, max, one bag
parameter each). A disjunction inside a case that has an equality between
variables among its parts is split into cases (at most 16), so each
equality is a unification of its case, and a case without fact types that
projects every role from one object is a path of its root alone (typed by
the most specific of the roles' players). So the inlined subquery comes
back as four lead paths rather than a subquery: the same rule, with other
atoms per case. SamplePopulationExtraction: 17 of 17 rules are NORMA
paths, and its last NORMA error ("must project derived roles") is gone.

## What is left out

All four milestones are in. What remains is listed here; the export
reports each case in the summary note and the element's "FreeFBM:"
remark, the import in the import log and the element's import notes.

**Export: rules and join paths that stay informal.** `conjunctivePath`
(`src/export/normaPathsOut.js`) writes a rule or query built from ∃, ∧,
fact atoms (link fact types of objectifications included), type tests of
variables (a walk through the subtype link), equalities between variables
outside negations and disjunctions, value conditions of a variable against
constants (value restrictions), nested ¬, ∨ and Xor (¬(φ ↔ ψ)), and for a
fact type a rule that is a disjunction as a whole (one lead path per case)
or a closure NORMA can write as recursion. It refuses, and the
export keeps the rule as an informal rule holding FreeFBM's formula:

- transitive closures (TC, TC*) other than one of a fully derived fact
  type's rule in the form NORMA's recursion gives (see v1.2.76 above);
- comparisons of two values (x < y, x ≈ y) and data predicates (`dpred`:
  LIKE, …), and comparisons other than an equality between two variables,
  including an equality inside a negation or disjunction (but in a case
  of a rule that is a disjunction as a whole);
- computed roles (a derived fact type's role given by a term), except an
  aggregate over the rule's own body (see aggregates and subqueries
  below), and fact atoms or type tests with terms as arguments, so data
  operators;
- parts of a negation or disjunction, or of the rule, that are not joined
  to the object they are about (the subject for the rule, the object the
  path is at for a negation or disjunction);
- rules that do not bind the subject or every role of the fact type, or
  that name a fact type the export leaves out;
- a type test of a type that is not a subtype.

The same goes for a join path of an external constraint: a query with one
of these parts is not written, the constraint gets a remark with its
formula, and NORMA asks for a join path.

**Import: role paths that are not translated.** `src/import/normaPaths.js`
refuses (the reason goes to the import log and a "changed" import note
on the element: a derived element without a rule, or a constraint
sequence without its join path): outer joins; negated roots; functions FreeFBM cannot read
(functions are read by operator symbol or name); aggregate functions
other than count, sum, avg, min and max (read by name) and aggregates with
more than one input or an input that is not an object of the path;
subqueries nested more than four deep; shared role paths; several
paths computing one role; a condition that reads objects of separate
branches of its path; and paths through an old-style unary's boolean value
that join, unify or project it, or test it for both true and false.
Informal rules are kept in the element's note.

**Other.** Sample populations are not exported (NORMA's sample
populations, a later step). NORMA-only parts that NORMA regenerates
(relational and Barker views, generation settings) are not kept.

Open points for the NORMA check: whether a value type without a data type should get NORMA's error or a
default type.
