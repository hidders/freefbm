# FreeFBM design documents

| Document | Purpose |
|---|---|
| [`norma-export.md`](norma-export.md) | Exporting NORMA `.orm` files: decisions, the mapping from FreeFBM to NORMA, milestones and tests. |
| [`nearest-role-connectors.md`](nearest-role-connectors.md) | Accepted design and implementation plan for NORMA-style role connectors derived from the nearest visible player occurrence. |
| [`logic/agg-logic.tex`](logic/agg-logic.tex) | An intermediate sorted logic for ORM2 (draft). Intended as the underlying design document for FreeFBM: graphical and textual constraints are shorthands for statements in this logic, and verbalisation is the translation of such statements into structured natural language. |

Build a PDF with any LaTeX distribution, e.g. `latexmk -pdf docs/logic/agg-logic.tex`.
