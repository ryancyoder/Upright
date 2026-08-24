# Upright — Site Session

iPad field tool for Ricci's Landscape Management (Hebron, IN). Single-file
web app: `index.html` (~88KB, no build step).

## Core concept

Starting a session begins **continuous master audio** for the whole visit.
Holding the iPad upright also records **silent video** (tilt-triggered clips);
laying it flat pauses video and shows a satellite map. Photo pins, sketches,
and measured polygons are captured on the map. Everything is timestamped
against the master audio timeline (`sessionT0`) and persists to Supabase.

## Deploy

Vercel project `upright-master-audio-test`, alias
`upright-master-audio-test-yoder.vercel.app`. Once this repo is connected to
Vercel, **push = deploy**. Do not hand-paste the file into a deploy tool;
that has caused silent regressions (a plan-gesture system and a slider range
were dropped mid-session when the payload was reconstructed from memory).

Older single-video app still live at `upright-video-notepad-yoder.vercel.app`,
not yet replaced. Promote once the master-audio version is field-proven.

## Backend

Supabase project `ktgpjizfntdfpghalukx` (shared with the VoiceData app).

**Convention — do not deviate without asking:** every table has RLS enabled
with **zero policies**. The anon key has no direct table access. All reads and
writes go through the `upright-api` Edge Function, which holds the service-role
key. Buckets are public-read.

Tables are all prefixed `upright_`: `upright_sessions`, `upright_clips`,
`upright_photos`, `upright_sketches`, `upright_measures`,
`upright_transcript_segments`. Storage bucket: `upright-media`.

`upright_sessions` has a nullable `property_id` FK to the existing
`properties` table — this is what the history list shows as a session's name.
Nullable on purpose: a session must always be startable with one tap, so it
can be tagged afterwards from the history list. `event_id` / `deal_id` are
still nullable and still unused.

### Edge Function `upright-api`

Endpoints under `/functions/v1/upright-api`:
`POST /sessions`, `GET /sessions` (history list), `GET /sessions/:id`,
`PATCH /sessions/:id` (assign property), `GET /properties` (address picker),
`POST /sessions/:id/audio|clips|photos|sketches|measures|plan`,
`POST /sessions/:id/elevation-points|elevation-shots`,
`PATCH /elevation-points/:id`,
`PATCH /photos/:id`, `POST /photos/:id/image`,
`POST /sessions/:id/transcribe`, `GET /sessions/:id/transcript`.

Requires secret `ASSEMBLYAI_API_KEY` (set in Supabase → Edge Functions →
Secrets — NOT Vault, and NOT Vercel env vars; neither reaches the function).

If editing the function, pull current source with `Supabase:get_edge_function`
rather than reconstructing it.

## Data durability — important

All Supabase writes are **fire-and-forget**. Failures are `console.warn`'d,
never surfaced, never retried. In-memory arrays (`pins`, `clips`, `sketches`,
`measures`) plus blobs are the source of truth for the *current* session —
but that's RAM only. No IndexedDB, no localStorage, no service worker.

Consequence: reload/crash/tab-eviction mid-session loses anything not yet
uploaded. The **ZIP export is the only offline-durable copy** and is built
entirely client-side. Transcription does require the round trip, since
AssemblyAI fetches the audio from Storage.

## Settled — don't re-litigate

- Background recording is impossible on iOS web; the page suspends when Safari backgrounds.
- ARKit / LiDAR / WebXR unavailable to iOS Safari as of 2026.
- GPS runs ~3–5 m (10–16 ft) accuracy.
- Satellite imagery can be feet-misaligned and 1–2 years stale.
- Camera-permission failures trace to in-app chat browsers — must open in real Safari, then Add to Home Screen.
- Live `webkitSpeechRecognition` ruled out — unreliable over a long session. Post-session AssemblyAI upload is the chosen approach.
- AssemblyAI chosen over Whisper/Deepgram specifically for speaker separation.
- Measured polygons must be anchored to a snapped photo's pin as one vertex.
- The field drawing editor stays minimal; a richer desk-side editor is deferred.

## Audio playback gotcha

