// NORMA's diagram geometry, in inches, as its shape code defines it
// (ORMModel/ShapeModel in NORMA's sources; measurements only), and FreeFBM's
// scale for it: 200 px per inch. The importer reads NORMA's shape bounds with
// this scale and an export will write them with it; the drawing code takes
// its sizes from here as it moves to NORMA's look (the Claude doc "Making
// FreeFBM diagrams look like NORMA's").

export const PX_PER_INCH = 200
export const PX_PER_POINT = PX_PER_INCH / 72

export const inches = (px) => px / PX_PER_INCH
export const px = (inches) => inches * PX_PER_INCH
export const pt = (points) => points * PX_PER_POINT

export const NORMA = {
  // Text: Tahoma 7 pt for everything (names bold), 5 pt for the role
  // numbers shown while a constraint's roles are picked.
  fontSizePt: 7,
  smallFontSizePt: 5,

  // Object types (ObjectTypeShape): a rounded rectangle around the name and
  // the reference mode, both in the title font.
  objectType: { marginX: 0.06, marginY: 0.05, penPt: 1.2 },

  // Fact types (FactTypeShape)
  roleBox: { width: 0.16, height: 0.11, penPt: 1 },
  collapsedRoleBox: { width: 0.05, height: 0.035 },
  constraintBand: 0.07,          // height of one level of uniqueness bars
  factBorder: 0.025,             // around role boxes and bars
  objectified: { marginX: 0.09, marginY: 0.056 },

  // Constraints
  externalConstraint: { diameter: 0.16, penPt: 1.35 },
  ringConstraint: { diameter: 0.213333333 },
  mandatoryDot: { diameter: 0.075 },

  // Links
  rolePlayerPenPt: 1,
  subtypeLink: { penPt: 1.8, arrowPenPt: 1.4 },
  readingArrow: { width: 0.055, height: 0.05 },

  // Notes (ModelNoteShape)
  note: { width: 0.312, height: 0.132, margin: 0.012 },
}

// NORMA's default colours (Shell/ORMFontsAndColors.cs and the shape pens)
export const NORMA_COLOURS = {
  background: '#ffffff',
  objectTypeOutline: '#00008b',   // DarkBlue
  text: '#000000',
  roleBox: '#000000',
  constraint: '#800080',          // purple
  deontic: '#0000ff',
  roleName: '#0000ff',
}
