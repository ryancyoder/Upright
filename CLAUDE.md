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
`POST /sessions/:id/elevation-points|elevation-shots` (a shot carries
`headingDeg`/`headingAccDeg` — evidence, never input),
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
step with what is deployed. Currently **v19**.

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

## Pin inspector — the map's left column

Every pin on the map — photo pins and survey points alike — is described in a
fixed **left column**, not in a Leaflet popup. A popup is anchored to the very
thing it describes, so the one moment you most need to see a pin — dragging it
onto the spot it actually belongs — is the moment its own bubble is sitting on
top of it *and* on top of the ground you are aiming for. The column holds
still: photo on top, everything known about the pin underneath.

**It tracks whatever is under your finger.** Picking a pin up opens it there,
so the preview swaps to the pin being dragged. The numbers update live —
coordinates as the pin moves, and for a survey point the **elevation itself**,
since that is derived from where the pins sit.

Three things are load-bearing:

- **A drag must not rebuild anything.** `dragstart` deliberately does *not*
  call `selectPin()` or `elevSelect()` — both re-render (the filmstrip, every
  marker), and rebuilding the element Leaflet is dragging kills the drag on its
  first move. It sets the selection directly and calls only the cheap repaints:
  `markSelectedMarkers()` toggles a class on icons that already exist, and
  `elevStatusUpdate()` just rewrites the pill's text. The marker's own
  highlight waits for `dragend`.
- **The inspector is outside the markers**, which is what makes the reference
  photo reachable at all (see the elevation notes below).
- **Opening or closing the column resizes the map**, which needs two things
  done together, in the same frame. Leaflet caches its container size, so
  `invalidateSize()` — miss that and you get grey tiles and mis-placed pins.
  But the column also pushes the map's left edge across the screen, and
  Leaflet knows nothing about that: every tile, pin and sketch slides with it.
  Tap a pin and the pin you just tapped jumps a column's width sideways; pick
  one up and it slides out from under your finger and *stays* offset for the
  whole drag, landing somewhere you never pointed at. `inspectSetOpen()`
  therefore reads the container's left edge either side of the class change
  and `panBy()`s the difference, which holds the ground still on screen and
  leaves the drag measuring the same pixels it always did. Reading the second
  edge is what forces the reflow — don't defer it into a `requestAnimationFrame`
  or the jump gets a frame to show itself.

**The column and the filmstrip follow you into an elevation view** — though
not into split screen, where the column is dropped (see below). There is
exactly ONE of each; `panelsSync()` moves them between `.mapwrap` and
`.elev-panel` rather than duplicating them. Both are plain DOM — no Leaflet, no
`<video>` — so re-parenting them is free, which is the same reason the map
itself gets moved into review. In a profile, tapping a plotted point opens it in
the column: each gets a fat transparent hit disc over its 5px ring, because
5px of stroke is not a thumb target.

**Both are preferences, not per-view state** (`prefs.inspector`,
`prefs.filmstrip`): turn the filmstrip off on the map and it stays off in an
elevation view too. Each toolbar carries a **Preview** and a **Filmstrip**
button writing the same preference, and Settings shows both — walking into
Settings to reclaim screen is not something anyone does mid-visit, which is
also why the gear now sits in the map toolbar as well as the elevation bar.
The inspector's own **×** is a one-off close and leaves the preference alone.

Renders during a drag are coalesced to one per animation frame; a drag fires
far faster than the screen — and within a photo pin's panel the **numeric rows
are rewritten but the note field is not**. Replacing a focused textarea drops
what is in it along with the caret, and a note typed but not yet blurred has
never been sent anywhere; the note and the download button are built once per
pin and left alone. The column is hidden while the map sits in
review's mini pane, same rule as the map toolbar — 190px has no room for it.

## Split screen: section over plan

**Stand the iPad on its end while the map is up** and the screen splits — the
section on top, the site plan underneath, the way a section and its plan are
read on paper. Turn it back and the split closes. `prefs.splitPortrait` governs
it and the **Split** button in the map toolbar does it by hand. Nothing is
duplicated: it is the one map and the one elevation panel, both already
`position:absolute`, told to take half the height each.

Sliding a pin down on the plan moves it in the section as you drag, not on the
drop — the section is right there above your thumb.

### The two halves share one scale

