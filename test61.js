// The property matcher, checked against the project's own awkward cases.
//
//   node --experimental-strip-types test61.js
//
// Every fixture here is real: the duplicate row, the pair of yards 20 m apart,
// and the two hand-tagged sessions whose distance set the threshold.

import {
  MATCH_M, MARGIN_M, SPREAD_M,
  backfillCandidate, distanceM, matchProperty, sessionPosition,
} from "./supabase/functions/upright-api/match.ts";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

// --- real coordinates off the project ------------------------------------
const BAUMS   = { id: 107, address: "665 S. Baums Bridge Rd.", lat: 41.323100, lng: -87.199700 };
const NAPLES1 = { id: 34,  address: "2651 Naples Drive",       lat: 41.473100, lng: -87.061100 };
// 20 m north of it, which is what the table actually holds.
const NAPLES2 = { id: 35,  address: "2658 Naples Dr",          lat: 41.473280, lng: -87.061100 };
const FOULIS_A= { id: 18,  address: "1580 Foulis Ct, Chesterton", lat: 41.610000, lng: -87.050000 };
const FOULIS_B= { id: 78,  address: "1580 Foulis Ct",          lat: 41.610000, lng: -87.050000 };
const ALL = [BAUMS, NAPLES1, NAPLES2, FOULIS_A, FOULIS_B];

// A yard's pins sit ~50 m from the geocoded address; that is the real figure
// measured on the two sessions that were tagged by hand.
const near = (p, m, bearingDeg = 0) => {
  const dLat = (m * Math.cos((bearingDeg * Math.PI) / 180)) / 111320;
  const dLng = (m * Math.sin((bearingDeg * Math.PI) / 180)) /
    (111320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: p.lat + dLat, lng: p.lng + dLng };
};

// --- distance -------------------------------------------------------------
ok("distance to itself is zero", distanceM(BAUMS, BAUMS) < 1e-9);
ok("a 20 m pair measures ~20 m",
   Math.abs(distanceM(NAPLES1, NAPLES2) - 20) < 1.5,
   `got ${distanceM(NAPLES1, NAPLES2).toFixed(1)}`);

// --- position -------------------------------------------------------------
ok("no pins is no position", sessionPosition([]) === null);
ok("0,0 is not a yard", sessionPosition([{ lat: 0, lng: 0 }]) === null);
ok("a NaN pin is dropped", sessionPosition([{ lat: NaN, lng: 1 }]) === null);

{
  // THE MEDIAN EARNS ITS KEEP: four pins in the yard and one left on the
  // Hebron fallback 25 km away. A mean would land 5 km from both.
  const pins = [near(NAPLES1, 10, 0), near(NAPLES1, 12, 90), near(NAPLES1, 9, 180),
                near(NAPLES1, 11, 270), { lat: 41.32, lng: -87.20 }];
  const pos = sessionPosition(pins);
  ok("a stray pin does not drag the middle",
     distanceM(pos.at, NAPLES1) < 30,
     `middle is ${distanceM(pos.at, NAPLES1).toFixed(0)} m from the yard`);
  ok("but the spread reports it", pos.spreadM > SPREAD_M);
  ok("and that refuses the match", matchProperty(pos, ALL).reason === "pins-too-spread");
}

// --- the real matches -----------------------------------------------------
{
  // 47 m out, which is what session 1316b157 actually measured.
  const pos = sessionPosition([near(BAUMS, 47, 30)]);
  const m = matchProperty(pos, ALL);
  ok("a true match at 47 m is found", m.best?.property.id === 107);
  ok("and it is confident", m.confident && m.reason === "matched",
     `reason ${m.reason}`);
}
{
  // A tight threshold would have rejected the real thing.
  ok("50 m is inside the threshold", 50 < MATCH_M);
  ok("and 10 m would not have been a safe threshold", MATCH_M > 10);
}

// --- the cases that must NOT auto-assign ----------------------------------
{
  // The duplicate row: identical coordinates, so nearest is a coin toss.
  const pos = sessionPosition([near(FOULIS_A, 20, 0)]);
  const m = matchProperty(pos, ALL);
  ok("a duplicated property is refused", !m.confident);
  ok("and says why", m.reason === "ambiguous", `reason ${m.reason}`);
  ok("while still naming both", m.best !== null && m.runnerUp !== null);
}
{
  // Two real yards 20 m apart — closer than a true match's own error.
  const pos = sessionPosition([near(NAPLES1, 15, 180)]);
  const m = matchProperty(pos, ALL);
  ok("neighbours 20 m apart are refused", !m.confident && m.reason === "ambiguous");
  ok("the margin is what refuses them", 20 < MARGIN_M);
}
{
  // 22 sessions are over a kilometre from anything known.
  const pos = sessionPosition([{ lat: 41.526, lng: -87.083 }]);
  const m = matchProperty(pos, ALL);
  ok("a yard nowhere near a known property is refused", !m.confident);
  ok("and says it is too far", m.reason === "too-far");
  ok("rather than tagging the nearest thing 13 km away", m.best.distanceM > 1000);
}
ok("no properties with coordinates is its own answer",
   matchProperty(sessionPosition([near(BAUMS, 10)]), []).reason ===
     "no-properties-with-coordinates");

// --- backfill -------------------------------------------------------------
{
  const pos = sessionPosition([near(BAUMS, 20, 0), near(BAUMS, 25, 90)]);
  ok("a property with no coordinates is offered one",
     backfillCandidate(pos, { id: 106, lat: null, lng: null })?.propertyId === 106);
  ok("one that already has them is left alone",
     backfillCandidate(pos, { id: 107, lat: 41.3231, lng: -87.1997 }) === null,
     "an existing coordinate is somebody's record, not ours to overwrite");
  ok("a half-set coordinate is still left alone",
     backfillCandidate(pos, { id: 9, lat: 41.3, lng: null }) === null);
  ok("no session position means nothing to offer",
     backfillCandidate(null, { id: 106, lat: null, lng: null }) === null);
}
{
  // Two pins 25 km apart — the Baums Bridge yard and the Valparaiso one. Note
  // the Hebron fallback would NOT do as the stray here: it sits ~345 m from
  // Baums Bridge Rd, inside the spread limit, which is its own small lesson
  // about how close that fallback is to real work.
  const scattered = sessionPosition([near(BAUMS, 5), { lat: 41.526, lng: -87.083 }]);
  ok("scattered pins report a spread past the limit", scattered.spreadM > SPREAD_M);
  ok("and are never written back to a property",
     backfillCandidate(scattered, { id: 106, lat: null, lng: null }) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
