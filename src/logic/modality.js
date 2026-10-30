// Deontic constraints (ORM2 modality, NORMA's Modality="Deontic").
//
// An alethic constraint says what must hold in every state; a deontic one
// says what ought to hold, so a population may break it and is then told
// so instead of being rejected. Deontic constraints are drawn in blue and
// verbalised as "It is obligatory that …" (negative: "It is forbidden that
// …"); their formula is O(φ).
//
// Where the modality is stored:
//   external constraint   c.deontic
//   internal frequency    fact.internalFrequency[i].deontic
//   mandatory role        role.mandatoryDeontic (with role.mandatory)
//   internal uniqueness   fact.deonticUniqueness, role-index arrays matched
//                         like fact.preferredUniqueness; a preferred
//                         identifier is always alethic

const ucKey = (u) => [...u].sort((a, b) => a - b).join(',')

export const isDeonticUniqueness = (fact, uRoles) =>
  !!uRoles && (fact?.deonticUniqueness ?? []).some(du => ucKey(du) === ucKey(uRoles))

export const isDeonticMandatory = (role) => !!(role?.mandatory && role.mandatoryDeontic)