The section's horizontal is not *matched* to the plan's, it is **taken** from
it. `splitXform()` projects two ground points 100 ft apart along the section
axis through Leaflet and through the rotation, and the screen positions that
come back define the whole mapping — pixels per foot, and where a profile x of
zero lands. `evGeom()` then sets `sx` and `px` from that, so a point in the
section sits **directly above its own pin on the plan, to the pixel**, and
stays there through any pan or zoom. (The pivot is profile-x zero by
construction: `localEN(cutPivot)` is `(0,0)`, so its dot with the along-axis is
zero whatever the rotation.)

Derive it and the two halves cannot drift apart. Match it — set both to the
same number and hope — and they will, at the first fractional zoom or the first
re-fit. The section therefore redraws on `map.on('move zoom')`, every frame of a
pan, not just where it comes to rest.

**The plan owns the horizontal while split, and the section knows it.** Its own
`zoom` and `panX` are left untouched (they come back when the iPad is turned
flat), but ignored: an unlocked drag moves only the datum line, a pinch does
nothing, and Fit resets the vertical alone. Zooming the section independently
would put it into silent disagreement with the plan two inches below it, which
is the one thing this view must never do. The note says `scale locked to the
plan` and the lock button reads **Drag datum** so nothing looks broken.

**The preview column is absent while split.** Half a portrait screen is already
a short map, and taking a third of its width to show a photo of the pin you are
looking at is a bad trade. The preference is untouched, so the column comes
straight back when the iPad is turned flat again; the **Preview** button goes
away for the duration rather than sitting there doing nothing. The filmstrip
stays — it is a row, not a column, and it is what you use to find a frame.

### The plan turns to face the section

`mapRotFor(side)` turns the map so that **right on screen is the direction the
profile's x runs in**. That is the whole contract: slide a pin right on the
plan and it goes right in the section. East is screen +x and north is screen
−y, so the along-vector `(e, n)` points along screen `(e, −n)`, and rotating by
`atan2(n, e)` lays it flat on the +x axis. It falls out exactly as it should —
the **South** view (looking north) needs no rotation at all, and the **West**
view (looking east) puts east at the top.

**Leaflet 1.9 cannot do this by itself, and its CRS cannot be made to.** A
`Transformation` is `(a·x+b, c·y+d)` with no cross terms, so rotation is not
expressible. Rotating the *projection* would carry markers but hands the tile
layer coordinates that no longer match the XYZ scheme, and the satellite comes
back as garbage — which defeats the point of turning the map at all.

So the container is turned with a CSS transform, over-sized to
`w·|cos| + h·|sin|` so its corners still cover the clip, and the places that
convert screen coordinates to map coordinates are corrected. **There are
exactly two in Leaflet**: `Map.mouseEventToContainerPoint` (every click, tap,
pinch and box-zoom funnels through it) and `Draggable._onMove` (which does
*not* — it works on a raw client-space delta). Both patches hand back the
untouched original the moment the rotation is zero, so nothing that existed
before this is running on patched code. Our own screen→map conversions all go
through one `mapPt()` helper.

Four things learned the hard way, all of which looked right and were not:

- **Correct the pointer going in, not the position coming out.** `_onMove`
  hands `_newPos` straight to `_updatePosition`, so a correction applied
  afterwards lands after the uncorrected position is already on screen and
  already fired as a drag — the pin tracks the raw screen delta and you would
  swear the patch was not running. `_onMove` is now given a synthetic pointer,
  rotated about the drag's own start point, and Leaflet's own arithmetic does
  the rest.
- **`invalidateSize()` with its default pan, not `{pan:false}`.** Turning the
  map resizes the container; anchoring the top-left instead of the centre
  slides the survey out of the clip every time you change section.
- **A counter-rotation on a label must repeat that label's own transform.**
  `transform` replaces, it does not compose, so `rotate(...)` on `.elev-pin`
  silently dropped its `translate(-50%,-50%)` and shifted every pin by half its
  own label — a dragged pin then *appeared* to move in a direction it had not.
  Named classes only, for the same reason: a blanket `> *` would clobber
  whatever the next divIcon brings with it.
- **The pan compensation for the inspector column is in container space.** The
  column moves the map's edge along the *screen* x axis, so on a turned map the
  compensating `panBy` is that shift rotated into the container's frame.

Consequences worth knowing: the Leaflet zoom control and attribution are hidden
while turned (they would turn with everything else), and a static Esri credit
is drawn in the corner instead. A default `<img>` photo pin has no child to
counter-rotate, so it leans — its tip stays exactly on its own coordinate.

