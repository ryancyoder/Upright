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

`upright_sessions` has nullable `event_id` / `deal_id` columns for linking to
the existing `events` / `Sales Board` tables later — deliberately deferred.

### Edge Function `upright-api`

Endpoints under `/functions/v1/upright-api`:
`POST /sessions`, `GET /sessions/:id`, `POST /sessions/:id/audio|clips|photos|sketches|measures`,
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
`in-mini` and **swap by class only — neither is ever re-parented**. That is
deliberate: moving a playing `<video>` in the DOM restarts it on iOS Safari,
and a moved Leaflet container needs a full re-init. Don't "simplify" this
into appendChild calls.

Two things that follow from it:

- Review has its **own Leaflet instance** (`reviewMap`, `#reviewMap`),
  separate from the live capture map (`map`, `#map`). One Leaflet map cannot
  serve two containers, and review must not disturb live session state.
- Leaflet caches container size, so every resize path calls
  `refreshReviewMapSize()` (pane swap, transcript appearing, window resize,
  orientation change). Skip it and you get grey tiles or mis-placed pins.

The map is driven by the playhead: `updateReviewMapForTime()` picks the
located pin nearest the playhead within `PHOTO_WINDOW_MS` — the same window
the photo rail highlights on, so the two always agree — then centres on it
and glows its marker. Tapping a map pin scrubs audio to that photo's offset,
mirroring the photo rail. When the transcript hasn't loaded yet,
`.review-body.no-transcript` gives the mini pane the whole left column.

**Not yet built**
- Session reload / browse past sessions. `GET /sessions/:id` exists but nothing calls it.
- ZIP **import** to view old sessions offline. The ZIP already contains everything needed (audio, clips + offsets, photos + offsets, GeoJSON) — except the transcript, which lives only in Supabase. Consider adding `transcript.json` to the export.
- Retry logic / sync-later indicator for failed uploads.
- Client-facing deliverable (PDF or web page vs raw GeoJSON/ZIP).
- Text labels on the map; richer desk-side annotation editor; reference-object photo measuring.

**Needs field testing**
- Sketch/Measure accuracy against known dimensions.
- 58px sidebar buttons with a gloved thumb; marker base size (30% of screen); yellow marker visibility on sunny turf; stroke weight at 3× zoom.
- Extent-lock button reachability; whether the filmstrip eats too much map height in landscape.
- Audio level in real field conditions.
- Review pane swap: whether 190px of mini pane is enough to read a video
  thumbnail or a map at a glance, and whether the map's auto-centring fights
  you when you try to pan it manually mid-playback.
- Longer-session soak test (30–60 min) — dual-stream recording plus continuous uploads.
- What happens if the iPad backgrounds mid-upload.
