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
`POST /sessions/:id/elevation-slopes`, `DELETE /elevation-slopes/:id`,
`PATCH /sessions/:id/elevation-views/:side`,
`POST|DELETE /sessions/:id/elevation-views/:side/plan|photo`,
`PATCH /elevation-points/:id`, `DELETE /elevation-points/:id`,
`DELETE /elevation-points/:id/shots` (all, or `?observationId=` for one
position's sightings), `POST /elevation-points/:id/photo`,
`PATCH /photos/:id`, `POST /photos/:id/image`,
`POST /sessions/:id/transcribe`, `GET /sessions/:id/transcript`.

Requires secret `ASSEMBLYAI_API_KEY` (set in Supabase → Edge Functions →
Secrets — NOT Vault, and NOT Vercel env vars; neither reaches the function).

If editing the function, pull current source with `Supabase:get_edge_function`
rather than reconstructing it. The source is now vendored at
`supabase/functions/upright-api/index.ts` so edits are diffable; keep it in
step with what is deployed. Currently **v18**.

**Replacing an image writes a NEW storage path, never an upsert in place.**
Storage public URLs are cached by the browser and by the CDN in front of the
bucket, so overwriting `.../elevation/<pointId>.jpg` handed back a URL that
still resolved to the *old* picture — which is how a re-shot target kept
showing the shot it was meant to replace. Elevation reference photos, pin
photos re-saved with a drawing, and re-imported plans all go to
`<base>-<timestamp>.<ext>`; `dropOldObject()` then removes the previous file,
but only *after* the row points at the new one. An orphaned object is
harmless; a row pointing at a deleted object is not. Clips already did this.
Audio does not need it — it is written once, at the end of a session.

Old rows still carry unversioned paths and still resolve; nothing needed
migrating.

## Recording mode

Audio and video are **two independent switches**, chosen on the start screen
(both on by default) and shown live in the **header** for the rest of the
session. Not the map toolbar — that is invisible while the iPad is upright,
which is exactly when you are shooting grade and most likely to want the video
off. The state pill says what is actually being captured (`Recording — audio
only`, `Not recording — camera`); a silent session looks identical otherwise,
and believing you were recording when you were not is the expensive mistake.

The camera **always runs** regardless — photo pins, grade sighting and the
crosshair snapshots all need the preview. "Video off" means no clips.

**Video toggles freely.** Clips are independent segments with their own
offsets, so stopping and restarting loses only the footage you chose not to
take.

**Audio is one-way within a session.** It can be stopped part-way — what was
captured is kept and covers 0 to the stop — but never restarted, because
`MediaRecorder.pause()`/a second `start()` closes the gap in the output, which
would slide every clip, pin and transcript offset out of alignment with the
`sessionT0` timeline they are all measured against. The switch disables itself
once spent and says why. A new session can turn it back on; the mic is
re-acquired then, since a session that does not record audio **releases the mic
stream** rather than holding it open (iOS lights its recording indicator for an
open track whether or not anything is being written).

Two things this exposed:

- `endSession()` used to call `audioRecorder.stop()` inside a try/catch and
  rely on the *throw* to reach `finalizeSession()`. Stopping an already-inactive
  recorder is a silent no-op, so once audio had been switched off mid-visit the
  session never finalised and the done panel never appeared. The check is
  explicit now.
- The start and done panels were `justify-content:center` with no scroll, which
  clips the top of an over-tall column with no way to reach it. Both are
  `overflow-y:auto` with `margin-top/bottom:auto` on the end children, so they
  centre when they fit and scroll when they do not.

## My location is a toggle

The blue dot and its accuracy circle sit over the work, and a continuous
high-accuracy `watchPosition` is the most expensive thing the app asks of the
battery. **My location** centres on first tap and, once you are already
centred, turns the whole thing off on the next — graphics *and* `clearWatch`.

Nothing downstream depends on it: distance has never come from the live fix,
and entering grade mode takes a **one-shot** `getCurrentPosition` to seed the
observation, then lets the radio go quiet again.

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

## Camera preview freezes

iOS parks the camera whenever the preview stops being what's on screen — the
page backgrounds, the system takes the capture device, or the `<video>` sits
covered by the map while the iPad is flat. The element is then left holding
its **last frame**, which looks exactly like a live picture: raise the iPad
and you frame a shot against whatever it was pointed at when it went down.

`wakeCamera()` re-asserts the preview on every path back to the camera —
`showMap(false)` (which covers grade mode entered from the map, not just
`resumeRec()`), and returning from the background. It restarts a suspended
element and re-acquires the stream outright when the track has `ended`.
`resumeRec()` waits on it before `startVideoClip()`, because a MediaRecorder
built on a dead stream throws and the clip is lost.

Note how `cameraWaking` is cleared — from **outside** the async body. With
nothing to await, that body runs to completion synchronously, so an inner
`finally` nulls the flag *before* the assignment sets it, and the guard then
latches on for the rest of the session and swallows every later wake.

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

### Scaling a plan off a known dimension

**Set scale** (plan toolbar) is how a plan stops being decorative and becomes
the measurement. Rough the plan in with pinch/twist/drag, then tap the two ends
of a dimension the drawing already states, type what it really is, and the plan
is resized so those two features land that far apart on the ground.

`applyKnownDimension()` scales `planWidthM` by `known ÷ what-it-currently-
measures` and moves `planCenter` **about the first tap**, so the end you
measured from stays put and there is less to drag back. `parseFeet()` takes
`100`, `100'`, `12'6"`, `12-6`, `30"` and `30m`.

After that the scale is **locked** (`plan_scale_locked`, persisted): the Size
slider is disabled and the two-finger pinch no longer resizes — it still
rotates and pans, which is exactly the workflow. **Rescale** re-runs the
measurement; nothing else can change the size by eye. That is the point: the
plan is the accurate reference and satellite is feet-misaligned and 1–2 years
stale, so a stray pinch must not be able to re-size a plan against it.

Marking the two ends needs single-finger taps, which plan gestures swallow, so
`setMapMode('planscale')` turns them off for the duration and restores them
only if the plan is meant to have them.

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

**STANCE PHOTO → ANCHOR → unlimited TARGETS.** A set opens by photographing
**where you are standing** — point the iPad at your own feet and hold steady.
That shot records **no angle and no sighting**; it measures nothing. It exists
because the observation pin has to be dragged onto the map afterwards, and
because anyone resuming the set has to stand in the same spot — which is the
one thing the maths cannot recover. `nextShotIsObservation()` gates it, and it
is skipped when the stance already has a picture. Then nominate one point as
`0.00'` and measure everything else against it. Nothing here is
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

**A new observation position must shoot the anchor first.** Its angle is
relative to *that* position's horizontal plane and device height, so reusing
another observation's anchor shot silently produces nonsense. The first shot
from a position that has never sighted the anchor is therefore always the
anchor, and the overlay says so.

**Returning to a position warns, it does not demand.** Add-shots and Reshoot
(`setResume()`) resume an existing set, and the maths only holds if you stand
where you stood before at the same eye height. But the observation pin is on
the map — you can see where that was — so the overlay shows a red *Stand where
Observation A is on the map* warning and then lets you shoot. An earlier
version forced a fresh anchor sighting and refused the shot if it drifted more
than `ANCHOR_DRIFT_DEG`; that made changing one target a three-step chore for
information the map already gives you.

Re-shooting the anchor deliberately is still possible — the set header carries
a *Re-sight the anchor from this position* control — and that path replaces
only that observation's anchor sighting. It **reports** drift against the old
angle rather than refusing it: you asked to move the datum, so it moves, but
every elevation in the set moved with it and the overlay says by how much.
That note is sticky (`gradeNote`) because the re-arm handler calls
`gradeStatus()` again the moment you move off the point, which would otherwise
wipe it before it was read.

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
survey bar and fits the map to the survey. There are no manual add-point buttons, because every point comes
from a shot; a point with no shot has no elevation and is just clutter.

### Slope runs

**Slope** on the survey bar arms the next two pin taps; tapping two points
draws a line between them labelled with the percent grade and the fall over the
run. Tapping the line or its label removes it. It disarms after one run —
leaving the mode open would make every later tap on a pin do something the user
did not ask for.

**A slope stores only which two points it joins** (`upright_elevation_slopes`,
just `from_point_id` / `to_point_id`). Percent, fall and run are all worked out
in `slopeOf()` at draw time from where the pins sit and what `elevationOf()`
makes of each — so dragging either pin corrects the slope, which a stored
number could not do. Same rule as elevations, for the same reason.

**The arrow points downhill**, not from-first-tapped-to-second: it is drawn on
a landscape site to show which way water runs, and the percent is reported as a
magnitude because the arrow already carries the sign. A run whose ends are
level within 0.05% gets a bar instead of an arrowhead. A run to a point with no
elevation yet (unplaced or unshot) draws dashed and says *not measured* rather
than inventing a number.

The unique index is on the **unordered pair**, so the same two points are one
run either way round; a duplicate POST returns the existing row rather than an
error, since in the field that is the client re-sending, not a mistake.

Deleting a point cascades its runs server-side; `slopesDropFor()` keeps the map
and the in-memory list in step without waiting for the round trip.

### Sets

A **set** is one observation position plus the targets shot from it. Targets
carry `set_observation_id` so a set survives its shots being deleted (a
reshoot) and can be hidden, locked or removed as a unit. The anchor belongs
to *every* set, so it is never hidden by a set operation and carries its own
lock.

**Set management lives on the filmstrip tiles**, not in a separate panel — a
set is drawn as one outlined, named group containing its target frames, with
round icon buttons on the group header and overlaid on each tile:

- **Hide / Show** — purely visual, and it changes no number, since each
  target is computed from its own observation. A hidden set drops off the map
  but **stays in the strip, dimmed** — hiding it there too would leave no way
  to bring it back.
- **Lock / Unlock** — stops the set's pins being dragged once positioned.
  This is what guards a finished survey against a stray thumb.
- **Delete** — the observation, its shots and its targets. One server-side
  DELETE does the lot: the FKs from targets (`set_observation_id`) and shots
  (`observation_id`) both cascade, and the reference photos are purged from
  Storage first so nothing is orphaned.
- **Add shots** — resume the set, adding more targets to it.
- Per target tile: **Reshoot** (replace its sightings) and **Remove**.

The **anchor sits outside every set** — it is the shared datum, not part of
any one of them — but it gets a box of the **same construction** (`.film-set
.is-datum`, headed *Anchor*, lock and Remove in the header like a set's), so
the strip has one bottom edge instead of a short loose tile beside taller
groups. A dotted border in the anchor's own yellow, and no fill, say it is the
datum rather than another set. Its **Remove** control only appears once nothing
is measured against it any more — deleting a live anchor would quietly
invalidate every elevation in the survey. Ordinary photo pins stay loose tiles
at their own height, centred against the boxes; they are site photos, not
survey frames.

Status plus **Done** float over the map as a small pill at the top centre
(`.elev-bar`), not as a bar at the bottom. As a bottom bar it was absolutely
positioned over the filmstrip and the map toolbar and cut into both. Keep it
sized to its content — the map has to show through.

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
graphic, since they are different things — in their **own colour**, and it is
the same colour everywhere that thing appears: the sighting crosshair, the
crosshair burned into the captured frame, the filmstrip badge and the map
glyph all read from `OBS_SIGHT` / `ANCHOR_SIGHT` / `TARGET_SIGHT`. Change a
colour in one place and it changes everywhere; the CSS tokens `--obs-sight` /
`--anchor-sight` / `--live` have to be kept in step by hand. **Keep the pins minimal**: glyph
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

**The sight is colour-coded by stage** — green with the tripod glyph while
documenting your stance, yellow with the benchmark glyph while the anchor is
what you are aiming at, red for every target after that (`OBS_SIGHT` /
`ANCHOR_SIGHT` / `TARGET_SIGHT`, mirroring `--obs-sight` / `--anchor-sight` /
`--live`). One local `--cross` var drives the arms, the ring and the glyph, and
a drop-shadow rather than a heavier stroke keeps the green one readable over
turf. `nextShotIsObservation()` / `nextShotIsAnchor()` are the single source of
that state — no datum yet, this
standing position has never sighted the one that exists, or the anchor is
being deliberately re-sighted — and `paintSight()` runs from `gradeStatus()`,
so every path that updates the message recolours the sight with it. The
crosshair burned into the captured frame uses the same colour, which makes a
stance frame and an anchor frame recognisable at a glance in the filmstrip.

The stance photo is the **first tile inside its set group**, badged `O`, and
carries a *Re-photograph where you stood* control — which warns you to stand
there first, since that picture is what tells the next person where to stand.
The group still **sorts by its earliest target, not by the stance photo**: the
anchor tile sits outside every group as the shared datum, and a group sorting
ahead of the anchor it is measured against reads backwards.

Because the stance photo pushes no shot, the dwell re-arm compares against
`lastShotAngle` — the last thing *fired* — rather than the tail of `elevShots`,
which would otherwise leave the sight disarmed against a stale angle belonging
to a different point.

Sighting is gated on steadiness (`STEADY_DEG`, sample spread over the same
800ms window that gets averaged into the shot): HOLD STEADY → HOLDING → fire.
The gate runs when the overlay opens, not just on the next orientation event.
**0.4° was unusably tight** on a handheld iPad and is now **1.2°** — the shot
is the *mean* of the window, so ~13 samples put the averaged error well under
the raw spread. The gate exists to reject a real wobble, not to demand tripod
stillness; the spread is recorded on every shot either way.

**The grade button is round and thumb-sized, in the lower LEFT corner**
(`left:18px, bottom:80px`), level with the camera shutter on the right and a
screen-width away from it — one thumb each, and no chance of hitting the
shutter when you meant to shoot grade. The sighting HUD is
`pointer-events:none` apart from its own controls, so it never swallows a tap
meant for the shutter underneath.

**The map recentres on the FIRST GPS fix only.** The map can be opened before
GPS has a fix, in which case it sits on the Hebron fallback tens of km away —
which used to park freshly shot pins off-screen where they could not be
dragged. Recentring is first-fix-only so it can never yank the view later.

No compass is needed — bearings come from map geometry, which sidesteps iOS
compass calibration entirely.

## Elevation view (branch `claude/elevation-view`)

Four vertical section planes through the survey, held perpendicular to each
other and rotated as **one cross**, so they can be squared to a building that
does not face true north. **Section cuts** on the map toolbar shows them; a
second tap locks the orientation, a third unlocks.

The cross hangs off a **pivot lat/lng**, not the survey centroid — the centroid
moves every time a pin is dragged, and the cuts must not wander with it. With
`rot` clockwise from true north, in (east, north) metres:

    nHat = ( sin rot,  cos rot)
    eHat = ( cos rot, -sin rot)

They are perpendicular *by construction*, so no drag can put the four out of
square. Each side's handle slides its plane along its **own normal** only; the
rotate handle sets `rot` from its bearing off the pivot.

**The cut layers are built once and thereafter only repositioned.**
`cutsBuild()` creates them; `cutsRefresh(dragging)` moves them, leaving the one
layer named by `dragging` alone so it tracks the finger. A drag handler that
rebuilds destroys the very marker Leaflet is dragging and the drag dies on the
first move — which is exactly why the cuts would not drag at all, and the same
trap as the image corner handles.

Three more things that stopped them being grabbable:

- `iconSize:[0,0]` makes the grab target a zero-size element with the visible
  circle merely overflowing it. The handles carry a real 26px icon box.
- Every offset started at 0, so all four side handles and the pivot **stacked on
  one point**. `cutDefaultOffsets()` opens them into a box that brackets the
  survey, and each side's handle rides a fixed 95px along its own line.
- The rotate handle sat at 0.45 × the viewport diagonal *in metres*, which put
  it off the edge of the map at most zooms. It is now held 110px from the pivot
  in screen space.

Cut polylines carry `className:'cut-path'` — the GPS accuracy circle is also a
path in the overlay pane, and its degenerate start/end angle was polluting
geometry readings.

Tapping a cut — or the five-way switch, which sits on the map as well as in the
panel — opens that **profile**. Everything plotted on the horizontal plan is
re-plotted vertically: x is distance along the section, y is what
`elevationOf()` derives. Nothing new is stored; drag a pin on the map and the
profile follows, exactly as the plan numbers do. Slope runs are drawn as real
slopes here.

- **The anchor datum sits one third up from the bottom** — two thirds above for
  positive elevations, one third below for negative, as specified.
- **Vertical exaggeration is unavoidable and is always announced.** A yard with
  a 6 ft fall over 200 ft is a flat line at true proportion, so the view
  auto-picks an exaggeration from 1/2/3/5/10/20/50 and says which
  (`vertical ×3`) or says `true proportion`. **An overlaid photo only aligns at
  ×1** — the tab shows the factor at all times so an exaggerated profile can
  never be mistaken for a measured one.
- Points **in front of** the cut plane draw solid, points behind draw faded.
  That split is what sliding a cut actually decides.

**Images are placed by four corners, in view coordinates (feet along, feet
up).** Four corners is a full homography, which is exactly what a facade
photographed from the ground needs; a drawing just uses a rectangle.
`quadMatrix()` is the classic unit-square-to-quad solve, pre-scaled by the
image's own pixel size and emitted as a CSS `matrix3d`.

`evCornerHandles()` **repositions the handles, never rebuilds them.** A drag
holds pointer capture on the handle; replacing the element mid-drag drops that
capture and with it every later move and the pointerup that saves the result —
the same trap that once made elevation reference photos unreachable on the map.

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
- Everything downstream of slope runs: contours, colour-coded drainage zones,
  cut/fill. All cheap now that elevations and slopes are both derived live.
- Renaming survey points. They auto-label (Observation A/B, Target 1/2) so
  nobody types in a yard; renaming at the desk is not built yet.
- Aligning a plan's *position and rotation* to known GPS points. Its **size**
  now comes from a dimension on the drawing (Set scale); where it sits and
  which way it faces are still placed by eye.
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