## My location is a toggle

The blue dot and its accuracy circle sit over the work, and a continuous
high-accuracy `watchPosition` is the most expensive thing the app asks of the
battery. **My location** centres on first tap and, once you are already
centred, turns the whole thing off on the next — graphics *and* `clearWatch`.

Nothing downstream depends on it: distance has never come from the live fix,
and entering grade mode takes a **one-shot** `getCurrentPosition` to seed the
observation, then lets the radio go quiet again.

## Settings

`prefs` is a small object of **UI preferences**, persisted to `localStorage`
under `upright.prefs` and the only thing this app writes to local storage —
session data is still RAM-plus-ZIP (see below). Every read and write is
wrapped: Safari **throws** on storage in private browsing rather than
returning null, and a thrown preference read must not be able to stop a
session starting.

The panel is reachable from the start screen, the done panel, and a gear in
both the map toolbar and the elevation bar — the last two because the start
screen is gone once a visit is under way, and because two of the three
preferences only show their effect from inside a view.

- **Vertical exaggeration** — off holds every section at ×1.
- **Preview column** — the pin inspector, on the map and in every elevation view.
- **Filmstrip** — likewise.
- **Split screen in portrait** — see *Split screen: section over plan*.
- **Eye height when shooting grade** — the `h` in `d = h / tan|θ|`, used only to
  park a just-shot pin. The one preference here that is a number, not a switch.

## Data durability — important

All Supabase writes are **fire-and-forget**. Failures are `console.warn`'d,
never surfaced, never retried. In-memory arrays (`pins`, `clips`, `sketches`,
`measures`) plus blobs are the source of truth for the *current* session —
but that's RAM only. No IndexedDB, no service worker, and no session
data in localStorage — the one thing stored locally is the **Settings**
preferences blob (see below), which is UI state and nothing else.

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

**The reference photo lives in the inspector column** (see *Pin inspector*
below), not in a popup on the pin. That also retired a nasty bug: tapping a
pin calls `elevSelect()`, which calls `elevRenderAll()`, which destroys and
rebuilds every marker *during the click* — so the popup Leaflet was opening
belonged to an element that no longer existed, and the photo silently could
never be seen. Nothing the inspector shows lives in an element Leaflet is
free to destroy, so the problem cannot come back.

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
inspector falls back to it if the Storage URL fails to load.
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

No compass is needed for any measurement — bearings come from map geometry,
which sidesteps iOS compass calibration entirely. What the compass *is* used
for, strictly as evidence, is below.

### The compass, as evidence

The rule is unchanged and load-bearing: **no elevation is ever computed from
the compass.** Distance comes from where the pins sit, angle from the tilt
sensor. A recorded heading buys two things the maths cannot give you on its
own, and a bad compass makes both worse without making any measurement wrong.

**The parking spot.** Stand at a known height above flat ground, sight
something *on* that ground at a depression angle, and the horizontal distance
falls out: `d = h / tan|θ|`. With the compass giving the bearing, that is a
coordinate — so a just-shot pin lands roughly where it belongs instead of on a
fan. `prefs.eyeHeightFt` (default 4.5 ft) is the assumption; Settings exposes
it, because chest height against eye height is a 30% difference in distance.

**It contains no elevation information whatsoever, and this is the thing to
understand about it.** The estimate assumes a flat plane, so an elevation
derived from an unmoved pin just hands that assumption straight back:
`d·tan θ` = `(h/tan|θ|)·tan θ` = `−h`, every time. Difference that against an
anchor parked the same way and **every target reads exactly `0.00'`**. It is
circular, not approximate.

That cuts both ways. An untouched survey reads dead flat, which is instantly
recognisable — it does not read plausibly-wrong. But a *nudge* sets `placed` and
yields near-zero numbers that look like small real ones, and neither existing
check catches it: the bearing cross-check stays silent because the pin is on its
bearing by construction, and a distance error is only caught by shooting the
same target from a second stance. Hence three rules:

- **Nothing here sets `placed`.** A parked pin still says *place pin*, never a
  number.
- **The sight line stays drawn until the pin has moved more than
  `PARK_MOVED_M`** (1.5 m) from where it was parked — a standing reminder that
  this one is not measured yet. `pt.parkedAt` records the spot; it is not
  persisted, since an archived session's pins are all placed already.
- **A placed-but-barely-moved pin is labelled `barely moved`** and its number
  carries a caveat, rather than being refused — an estimate that happened to be
  right needs only a small correction, and refusing it would punish that.

