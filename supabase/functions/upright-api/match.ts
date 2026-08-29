// Matching a session to a property by where it was recorded.
//
// A visit happens AT a yard, so the session already knows which property it
// belongs to — it just has never been asked. One session in a hundred carries
// a property_id, because tagging is a thing somebody has to remember to do
// afterwards, and in a yard nobody does.
//
// This is the arithmetic of that, kept pure so it can be tested without a
// network call. Nothing here reads the database or writes anything.
//
// WHAT THE PROJECT'S OWN DATA SAYS, because it set every constant here:
//
//   A TRUE MATCH IS ~50 M AWAY, NOT ~5 M. The two sessions that were tagged by
//   hand and can be checked sit 47 m and 50 m from their property's stored
//   coordinate. That is not error: a property's coordinate is a geocoded
//   street address, and the pins are spread around the yard behind it. A
//   tight threshold would reject every real match.
//
//   BUT A THRESHOLD IS ESSENTIAL. 22 of the 71 sessions carrying pins are
//   over a kilometre from any property with coordinates — their yard simply
//   is not in the table with a position yet. Nearest-wins with no cutoff would
//   tag those to something 13 km away and say nothing.
//
//   AND NEAREST-WINS ALONE IS NOT ENOUGH. `1580 Foulis Ct` exists TWICE at
//   identical coordinates, and `2651` and `2658 Naples Dr` are different yards
//   20 m apart — closer together than a true match's own error. In both cases
//   the nearest is arbitrary, so the runner-up has to be consulted and the
//   match stood down when the two cannot be told apart.

/** Metres. A true match measured 47-50 m, so this is generous on purpose. */
export const MATCH_M = 75;

/**
 * How much further the runner-up must be before the winner is trusted.
 *
 * The Naples pair is 20 m apart and the Foulis duplicate is 0 m apart, so both
 * fall inside this and are correctly refused. A pair 100 m apart clears it.
 */
export const MARGIN_M = 40;

/**
 * How far the pins may spread before their middle stops meaning anything.
 *
 * A yard is tens of metres across. A session whose pins span more than this is
 * either two visits recorded as one or a stray pin dropped on a bad fix, and
 * its centre is somewhere between them — a position no property is at.
 */
export const SPREAD_M = 500;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface PropertyPos extends LatLng {
  id: number;
  address: string | null;
}

/** Great-circle metres. Haversine: exact enough at yard and town scale alike. */
export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface SessionPosition {
  at: LatLng;
  /** How many positions went into it. */
  points: number;
  /** The furthest of them from the middle, in metres. */
  spreadM: number;
}

/**
 * Where a session happened, from the positions it recorded.
 *
 * The MEDIAN rather than the mean, and that is the whole reason this is a
 * function rather than an average in a query: one pin dropped on a bad GPS fix
 * — or left at the Hebron fallback before the first fix arrived — drags a mean
 * across the county, while the median ignores it entirely.
 *
 * Photo pins and survey points both count. A survey point is the better
 * position of the two (it was placed on the map by hand rather than taken from
 * a 3-5 m fix), but they are all in the same yard, which is the only question
 * being asked here.
 */
export function sessionPosition(points: LatLng[]): SessionPosition | null {
  const real = points.filter(
    (p) =>
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lng) &&
      Math.abs(p.lat) <= 90 &&
      Math.abs(p.lng) <= 180 &&
      // 0,0 is the Atlantic. It is never a yard and it is what a broken row
      // looks like.
      (p.lat !== 0 || p.lng !== 0),
  );
  if (!real.length) return null;
  const at = { lat: median(real.map((p) => p.lat)), lng: median(real.map((p) => p.lng)) };
  const spreadM = real.reduce((max, p) => Math.max(max, distanceM(at, p)), 0);
  return { at, points: real.length, spreadM };
}

export type MatchReason =
  | "matched"
  | "no-position"
  | "pins-too-spread"
  | "no-properties-with-coordinates"
  | "too-far"
  | "ambiguous";

export interface PropertyMatch {
  best: { property: PropertyPos; distanceM: number } | null;
  runnerUp: { property: PropertyPos; distanceM: number } | null;
  /** True only when it is safe to assign without asking. */
  confident: boolean;
  reason: MatchReason;
}

/**
 * The property a session was recorded at, if it can be told.
 *
 * `confident` is the only thing a caller should assign on. Everything else —
 * the best guess, how far it was, what it was confused with — is reported so a
 * person can be shown the choice rather than a blank.
 */
export function matchProperty(
  position: SessionPosition | null,
  properties: PropertyPos[],
): PropertyMatch {
  const none = (reason: MatchReason): PropertyMatch => ({
    best: null,
    runnerUp: null,
    confident: false,
    reason,
  });

  if (!position) return none("no-position");
  if (position.spreadM > SPREAD_M) return none("pins-too-spread");

  const ranked = properties
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((property) => ({ property, distanceM: distanceM(position.at, property) }))
    .sort((a, b) => a.distanceM - b.distanceM);

  if (!ranked.length) return none("no-properties-with-coordinates");

  const best = ranked[0];
  const runnerUp = ranked[1] ?? null;

  // Too far to be this yard at all. The honest answer is no match, not the
  // nearest thing on the map.
  if (best.distanceM > MATCH_M) {
    return { best, runnerUp, confident: false, reason: "too-far" };
  }

  // Two candidates this close together cannot be told apart by position, and
  // guessing would put a visit on a neighbour's record.
  if (runnerUp && runnerUp.distanceM - best.distanceM < MARGIN_M) {
    return { best, runnerUp, confident: false, reason: "ambiguous" };
  }

  return { best, runnerUp, confident: true, reason: "matched" };
}

/**
 * Whether a session's own position should be offered as its property's.
 *
 * The reverse of the match, and it is what makes the whole thing work over
 * time: 49 of the project's properties have no coordinates, so they can never
 * be matched to — but a session somebody tagged BY HAND is a surveyed fix for
 * that yard, and writing it back means every later visit there matches by
 * itself.
 *
 * Only ever offered for a property that has none. An existing coordinate is a
 * record somebody else entered, and a session's median pin is not grounds for
 * overwriting it.
 */
export function backfillCandidate(
  position: SessionPosition | null,
  property: { id: number; lat: number | null; lng: number | null } | null,
): { propertyId: number; at: LatLng; points: number } | null {
  if (!position || !property) return null;
  if (property.lat !== null || property.lng !== null) return null;
  if (position.spreadM > SPREAD_M) return null;
  return { propertyId: property.id, at: position.at, points: position.points };
}
