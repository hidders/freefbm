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

- **Electron main** (`electron/main.cjs`) — window lifecycle, native menus, file dialogs (`.orm2` JSON files)
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

Files are saved as `.orm2` (JSON). The store's `exportModel()` / `importModel()` functions serialise/deserialise all four element collections.

### Styling

`src/index.css` defines CSS custom properties for the entire design system (parchment/navy palette, ORM2 element colours, fonts). Components use these variables directly — no CSS-in-JS or utility framework.