**The height stops being an assumption after the first real placement.** Once a
pin has genuinely been moved it *measures* the height that shot it —
`h = d_map · tan|θ|` — so `measuredEyeHeightFt()` takes the median across the
placed, moved pins of that stance and later pins are parked from that instead.
Unmoved pins are excluded on purpose: each would return exactly the assumption
and dilute the median with it. The height is per-stance, so a new observation
starts from the setting again.

Two guards, both necessary:

- **Level or upward sights nothing on the ground** — a gutter, a wall top, a
  tree — so no distance is derived and the old fixed parking is used.
- **`EST_MIN_DOWN_DEG` (2°) and `EST_MAX_M` (90 m).** At 0.5° the formula parks
  a pin 515 ft away.

Error grows as `2Δθ / sin 2θ`: about ±10% at 26 ft, ±20% at 51 ft, ±33% at 86 ft
and ±50% at 129 ft for one degree of angle noise — good close in, poor far out.
Because the bearing is separately known, what is left is an error *along* the
ray, which is a one-dimensional drag to correct.

**The sight line.** Every shot stores the heading it was taken at
(`upright_elevation_shots.heading_deg`, plus iOS's own
`webkitCompassAccuracy`). An unplaced pin is therefore constrained to a ray out
of its observation, drawn dashed on the map — placing it becomes one question,
*how far along this line*, instead of two. The ray disappears once the pin is
placed.

**The bearing cross-check.** Once a pin is placed, the bearing it now implies
can be compared with the bearing its shot was actually taken at. Until now the
only real check on a misplaced pin was shooting the same target from a second
observation, which is why a single-observation point is labelled *unverified*;
this is a second, independent check for the cost of one column.

The useful part is the pattern, not the number:

- A **consistent** offset across a set is the compass being out — declination
  it failed to apply, a phone case, a calibration it never did. Harmless, and
  subtracted. `headingDeltas()` collects them and `medianAngle()` takes the
  middle one.
- A **single** point disagreeing with its own set is a pin in the wrong place.
  Beyond `HEADING_FLAG_DEG` (15°) it is flagged: the survey pill names it
  without anything being opened, the inspector says the pin is the likely
  fault, and the sight line comes *back* in red — so you can see where the shot
  pointed and where the pin actually is.
- **Three sightings** is the minimum that can tell those two apart. Below it
  the raw figure is reported with no verdict, rather than a verdict being
  invented.

The median is taken about the circular mean so it survives the wrap at ±180°
and still ignores an outlier — which is the entire point, since the outlier is
the thing being hunted.

Note the check only ever speaks about **bearing**. Sliding a pin further out
along its own ray is a distance error and it stays quiet, correctly: distance
is what the two-observation cross-check catches.

**`compassBearing()` is deliberately not called `bearingDeg()`.** That name was
already taken by the *screen* bearing the slope arrows are drawn at, and since
both are function declarations the later one silently wins. The collision cost
an hour: every check still came out right, because the two differ by a constant
90° and the set's median offset absorbed it, but the reported figure was
nonsense.

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
- **Gestures are re-anchored whenever the finger count changes.** Lifting one
  of two fingers used to leave a two-finger start being measured against
  one-finger data — scale collapsing to 1 and rotation to 0 in a single frame,
  which is the jump you feel. Renders are also coalesced to one per animation
  frame; `evRender()` rebuilds the whole SVG and a touchmove can outrun the
  screen.
- **Level lines** draw a horizontal red read-across at each point's elevation,
  so a measured height can be carried straight onto an imported facade photo.
- **The scale locks and unlocks** behind a padlock. Locked by default, so a stray drag cannot
  move the datum. Unlocked, the stage pinches to zoom and drags to pan — the
  vertical component of a pan is what moves the anchor line up and down. **Fit**
  returns to the automatic framing. Zoom runs 0.05×–60×, which is what makes it
  possible to get far enough out to see the edges of an imported photo.
- **One thing owns the stage at a time.** `evTool` is a single variable —
  `uniform` / `stretch` / `distort` — and an unlocked view scale clears it.
  They are mutually exclusive, including on import, which hands the stage to
  the image and re-locks the view. Two claimants would leave a lock button
  reading a lie.
- The horizontal fit is taken from **all** points, not the visible subset, so
  changing visibility mode does not jump the framing under you.