Review routes playback through GainNode (`REVIEW_GAIN`, currently 14×) into a
DynamicsCompressor acting as a limiter, because recordings come back very
quiet. **Once `createMediaElementSource()` succeeds the element's audio is
permanently captured by the Web Audio graph and no longer reaches the speakers
on its own** — if anything downstream throws, playback goes fully silent. The
code falls back to connecting the source straight to `destination`. Don't
collapse that back into one try/catch. If still too quiet, raise `REVIEW_GAIN`.

## Open items

**Just shipped, verify on device:** the review window's left column, and the
video/map swap.

`.review-body` is now a **CSS grid**, not a flex row:

    grid-template-columns: 25% 1fr;      <- column width lives HERE now
    grid-template-areas: "side main"
                         "mini main";

`side` is the transcript, `main` is the big stage, `mini` is the small pane
under the transcript. The video and map panes each carry `in-main` or
`in-mini` and **swap by class only — the panes are never re-parented**.
That is deliberate: moving a playing `<video>` in the DOM restarts it on
iOS Safari. Don't "simplify" the pane swap into appendChild calls.

**There is only one Leaflet map.** `mountMapInReview()` relocates the real
capture map (`#mapwrap`) into the review pane on open and
`unmountMapFromReview()` puts it back on close. Leaflet *does* survive its
container being re-parented — it holds an element reference, not a tree
position — provided `invalidateSize()` runs afterwards. A second review-only
instance would have to re-implement every map tool and would edit a
different set of markers, so review gets the real one and inherits
draggable pins (with their PATCH-on-drop), sketch, measure, the plan
overlay and the mode bar for free.

Consequences worth knowing:

- Leaflet caches container size, so every resize path calls
  `refreshReviewMapSize()` (pane swap, transcript appearing, window resize,
  orientation change). Skip it and you get grey tiles or mis-placed pins.
- The **map toolbar is hidden while the map is in the mini pane** — 190px
  has no room for it. Swap the map to the main stage to get the tools.
- The map's own filmstrip is hidden throughout review; the review photo
  rail already does that job.
- Auto-centring holds off while `mapMode` is active or `pinDragging` is
  true, so the playhead never yanks the viewport out from under someone
  mid-sketch or mid-drag.

The map is driven by the playhead: `updateReviewMapForTime()` picks the
located pin nearest the playhead within `PHOTO_WINDOW_MS` — the same window
the photo rail highlights on, so the two always agree — then selects it via
the existing `selectedPinId`/`markSelectedMarkers()` path and centres on it.
When the transcript hasn't loaded yet, `.review-body.no-transcript` gives
the mini pane the whole left column.

### Per-clip share (silent clip + its audio)

Review's transport bar has **Share clip N with audio**, acting on whichever
clip the playhead is inside (disabled when the playhead is between clips).
It muxes that clip with its slice of the master audio and hands the file to
`navigator.share()` — Messages/Mail/AirDrop on iPad — falling back to a
download.

On the iPad this is a **remux, not a re-encode**: Safari's MediaRecorder
writes MP4/H.264 + AAC for both streams, so ffmpeg copies them into one
container with `-c copy`. Measured at ~40ms for an 8s clip. Mixed containers
(desktop browsers only) re-encode just the audio.

