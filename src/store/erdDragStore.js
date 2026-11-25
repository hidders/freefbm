import { create } from 'zustand'

// The table boxes being dragged on an ERD side of a mapping diagram
// (ErdView.jsx), so that the rule nodes' connectors (MappingLayer.jsx) follow
// them while the drag lasts. Session only, never in the model: the positions
// are stored on mouse up. { diagramId, schemaId, ids: Set, dx, dy } or null.
export const useErdDrag = create(() => ({ drag: null }))
export const setErdDrag = (drag) => useErdDrag.setState({ drag })