- **Vertical exaggeration is unavoidable and is always announced.** A yard with
  a 6 ft fall over 200 ft is a flat line at true proportion, so the view
  auto-picks a starting exaggeration and says which (`vertical ×3`) or says
  `true proportion`. It is then a **continuous, log-spaced slider** (0.2×–60×),
  not a stepped cycle: stepping re-snapped the whole drawing mid-pinch, which
  is what made the view feel jumpy. It can also be **switched off
  outright in Settings**, which pins every section at ×1; that path writes
  nothing to any view, so each side's own factor survives and comes back when
  it is switched on again. The slider hides while it is off rather than
  sitting there inert.
- **Auto-exaggeration is resolved once and then held**, and is measured from
  **all** points rather than the visible subset. Left to recompute it steps as
  the zoom changes and the vertical scale snaps under your fingers; measured
  from the visible subset, a view whose own cut currently hides everything
  freezes a value computed from nothing. **An overlaid photo only aligns at
  ×1** — the tab shows the factor at all times so an exaggerated profile can
  never be mistaken for a measured one.
**The four cuts are placed at the four walls; the rectangle they leave is the
house footprint** — drawn on the map (`cutFootprint()`), so you can see the box
you are squaring. The default box is deliberately **small**, not sized to
bracket the survey: a box that swallowed every point would open every elevation
view empty.

**Each view looks toward the house and has three visibility modes**, cycled on
one button:

- **Beyond cut** (default) — strictly what lies beyond this view's own plane.
  The north view shows what is north of the north cut. A point inside the
  footprint is behind all four planes and appears in no view at all.
- **Line of sight** — hidden only by what the *house* actually blocks: a point
  is dropped only if it is behind this cut **and** inside the lateral band
  between the two perpendicular cuts. Standing south looking north you still
  see past the house on both sides, and down the side yards — which is what you
  would really see.
- **X-ray** — everything, wherever it sits.

A point in the NE corner is north of the north cut *and* east of the east cut,
so it appears in both those views. That follows from the rule and is intended.

Anything drawn that is **not** strictly beyond its own cut is **faded**, in
every mode, so a looser mode can never quietly pass itself off as a clean
section. The note reports `N of M points` and names the mode when it is not
the strict one.

**Images are placed by four corners, in view coordinates (feet along, feet
up).** Four corners is a full homography, which is exactly what a facade
photographed from the ground needs; a drawing just uses a rectangle.
`quadMatrix()` is the classic unit-square-to-quad solve, pre-scaled by the
image's own pixel size and emitted as a CSS `matrix3d`.

**Three tools, in this order: Uniform, then Stretch, then Distort.** An import
lands in **Uniform** — one finger pans, two fingers pinch and twist, exactly as
importing a plan on the map does. Only then do you pull the shape about.
Distorting straight from a default rectangle means fighting the position and
the distortion at once.

- **Uniform** applies a similarity transform to whatever the four corners
  currently are — so it moves an already-distorted image without un-distorting
  it, and the order can be revisited freely.
- **Stretch** is freeform, as Procreate and Morpholio Trace mean it: a handle
  on each of the four **edges** and one on each **corner**. An edge handle moves
  both its endpoints along that edge's **normal only**; a corner handle resizes
  *both* axes at once about the opposite corner. Either way the sides stay
  parallel — it stretches, it does not shear, and shearing is what Distort is
  for. The corner maths is done in the shape's own frame (the two edge vectors
  meeting at the fixed corner, and the pointer decomposed in that basis), so it
  still behaves on a shape a tilt or a Distort has already thrown out of square.
  Stretch's handles are gold, square corners and bar edges, against Distort's
  round blue dots — at arm's length on a bright screen two round handles look
  identical.
- **Distort** is the four corner handles, free: the full homography.

Alongside them, three **parametric nudges** — what the iOS crop screen calls
tipping the photo forward/back and left/right, plus straighten:

- **Tip** and **Turn** are keystones: scale one edge up and the opposite edge
  down about the shape's own centre line. That is exactly what tilting a plane
  about a horizontal or vertical axis does to its outline, and the four corners
  already carry a full homography, so it is only a parametric way of moving
  them.
- **Straighten** rotates about the shape's centre, ±15°, without resizing it.
- All three are **relative, not absolute**, and spring back to centre on
  release. Distort can move a corner anywhere between two adjustments, so there
  is no base rectangle left to state an absolute tilt against; each drag works
  from a snapshot taken when it started.