**ffmpeg.wasm asset paths must stay same-origin.** ffmpeg.wasm spawns a
Worker from a sibling chunk and `importScripts()` the core inside it.
Browsers block a cross-origin Worker outright, and the usual `toBlobURL`
workaround breaks emscripten's path resolution (`failed to import
ffmpeg-core.js`). So `index.html` loads `/vendor/ffmpeg/*` and **`vercel.json`
rewrites those to unpkg** — same-origin to the browser, and no 32MB of wasm
committed to the repo. If you ever move off Vercel, that rewrite has to be
reproduced or the assets vendored; don't just point the URLs at a CDN.

The single-threaded core is deliberate: the multithreaded build needs
`SharedArrayBuffer`, which needs COOP/COEP headers, which would break the
Leaflet CDN scripts and the Esri tiles. A stream copy is I/O-bound anyway.

**Clip offsets are wall-clock**, not audio-timeline (`Date.now()-sessionT0`),
so `audioDriftScale()` scales them by real-audio-length ÷ wall-clock-length
before slicing. That needs a *frozen* session length: `totalMs()` keeps
counting after the session ends, so `endSession()` stamps `sessionWallMs` and
post-session reporting uses `sessionDurationMs()`. (This also fixed the ZIP
manifest's `audioDurationSeconds`, which previously reported time-since-start
at the moment you hit export.)

### Plan overlay as a basemap

An imported plan is **georeferenced**, not decorative. `planCorners()` turns
centre lat/lng + width in metres + aspect + rotation into three real corner
latlngs, and three corners of a parallelogram fully define an affine mapping
from image pixel to coordinate. Store the image and those five numbers and
you can rebuild it exactly — that is what `plan_*` on `upright_sessions` is.

Because Leaflet's CRS is independent of any tile layer, **the satellite can
simply be removed**: pins, sketches and measures are computed from lat/lng
and do not change by one millimetre. `basemapBtn` cycles
`both → plan → satellite`; `satLayer` is held in a variable (not created
inline) precisely so it can be taken away.

This is usually the *honest* view once a plan is aligned. Per the settled
notes, satellite imagery is feet-misaligned and 1–2 years stale, so leaving
it under an accurate plan puts two contradictory references on screen with
the stale one beneath your measurements. But note what it does **not** do:
hiding the tiles does not improve accuracy, it hides the disagreement. The
plan is only as well-placed as whatever it was aligned against — align to
two known GPS points (snap pins at identifiable corners) before trusting a
tile-free view.

`planCorners()` is a flat-earth approximation (fixed metres-per-degree with
a `cos(lat)` term). Sub-centimetre at site scale, so fine — but it models the
image as a parallelogram with **no perspective correction**, so a plan
photographed at an angle will never align perfectly however much you nudge it.

**Extent lock prefers the plan's footprint** (`planBounds()`) over the
current viewport when a plan is loaded, and sets `minZoom` from
`getBoundsZoom` so you can't zoom out past the plan.

Geometry changes are PATCHed on a 700ms debounce — sliders and drags fire
continuously and only the resting position matters. The image itself uploads
once, on import.

**Restored plans come back locked.** An unlocked plan freezes the map for
two-finger gestures, which is a nasty surprise when you have just reopened
an old session to look at it. Tap Unlock to nudge.

Note the plan controls live in `.map-toolbar`, which is hidden while the map
is in review's mini pane — swap the map to the main stage to reach them.

### Relative elevation survey

**SHOOT FIRST, PLACE SECOND.** Stand somewhere, hold the iPad up, and shoot
every point from there; drag the pins onto the map afterwards. Shooting and
pin-placing are separate jobs and mixing them means constantly raising and
lowering the iPad.

**OBSERVATION → ANCHOR → unlimited TARGETS.** Nominate one point as `0.00'`,
then measure everything else against it. Nothing here is
absolute; it is a fast relative site survey for grading and drainage, not a
replacement for an instrument.

Height above the device is `d·tan(θ)`. Two sightings from the *same*
observation position cancel the device's own height, so a target is
`d_t·tan(θ_t) − d_a·tan(θ_a)` relative to the anchor. That cancellation is
why no instrument height is stored anywhere.

**Elevation is derived, never stored.** `upright_elevation_points` holds
positions, `upright_elevation_shots` holds sightings, and `elevationOf()`
computes the number live. Drag a pin and every dependent elevation corrects
itself — which would be impossible with a stored scalar. (This replaced an
earlier one-row-per-measurement table that forced each target to carry its
own anchor sighting, making the anchor impossible to reuse.)

**Distance comes from where the pins sit on the map, never from GPS.** GPS
only seeds the first observation so there is something to drag. Against an
aligned plan a tapped pin is far better than a 3–5 m fix, and that is what
makes the numbers worth anything. Do not "simplify" this to use the live fix.

**A second observation position must re-shoot the anchor.** Its angle is
relative to *that* position's horizontal plane and device height, so reusing
another observation's anchor shot silently produces nonsense. `elevBeginSight()`
refuses to sight a target until the current observation has its own anchor
shot, and says why.

**Repeatability is not accuracy.** Shot spread (`angle_spread_deg`, and the
`± repeat` figure) only measures how steadily you held the iPad. Five shots
at a pin dropped two feet off the mark will agree beautifully and all be
wrong. The only check that catches a mis-placed pin is the *same target from
a different observation position*, reported separately as `N obs ± agree`. A
single-observation point is labelled **unverified** on purpose — do not
collapse these two numbers into one "confidence" figure.

Error behaves differently by angle, which is worth knowing in the field:
sensitivity to distance error is `tanθ`, so shallow yard shots (2–4°) are
forgiving of a sloppy pin, while steep ones are not. Angle error scales with
`d·sec²θ`, so long *and* steep is the bad combination.

Two workflow rules that are load-bearing, both found by testing:

- **The survey survives going upright.** Points are placed flat, then sighted
  standing. `showMap(false)` hides the survey bar with the map but must not
  touch `elevSurveyOn` or any point.
- **The sighting overlay stays open after a shot**, offering *Shoot again* /
  *Done*, and carries the running result. Repeat shots are the whole basis of
  the confidence model; if taking a second one meant lying the iPad flat and
  starting over, nobody would ever take one. The same reasoning applies to
  showing the result there — the mode bar is inside `.mapwrap` and invisible
  while you are stood up holding the thing.

### Grade mode (the shooting half)

`SHOOT GRADE` (thumb button above the shutter) toggles it. On entry it
**locks the flat/upright switch** — `handleOrientation` returns early — because
shots are taken at whatever angle the target demands, including pointing at
the ground, and flipping to the map mid-survey would be unusable. It also
logs the observation position from GPS there and then.

Shots fire **automatically on dwell**: hold the crosshair steady for
`DWELL_MS` and it takes the shot itself, so you never fumble for a button
while aiming. After each shot it **disarms until you move off by
`REARM_DEG`**, otherwise one long hold would machine-gun the same point.

The first shot from any observation is always the anchor — creating it the
first time, re-establishing it for a new standing position after that. Each
shot also captures a **camera frame with the crosshair burned in**, attached
to the point. Without that photo a yard full of "Target 3" pins is
impossible to place afterwards.

Pressing the button again ends the mode, restores tilt-to-map, opens the
survey bar and fits the map to the survey. The bar is status, **Sets** and
**Done** — there are no manual add-point buttons, because every point comes
from a shot; a point with no shot has no elevation and is just clutter.

### Sets

A **set** is one observation position plus the targets shot from it. Targets
carry `set_observation_id` so a set survives its shots being deleted (a
reshoot) and can be hidden, locked or removed as a unit. The anchor belongs
to *every* set, so it is never hidden by a set operation and carries its own
lock.

The **Sets** panel lists each set with its targets nested underneath:

- **Hide / Show** — purely visual, and it changes no number, since each
  target is computed from its own observation. Hidden sets drop out of the
  map *and* the filmstrip.
- **Lock / Unlock** — stops the set's pins being dragged once positioned.
  This is what guards a finished survey against a stray thumb.
- **Delete** — the observation, its shots and its targets. One server-side
  DELETE does the lot: the FKs from targets (`set_observation_id`) and shots
  (`observation_id`) both cascade, and the reference photos are purged from
  Storage first so nothing is orphaned.
- **Add shots** — resume the set, adding more targets to it.
- Per target: **Reshoot** (replace its sightings) and **Remove**.

**Resuming or reshooting re-establishes the anchor first, and checks it.**
Every target in a set is measured against that set's anchor angle, which is
only valid for the stance it was taken from. So the fresh anchor shot is
compared with the one already on file, and if it differs by more than
`ANCHOR_DRIFT_DEG` the shot is **refused** — you are not standing where you
were, and anything shot now would silently disagree with the targets already
in the set. The refusal sets `gradeBlocked`, which stops the dwell and the
re-arm handler; without that the warning was overwritten a fraction of a
second later and the user never saw it. The fix is to start a NEW set, which
shares the anchor and cross-checks it (`N obs ± agree`).

Grade mode can now be entered **from the map** (Add shots / Reshoot), so it
forces the camera view on entry and syncs `currentlyUpright` — the tilt lock
means raising the iPad will not bring the camera back by itself, and leaving
the state machine stale meant lowering it afterwards never brought the map
back either.

**Shot points start `placed=false`** at a provisional position fanned around
the observation, and their elevation reads *place pin* rather than a number —
it is not a measurement until the pin is where the point actually is.
Dragging one sets `placed=true`. Compass heading, when the device offers one,
only aims that provisional parking spot to shorten the drag; it never enters
the maths, so iOS compass calibration cannot corrupt a measurement.

Observation, anchor and target each render as their **own SVG glyph** (tripod,
benchmark triangle, crosshair) — deliberately not the standard photo-pin
graphic, since they are different things. **Keep the pins minimal**: glyph
plus at most one line, no fill, border or corner radius. Legibility over
bright satellite comes from drop-shadows, not from a box; a yard full of
boxed labels is unreadable. The point's name shows only while it is
*unplaced*, which is the one moment identity matters — after that the number
is all you want.

**The reference photo must be reachable, and that is fiddly.** Tapping a pin
calls `elevSelect()`, which calls `elevRenderAll()`, which destroys and
rebuilds every marker *during the click* — so the popup Leaflet was opening
belonged to an element that no longer existed, and the photo silently could
never be seen. `elevSelect()` therefore reopens the popup on the freshly
built marker.

**Grade frames share the one filmstrip with the photo pins**, in capture
order — they are pictures of the same site taken minutes apart, so a
separate gallery would be an odd split. `stripItems()` merges both by
`offset` (elevation points carry one from shoot time, rebuilt from
`created_at` on archived sessions). Grade thumbs are badged `A`/`T1`/`T2`
and tapping one highlights its **elevation marker**, exactly as tapping a
photo highlights its pin; selecting either clears the other, so only one
thing is ever lit. Don't reintroduce a second photo panel — one was tried in
the survey bar and a permanent photo-sized hole in the map was worse than the
problem it solved.

The locally captured frame is kept in `photoLocal` even after upload, and the
popup falls back to it if the Storage URL fails to load.
Given the fire-and-forget write model and field connectivity, a pin with a
broken image and no fallback is a real prospect.

Sighting is gated on steadiness (`STEADY_DEG`, sample spread over the same
800ms window that gets averaged into the shot): HOLD STEADY → HOLDING → fire.
The gate runs when the overlay opens, not just on the next orientation event.
**0.4° was unusably tight** on a handheld iPad and is now **1.2°** — the shot
is the *mean* of the window, so ~13 samples put the averaged error well under
the raw spread. The gate exists to reject a real wobble, not to demand tripod
stillness; the spread is recorded on every shot either way.

**The grade button is round and thumb-sized, directly above the camera
shutter** (`right:18px`, shutter at `bottom:80px`, grade at `bottom:172px`),
so the two sit under the same thumb. The sighting HUD is
`pointer-events:none` apart from its own controls, so it never swallows a tap
meant for the shutter underneath.

**The map recentres on the FIRST GPS fix only.** The map can be opened before
GPS has a fix, in which case it sits on the Hebron fallback tens of km away —
which used to park freshly shot pins off-screen where they could not be
dragged. Recentring is first-fix-only so it can never yank the view later.

No compass is needed — bearings come from map geometry, which sidesteps iOS
compass calibration entirely.

### Session history

**Past sessions** (start screen and done panel) lists every session
newest-first from `GET /sessions`, labelled by its property address. Tapping
Open rehydrates the session and launches Review against it.

`hydrateArchive()` rebuilds the same in-memory structures a live session
uses (`pins`, `clips`, `sketches`, `measures`) from API rows and public
Storage URLs, so Review needs no separate code path — it just prefers
`url` over `blob` in the three places media is read. `exitArchive()` tears
that state down; `startSession()` calls it defensively so a live session can
never inherit an archived one's pins.

Two things that bite here:

- **Remote audio needs `crossOrigin='anonymous'` set before `src`.** Review
  pipes audio through `createMediaElementSource()`, and a cross-origin
  element without CORS is captured as a *tainted, silent* source with no
  error raised — the same silent-playback failure mode as the gotcha above,
  different cause.
- **Only revoke object URLs you minted.** `closeReview()` filters on
  `blob:` before calling `revokeObjectURL`, since clip URLs are now
  sometimes Storage URLs.

Sessions whose audio never uploaded are listed but **not openable** — Review
is driven by the master audio, so there is nothing to replay. The row says
so rather than offering a dead button. As of writing, 6 of the 14 most
recent sessions are in that state; one of them has clips, photos and a
sketch, so this is the fire-and-forget write model showing up in real data,
not just abandoned starts.

**Not yet built**
- ZIP export of an *archived* session. The export reads `pin.photo` as a
  data URL and `clip.blob`, both of which are URLs in archive mode. Not
  currently reachable (the done panel isn't part of the archive flow) but it
  will need fetch-and-zip when it is.
- Absolute elevations. Everything is relative to the anchor; nothing ties a
  survey to a plan's spot elevations or a real benchmark.
- Grade between two measured points (`Δelev / distance × 100`), and everything
  downstream of it: contours, slope/drainage arrows, colour-coded zones,
  cut/fill. All cheap now that elevations exist and are derived live.
- Renaming survey points. They auto-label (Observation A/B, Target 1/2) so
  nobody types in a yard; renaming at the desk is not built yet.
- Aligning a plan to known GPS points rather than by eye. This is the piece
  that would make plan-only mode trustworthy rather than merely tidy.
- Perspective/skew correction for plans photographed at an angle.
- ZIP **import** to view old sessions offline. The ZIP already contains everything needed (audio, clips + offsets, photos + offsets, GeoJSON) — except the transcript, which lives only in Supabase. Consider adding `transcript.json` to the export.
- Retry logic / sync-later indicator for failed uploads.
- Client-facing deliverable (PDF or web page vs raw GeoJSON/ZIP).
- Text labels on the map; richer desk-side annotation editor; reference-object photo measuring.

**Needs field testing**
- Sketch/Measure accuracy against known dimensions.
- 58px sidebar buttons with a gloved thumb; marker base size (30% of screen); yellow marker visibility on sunny turf; stroke weight at 3× zoom.
- Extent-lock button reachability; whether the filmstrip eats too much map height in landscape.
- Audio level in real field conditions.
- Elevation accuracy against a known drop (a step, a wall course, a kerb).
  The maths is verified against an independent calculation; what is unproven
  is whether a handheld iPad can be sighted steadily enough for the numbers to
  mean anything, whether `STEADY_DEG` (0.4°) is a sensible gate or just
  annoying, and whether tapping your own standing position on the plan is as
  easy in a yard as it is at a desk.
- Whether the two-observation cross-check actually catches bad pins in
  practice, since that is the only real accuracy signal in the system.
- Plan persistence against a real plan photo on the iPad: whether the upload
  size is sensible over cellular, and whether a restored plan lands exactly
  where it was left.
- Session history against real data: the new `GET /sessions` and
  `GET /properties` endpoints could not be called from the dev sandbox (its
  proxy blocks supabase.co), so they are verified only against mocked
  responses. Counts come from PostgREST embedded aggregates and degrade to 0
  if that syntax ever misbehaves — the rows still open either way.
- Per-clip share on a real session: whether the drift correction actually
  lands the audio on the right moment for a clip late in a long visit, and
  whether the ~30MB one-time ffmpeg download is tolerable on cellular.
- Review pane swap: whether 190px of mini pane is enough to read a video
  thumbnail or a map at a glance, and whether the map's auto-centring fights
  you when you try to pan it manually mid-playback (drawing and pin-dragging
  are already guarded; a plain pan is not).
- Editing on the review map: dragging a pin there PATCHes the same row the
  live map would, so a review-time correction is a real edit to the session.
  Confirm that reads as intended rather than as a surprise.
- Longer-session soak test (30–60 min) — dual-stream recording plus continuous uploads.
- What happens if the iPad backgrounds mid-upload.
