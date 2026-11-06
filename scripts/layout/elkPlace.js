// Development-only benchmark: the core graph of src/layout/ormLayout.js placed by
// ELK (elkjs, EPL-2.0, a devDependency that is never bundled into the app), so the
// harness can compare our placement with ELK's. Loaded in the page by the harness.
import ELK from 'elkjs/lib/elk.bundled.js'

export async function elkPlace(plan, algorithm = 'layered') {
  const elk = new ELK()
  const sub = new Set(plan.below.map(p => `${p.sup}|${p.sub}`))
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': algorithm,
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '50',
      'elk.stress.desiredEdgeLength': '120',
    },
    children: plan.nodes.map(n => ({ id: n.id, width: n.w, height: n.h })),
    // Subtype links point from the supertype down to the subtype.
    edges: plan.edges.map((e, i) => {
      const down = sub.has(`${e.b}|${e.a}`)
      return { id: `e${i}`, sources: [down ? e.b : e.a], targets: [down ? e.a : e.b] }
    }),
  }
  const out = await elk.layout(graph)
  const off = new Map(plan.nodes.map(n => [n.id, n.offX ?? 0]))
  // ELK places whole blocks; the layout wants the entity type's centre (satellites on the right).
  return new Map(out.children.map(c => [c.id, { x: Math.round(c.x + c.width / 2 + 100 - off.get(c.id)), y: Math.round(c.y + c.height / 2 + 100), side: 1 }]))
}