**Reset shape** returns the image to the default rectangle. A mangled placement
has to be recoverable without re-importing — re-picking the file off the camera
roll in a yard is not a real option. **Fade** is the per-image opacity, which
was stored all along but had no control.

A **mesh warp** (Procreate's Warp, Morpholio's Distort 3D) is deliberately not
here: CSS `matrix3d` expresses exactly one homography, so a warp would need a
subdivided mesh drawn to canvas or WebGL. A facade is planar, so the homography
is the correct model for it anyway.

The gesture maths is done in **screen space and mapped back to view feet**:
with a vertical exaggeration in play, feet-per-pixel differs by axis, and a
pinch has to feel uniform under the finger.

**The two stage `<img>` are shared by all four views** — `evOpen()` re-points
their `src` on every switch. Parking a one-shot import handler on one of them
therefore fired it again the next time you returned to that view, with the
*original* import's variables still captured: it recomputed the default
rectangle over whatever you had carefully placed, and re-uploaded the file for
good measure. That is why an adjustment did not survive a view switch.
Measuring happens on a throwaway `Image()` now. The only handler those two
carry is a repaint, which they need because `evPlaceImg()` reads
`naturalWidth` and a freshly-pointed `src` has none yet — without it a reopened
view showed no image at all until something else forced a render.

`evCornerHandles()` **repositions the handles, never rebuilds them.** A drag
holds pointer capture on the handle; replacing the element mid-drag drops that
capture and with it every later move and the pointerup that saves the result —
the same trap that once made elevation reference photos unreachable on the map. `evEdgeHandles()` follows the same rule.

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
- More of the compass ideas: a heading-up map (cheap now the rotation
  machinery exists), auto-selecting the section you are standing in front of,
  squaring the cuts to a wall by pointing at it, and view cones on photo pins.
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
- Perspective/skew correction for plans photographed at an angle **on the
  map**. The elevation views have the full tool set (Uniform / Stretch /
  Distort plus Tip / Turn / Straighten); the map's plan overlay still only
  pinches, twists and drags.
- ZIP **import** to view old sessions offline. The ZIP already contains everything needed (audio, clips + offsets, photos + offsets, GeoJSON) — except the transcript, which lives only in Supabase. Consider adding `transcript.json` to the export.
- Retry logic / sync-later indicator for failed uploads.
- Client-facing deliverable (PDF or web page vs raw GeoJSON/ZIP).
- Text labels on the map; richer desk-side annotation editor; reference-object photo measuring.

**Needs field testing**
- Split screen on a real iPad: whether half a portrait screen is enough map to
  place a pin in, whether the turned plan reads naturally or disorientingly
  against a yard you are standing in, and whether the split opening itself on
  every turn of the iPad is welcome or a nuisance.
- The pin inspector against a real yard: whether 34% of the map is the right
  width on an iPad in both orientations, whether the photo is big enough to
  match a pin to a place at arm's length, and whether losing that much map
  while dragging is a fair trade for never having a bubble over the pin.
- Sketch/Measure accuracy against known dimensions.
- 58px sidebar buttons with a gloved thumb; marker base size (30% of screen); yellow marker visibility on sunny turf; stroke weight at 3× zoom.
- Extent-lock button reachability; whether the filmstrip eats too much map
  height in landscape — the answer now has a switch either way, so the question
  is whether people find it.
- Audio level in real field conditions.
- Elevation accuracy against a known drop (a step, a wall course, a kerb).
  The maths is verified against an independent calculation; what is unproven
  is whether a handheld iPad can be sighted steadily enough for the numbers to
  mean anything, whether `STEADY_DEG` (0.4°) is a sensible gate or just
  annoying, and whether tapping your own standing position on the plan is as
  easy in a yard as it is at a desk.
- Whether the two-observation cross-check actually catches bad pins in
  practice. It is no longer the *only* accuracy signal — the bearing
  cross-check is a second one — but it is still the only one that catches a
  distance error.
- Pin parking against a tape measure: whether `d = h/tan|θ|` really lands
  close enough to be worth having at yard distances, and whether a plausible
  parking spot tempts anyone into leaving pins where they fell despite the
  sight line and the *barely moved* label.
- The bearing cross-check against a real compass: whether iOS's heading is
  steady enough for `HEADING_FLAG_DEG` (15°) to catch real mistakes without
  crying wolf, and whether a set's median offset really is as consistent as the
  method assumes once you have walked around a yard with a metal-cased iPad.
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
