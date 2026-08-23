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
`POST /sessions/:id/audio|clips|photos|sketches|measures|plan|elevations`,
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

### Relative elevation shots

Sight two points from **one standing position**: an *anchor* (your zero) and a
*target*. Height above the device is `d·tan(angle)` for each, so the answer is
`d_t·tan(θ_t) − d_a·tan(θ_a)`. The device's own height off the ground cancels,
which is why `upright_elevation_shots` stores no instrument height and why the
result is **relative to the anchor** — there is no absolute datum.

**Distances come from tapping the map, never from walking to each point.**
This is the whole accuracy story and it is not a detail. GPS is 3–5 m; two
differenced fixes at 30 m range swing the answer by roughly **±3 ft**, which
is worthless for grading. Tapped against an aligned plan overlay, the tilt
reading becomes the only meaningful error term (still ~1.7 ft per degree at
30 m, hence the averaging below). If you ever "simplify" this to use the GPS
fix for the observation point, you have thrown the feature away.

The angle reuses the existing tilt: `handleOrientation` computes 0 flat (rear
camera pointing straight down) and 90 upright (camera horizontal), so the
camera's elevation above horizontal is **`tilt − 90`**. Samples go into a
rolling buffer and a capture averages the last `TILT_WINDOW_MS` (800ms) to
take out hand shake.

Two things that are load-bearing, both found by testing rather than reasoning:

- **Elevation mode survives going upright.** `showMap(false)` cancels the
  active map mode — correct for sketch and measure, fatal here, because the
  workflow *is* tap-flat-then-stand-up. It now explicitly skips `'elevation'`.
- **The result is shown in the sighting overlay, not the mode bar.** The mode
  bar lives inside `.mapwrap` and is hidden the moment you stand up, so
  putting the answer there would mean lying the iPad down to read your own
  measurement. The overlay's buttons become Save / Redo.

Also: `drawElevShot()` hangs a Leaflet layer off the record, and Leaflet
objects are circular — snapshot the POST payload *before* drawing or
`JSON.stringify` throws and kills the upload silently.

Backend (table + `POST /sessions/:id/elevations`) was deployed as
`upright-api` v11 before this client existed; `GET /sessions/:id` returns an
`elevations` array, and shots are restored with the rest of the archived
geometry.

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
- Absolute elevations. Shots are relative to their anchor only; there is no
  `anchor_elevation_ft`, so nothing ties them to a plan's spot elevations.
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
  The maths is verified; what is unproven is whether a handheld iPad can be
  sighted steadily enough, and whether tapping your own standing position on
  the plan is as easy in the field as it is at a desk.
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
