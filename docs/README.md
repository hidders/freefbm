# FreeFBM design documents

| Document | Purpose |
|---|---|
| [`norma-export.md`](norma-export.md) | Exporting NORMA `.orm` files: decisions, the mapping from FreeFBM to NORMA, milestones and tests. |
| [`nearest-role-connectors.md`](nearest-role-connectors.md) | Accepted design and implementation plan for NORMA-style role connectors derived from the nearest visible player occurrence. |
| [`logic/fbm-logic.tex`](logic/fbm-logic.tex) | FBM logic, the logic underlying FreeFBM: vocabulary, populations, syntax, typing, semantics, data operators, the formula of every constraint, queries, derivation rules and notation, as the app implements them, with design rationale. Graphical and textual constraints are shorthands for statements in this logic. |
| [`logic/schema-mappings.tex`](logic/schema-mappings.tex) | Mappings between schemas: patterns, rules, key-safety, coverage and constraint accounting. |
| [`verbalisation/verbalisation.tex`](verbalisation/verbalisation.tex) | Verbalisation: the pipeline from formulas of FBM logic to sentences, and its rule language (v10). |

Each `.tex` file has its compiled PDF next to it. Rebuild one with any LaTeX distribution, e.g. `cd docs/logic && latexmk -pdf fbm-logic.tex`, and commit the PDF with the change.
