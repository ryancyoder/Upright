# Upright — Site Session

iPad field tool for Ricci's Landscape Management (Hebron, IN). One
`index.html` (~210KB, no build step) plus the icons beside it —
`icon.svg`, `icon-32.png` and `apple-touch-icon.png`, which is the target
sight in `TARGET_SIGHT` red on the app's own ground. Three files because
different things read different ones: desktop browsers prefer the SVG, the
32px PNG is the fallback for those that will not take it, and iOS ignores
both for Add to Home Screen and wants `apple-touch-icon` as a raster. With
none of them Safari invents a letter tile from the title, which is where the
plain "U" came from.

The home screen LABEL still comes from `<title>`, so it reads "Upright — Site
Session" truncated. `apple-mobile-web-app-title` would shorten it; not set,
because that changes what the app is called rather than how it looks.

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
`upright_transcript_segments`, `upright_elevation_sketches`, `upright_objects`,
`upright_proposal_items`, plus `upright_catalog_items` (not session-scoped).
Storage bucket:
`upright-media`.

`upright_sessions` has a nullable `property_id` FK to the existing
`properties` table, and a nullable free-text `name` — see *Naming and deleting
a session* below for which of the two the history list leads with.
Nullable on purpose: a session must always be startable with one tap, so it
can be tagged afterwards from the history list. `event_id` / `deal_id` are
still nullable and still unused.

### Edge Function `upright-api`

Endpoints under `/functions/v1/upright-api`, as of v32:
`POST /sessions`, `GET /sessions` (history list), `GET /sessions/:id`,
`PATCH /sessions/:id` (assign property, set name), `GET /properties` (address picker),
`POST /sessions/:id/audio|clips|photos|sketches|measures|plan`,
`POST /sessions/:id/elevation-points|elevation-shots` (a shot carries
`headingDeg`/`headingAccDeg` — evidence, never input),
`POST /sessions/:id/elevation-slopes`, `DELETE /elevation-slopes/:id`,
`DELETE /sessions/:id` (cascades every child table, purges the session's
Storage prefix first),
`POST /sessions/:id/objects`, `PATCH /objects/:id` (attrs merged, not
replaced), `DELETE /objects/:id`,
`POST /sessions/:id/elevation-sketches`, `DELETE /elevation-sketches/:id`,
`PATCH /sessions/:id/elevation-views/:side`,
`POST|DELETE /sessions/:id/elevation-views/:side/plan|photo`,
`PATCH /elevation-points/:id`, `DELETE /elevation-points/:id`,
`DELETE /elevation-points/:id/shots` (all, or `?observationId=` for one
position's sightings), `POST /elevation-points/:id/photo`,
`PATCH /photos/:id`, `POST /photos/:id/image`,
`POST /sessions/:id/transcribe`, `GET /sessions/:id/transcript`,
`GET|POST /sessions/:id/proposal` (extract from the transcript),
`POST /sessions/:id/proposal-items`, `PATCH|DELETE /proposal-items/:id`,
`GET|POST /catalog`,
`GET /takeoff?property=&limit=` (MasterDash's drawn beds, rings pre-resolved),
`GET|POST /sessions/:id/property-match` (which yard the visit was recorded at),
`POST /properties/:id/coordinates` (backfill, refused if it already has some).

Requires secrets `ASSEMBLYAI_API_KEY` and `ANTHROPIC_API_KEY` (set in Supabase → Edge Functions →
Secrets — NOT Vault, and NOT Vercel env vars; neither reaches the function).
`ANTHROPIC_WORKSPACE_ID` is needed **only** if that Anthropic key is
identity-linked — see *The proposal helper* below.

If editing the function, pull current source with `Supabase:get_edge_function`
rather than reconstructing it. The source is vendored at
`supabase/functions/upright-api/` — **two files**, `index.ts` (routing) and
`proposal.ts` (the proposal helper's logic) and `match.ts` (matching a session
to a property by where it was recorded) — so edits are diffable.

**The vendored copy had drifted 14 versions behind what was deployed** and was
refreshed from the live function on 2026-08-29. It held 604 lines of a single
file against a deployed 995 + 393; deploying from it would have destroyed the
whole of `proposal.ts`, the elevation-cut fields and `purgeSessionStorage`.
Anything deployed from the dashboard or from another session lands here only if
somebody pulls it back, so **pull before you edit, every time** — the endpoint
list above is written from the source and is only as current as the last pull.
A deploy must send **both** files: the tool takes the whole file set, so
pushing `index.ts` alone deletes `proposal.ts` and every `/proposal` route with
it. Currently **v32**, deployed from this vendored copy on 2026-08-29 and
verified byte-identical to it afterwards.

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

### The estimator's take-off, as a reference layer

**Take-off** on the map toolbar draws the beds and runs from MasterDash's Plan
view — read-only, quieter than a pin, labelled with the assembly, the
measurement and the load count.

The rings arrive **already resolved** from `GET /takeoff`. MasterDash writes
its outlines into `quick_estimates.lines.takeoff` at save with any curved edges
worked out, so nothing here knows what a spline is. Two apps computing the same
bed's outline separately would eventually draw two different beds and price one
of them.

**Geography is the join, not the property.** One session in a hundred carries a
`property_id`, so matching on it would find almost nothing — but both apps now
hold the same lat/lng, so the client keeps whatever rings fall in the current
view (padded, so a bed just off screen still counts). The endpoint filters by
property when one is given and otherwise returns the newest few.

The pan handler is bound on **first use, not at load**. `map` is null until
`initMap()` runs and this is one long script, so a throw at load takes out
everything declared after it — which is most of the app. That is not
hypothetical: the first version of this did exactly that.

## The clips are H.264, by name

`pickVideoMimeType()` asks for `video/mp4;codecs=avc1.42E01E` before it asks
for bare `video/mp4`, and that ordering is the whole point.

**Bare `video/mp4` lets the device choose, and an iPad chooses HEVC** — its
hardware encoder's own format. Nothing looks wrong for a long time: Safari
decodes HEVC everywhere, so the clips play in the field, in this app, and in
Review. Then somebody opens the same session at a desk in Chrome or Firefox,
neither of which will decode HEVC, and every clip is a black rectangle
refused with `MEDIA_ERR_SRC_NOT_SUPPORTED`. That is exactly how it surfaced —
in MasterDash's review screen, with the master audio playing perfectly
underneath, because `audio/mp4` is AAC and everything plays AAC.

The specific profile goes first because Safari is fussy about the short form,
and bare `video/mp4` stays last, so a device offering neither behaves exactly
as it did before.

**It costs bitrate.** H.264 is roughly a third fatter than HEVC for the same
picture, which is a real cost on cellular under a fire-and-forget write model.
A clip nobody can open is worth less than a big one — and the cap below took
far more back than this gives away.

### And the bitrate is capped at 2.5 Mbps

`VIDEO_BITS_PER_SECOND` is a ceiling on the MediaRecorder, and the number it
replaced was measured rather than assumed: across the 95 clips on file the
**median is 9.5 Mbps** (p90 9.9), which is **71 MB for every minute** of
silent 720p footage of a lawn. That rate is paid three times — uploaded from a
yard on cellular, stored, and downloaded again *whole* by every desk-side
review, since MasterDash fetches a clip before it plays it.

2.5 Mbps is about 19 MB a minute, near four times smaller, and still ample for
what this footage is for: establishing where things are, not shooting a film.
It is a ceiling, not a target — a still shot of a bed encodes well under it.

**The resolution half was already right.** `startCamera()` asks for
1280×720, and the two together are what set the quality: raising the bitrate
to suit a bigger capture without changing that says nothing. Note the camera
stream is shared with photo pins and the crosshair snapshots, so its
resolution is not the clips' to choose alone.

**Beware the aggregate.** Total bytes ÷ total clip-window seconds says
2.0 Mbps, which is wrong by 5×: four clips carry windows far longer than their
own footage — 72 of the 92 recorded minutes sit in those four — and they drag
the mean down. The median is the honest figure, the same reason `match.ts`
takes a median of the pins. Those four windows are worth a look on their own
account: a clip whose window overstates its footage runs out early in review
and leaves a frozen frame.

**Every clip recorded before this is still HEVC and always will be** — the
ZIP export carries them too, so the same wall is waiting at the desk there.
MasterDash names the case rather than saying "unsupported format", and points
at Safari. Re-encoding the back catalogue would need a server-side transcode
and has not been built.

## Outlining a bed by aiming the iPad

An **alternative to the Apple Pencil**, not a replacement. Tap a take-off tile
that carries it — `OUTLINE_ASSEMBLIES`, currently mulch alone — and the app
takes the picture, holds it on screen, and hands you a crosshair.

**One button, three jobs.** Outside an outline the shutter takes a photograph.
Inside one, a **tap drops a corner** and a **hold drops the last corner and
closes the ring** — the final corner and the instruction to close are the same
thought, and walking the cross back to the first corner is a second aim for no
information. Coming back to the first corner still closes it, for anyone who
prefers that; it swells and fills when the cross is within `OUTLINE_CLOSE_PX`.

**The picture is captioned with the take-off it is of** — "Mulch Bed", across
the bottom — from the moment it freezes, and the caption is **burned into the
saved JPEG** along with the ring. That is what makes the photograph say what it
is of wherever it turns up: MasterDash's rail, the ZIP export, with nothing
there needing to know this feature exists. `OUTLINE_LABEL` describes the band
in fractions of the picture and is drawn twice from that one description —
on screen and onto the canvas — because those two surfaces are different sizes
(the screen shows it letterboxed to fit, the canvas is its full pixel
dimensions) and a caption that drifted between them would be a caption you
could not trust. It says the assembly alone, not the bed number; adding
`assemblyLabelOf()` there is one line if a yard with three mulch beds turns out
to need telling apart.

**The finished ring is held on screen for a second** (`OUTLINE_HELD_MS`)
before the camera comes back. Closing straight to a live preview gives you
nothing to check against: the one moment the outline is worth seeing whole is
the moment it is finished, and by then it was already gone. It is redrawn
**closed**, as a filled ring rather than the open trail that was being built,
and the crosshair goes — a cross still sitting on a completed outline reads as
though there is another corner to place. Every input is refused for that half
second, so a second tap cannot start marking into a ring that is already saved.

`SHUTTER_HOLD_MS` is 500, the same as MasterDash's tile grid and for the same
reason: long enough not to fire on a firm tap through a work glove. Two details
that are load-bearing rather than tidy — the `click` that follows a hold is
**suppressed**, or a hold would close the ring and then drop a stray corner
into the next one; and a hold with **fewer than three corners down just marks**,
because `outlineClose()` treats a short ring as a cancel and would throw the
outline away in the hands of somebody still learning the gesture.

**The cross does NOT take its centre from the pose the picture was shot at**,
and that was the first design's mistake. A bed is photographed with the iPad
held up; nobody wants to keep holding it there to draw. After the shutter the
app waits, and the cross centres on whatever posture the hand comes to rest in
— lowered, tipped back, however it is comfortable. Until then there is no cross
at all and nothing can be marked: showing one before it has a centre would
invite somebody to start marking against a reference about to move under them.

`OUTLINE_SETTLE_GRACE_MS` (700) is what lets you start moving before it decides
you have stopped; hold still through it and the shot's own pose is used, which
is the right answer for somebody who did not want to move. `OUTLINE_SETTLE_DEG`
is 2.5° — looser than grade's `STEADY_DEG` of 1.2° on purpose, since nothing is
being measured and the hand is coming to rest rather than aiming. Steadiness is
read from the **camera axis alone**, so rolling the iPad in your hands does not
count as movement — consistent, because a roll does not move the cross either.

**Re-centre**, in the outline's own bar, does the same thing on demand:
everything already marked stays exactly where it is (corners are screen
positions, not aims), so it is safe mid-outline and is the way out of both a
posture that has crept and a gyro that has drifted over a long ring.

**What that costs, stated plainly:** the *aim at a real corner and the cross
lands on it* property only holds while the posture matches the shot. Settle
somewhere else and the cross becomes a relative pointer from that rest pose —
which is the trade the hand asked for.

**The swing since the shot is projected through the lens's own field of view**
(`PHOTO_FOV_DEG`, 62°), so a turn moves the cross by as much of the picture as
that turn would have moved the camera. The projection is **pinhole, not
linear**: a point 20° off axis is not two thirds of the way to the edge of a
62° frame.

**Which way the cross runs is a PREFERENCE, one switch per axis in Settings,
and that is the finding rather than a cop-out.** It was guessed wrong twice —
once each way — before anybody held the thing. Following the aim (swing right,
cross right, where that thing sits in the picture already taken) and dragging
the picture under a fixed cross are both coherent; the geometry has no opinion,
and which one a hand expects is a habit. `outlineAimX` / `outlineAimY` default
to **on**, which is following the aim on both axes.

The axes are **separate switches because they are separate habits** — inverted-Y
with normal X is what a flight stick does, and was one of the combinations
asked for along the way.

**One axis and not the other is a MIRROR, not a rotation**, and that killed a
theory worth recording as dead. When both axes read backwards the obvious
suspect was the screen-orientation convention — an iPad's *natural* orientation
is landscape, so held in portrait it reports an angle rather than zero and the
correction turns the mapping by that much. A rotation cannot flip one axis
alone, so that was never it.

Because a mirror is possible, the sense is applied to the **screen** axes,
after the rotation, rather than to the device offsets before it: a half turn
commutes with a rotation and a mirror does not, so a device-space flip would
put the mirror on a different axis the moment the iPad was turned — while the
switch names a direction on the screen. `test62.js` pins all four combinations
and checks that one specifically, on a turned screen.

**It is an annotation, not a measurement.** The ring is in image pixels and has
no scale — nothing here knows how far away the bed is. Turning it into an area
would mean projecting each corner onto an assumed ground plane, which is the
same flat-earth assumption *The compass, as evidence* already calls circular.
The number would look real and be invented.

**The compass is irrelevant, and that is provable rather than hoped.** The
cursor is a pose *relative* to the moment of the shot, so a constant error in
alpha premultiplies both poses by the same rotation — and a rotation preserves
dot products, so it cancels exactly. iOS compass calibration cannot move this
crosshair. `test62.js` checks it at four different offsets.

**Roll invariance is the property most likely to be got wrong**, and gamma is
the trap: gamma is *not* roll. It turns about the device's own y axis, which for
an iPad held vertical is a **yaw**. Held vertical the camera axis obeys
`alpha + gamma` alone, so a genuine roll is the pair moving together and
cancelling. `test62.js` pins both halves — that a real roll moves nothing, and
that gamma alone does move it, so the first check cannot pass by everything
being frozen.

Three conventions the test had backwards before it was believed, all derived
from the matrix rather than assumed:

- **Alpha turns LEFT.** It is counter-clockwise about the up axis, which is why
  a heading elsewhere in this file is `360 − alpha`. Adding to it swings the
  camera west, so the cross moves left.
- **Beta past 90° aims UP.** Below 90 the axis has a downward component.
- **Gamma is a yaw when the iPad is vertical**, per above.

`test62.js` lifts `orientBasis()` and `outlineProject()` **out of `index.html`
by source** rather than copying them, so it checks the code that actually runs.
25 checks, no browser.

**And test62 was not enough, which is the lesson worth keeping.** It proves
where the crosshair *should* be to fourteen decimal places; it cannot see
whether the crosshair is on screen at all — and it was not. The overlay `<svg>`
carried `position:absolute; inset:0` and no width or height, so it resolved to
an SVG's **intrinsic 300×150**, dropped `right`/`bottom` as over-constrained,
and clipped away every mark drawn where the picture actually is. Worse, the
coordinates were computed with `getBoundingClientRect()` — viewport space —
while an SVG's user space starts at its own top-left, so everything was also
53px out, the height of the header above the stage. The maths was right and
nothing appeared.

That is the flow-arrow lesson again: *the maths was verified and the rendering
was not*. `test63.js` drives the real UI in a real browser and reads the
RENDERED elements — is the cross inside its own overlay, does the hint change
on returning to the first corner, does closing put the camera back. Supabase
and the Leaflet CDN are stubbed; nothing it tests touches either. Run it with
`NODE_PATH=$(npm root -g) node test63.js`. 14 checks.

It also caught a second thing on the way: **the tiles were showing over the
map**, where tapping one would have frozen a picture behind it. They are
gated on the camera being up now.

### Snapping corners to detected edges

**Edges** in the outline's bar (and a switch in Settings) draws the boundaries
the camera can find over the frozen picture and pulls the cross onto one when
it comes within `EDGE_SNAP_PX` (24, about a thumb's wobble).

It shipped in two steps, and the first one *drew the edges and did not snap* —
deliberately, to answer the question that decides whether snapping is worth
building at all: **does a bed edge actually light up in a real yard?** It does,
on the first try in the field, so the snap followed immediately. Worth being
honest that a hint layer with nothing attached to it is not a feature and did
not read as one; the diagnostic was right, shipping it as though it were the
answer was not.

**Colour, not luminance.** Mulch against grass is a large colour difference and
frequently a small brightness one — dark brown and shaded green sit at much the
same luminance — so the classic grayscale Sobel misses the one edge that matters
here while finding every shadow. The gradient is taken across all three
channels.

**Half resolution, and the blur is a feature.** Grass at full resolution is a
field of tiny gradients; downsampling averages that away while leaving a bed
edge exactly where it was. It is also four times cheaper, which more than pays
for the three channels: measured at **11 ms** on a 720p frame against 46 ms for
a full-resolution luminance pass. One-time, on a picture that is already frozen.

**The threshold is a percentile, not a number** (`EDGE_KEEP`, the top 5.5%). A
fixed one would be right in one photograph and wrong in the next — flat light
and hard midday sun differ by more than any constant survives. Alpha rides the
strength above the cut, so a firm boundary reads solid and whatever squeaked
past stays a whisper.

**The snap is STRONG AND NEAR, not strongest.** Scoring on strength alone would
let a hard shadow line at the edge of the reach beat the bed edge under the
cross, which is exactly how a snap earns a reputation for fighting you. The
distance term falls to zero at the limit, so nothing at the rim can ever win.

**What will be marked is where the cross is.** The cross moves onto the edge
and takes its colour rather than a second marker appearing beside it — there is
never a question of which of two things the shutter is about to take — and the
raw aim stays on screen as a small hollow dot, which is what explains the move
rather than leaving the cross feeling like it drifts. Aim away and it lets go.

That is the *snap versus align* rule from the elevation grid, honoured rather
than broken: the objection there was silently moving a point somewhere the user
did not put it. Here the move is visible, refusable, and onto the subject
itself rather than onto an arbitrary aid — and an outline is an annotation, not
a measurement, so nothing is being rounded to fit a drawing aid.

**What is NOT built, and why.** Hough lines would find edging, walks and drain
runs — but a bed is curved, so the classic tool is the wrong instrument for the
main case; it belongs with the linear assemblies if it is built. A segmentation
model that actually knows what mulch is means megabytes of weights in a
single-file app used where there is no signal.

**The ring is burned into the photograph**, exactly as the pencil editor's
strokes are and saved by the same route (`POST /photos/:id/image`), so it shows
wherever the picture does — MasterDash's review rail included — with nothing
else needing to know this feature exists. What it does **not** do is keep the
corners as data, so a ring cannot be re-edited; storing the points is the
obvious next step if that is wanted.

Smaller things that are load-bearing:

- **`object-fit:contain`, not `cover`.** The live preview crops, which is right
  for framing and wrong here: the outline belongs to the picture that gets
  saved, so the whole of that picture has to be on screen while it is drawn.
  Every screen↔image mapping goes through the letterboxed rect.
- **The frozen frame sits at `z-index:5`** — above the video, below the shutter
  at 6 — so the shutter draws over it and stays tappable with none of the
  `pointer-events` juggling the sighting HUD needs.
- **One tap, one outline, one bed.** The tile disarms on close, so the next
  photograph does not join the bed just finished.
- **Cancel keeps the photograph.** It is a picture of the yard whether or not
  anybody drew on it.
- **Outlining pins the tilt switch**, the way grade mode does: the whole gesture
  is aiming the iPad about, and handing the screen to the map halfway through
  would be unusable.
- An outline closed before the photo's own POST returns has no id to save
  against; the ring is sent when the id lands rather than dropped.

**Needs field testing, and one thing needs it before it can be trusted:** the
**screen-rotation correction**. Device axes are not screen axes once the iPad is
turned, so the offset is rotated by `screen.orientation.angle`. The behaviour is
pinned by a test, but the *sign* of that rotation has only been reasoned about —
in portrait it does not arise, and in landscape it may need inverting. Also
unproven: whether 62° is close enough to the real lens for the cross to land
where you are actually pointing, whether the 0.28 smoothing is steady enough at
arm's length, and whether gyro drift is noticeable over the half-minute an
outline takes.

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

### One shared bar on the divider

Everything that belongs to **both** halves at once lives in a single row sitting
on the split line: the five-way switch (Top / North / South / East / West),
**Sketch**, and **Fold**. Neither half keeps its own copy while the split is up,
so there is one of each control on screen and no doubt about which surface a tap
lands on — the elevation bar's tab row, the map toolbar's Sketch and Fold, and
the elevation bar's Sketch and Fold are all stood down.

There is exactly ONE five-way switch; `panelsSync()` moves `#viewSwitch` into the
bar and back, the same trick the inspector and the filmstrip use, and for the
same reason: it is plain DOM, so re-parenting is free. The two halves back off
by half the bar's height each rather than letting it float over them — half a
portrait screen is short enough already.

**Top means the plan on its own**, which in split is the split closing. It sets
`splitManual=false` first, or the portrait gesture reopens it immediately.

**Sketch is ONE state while split, not two.** The two surfaces are one drawing
job seen from two angles — a wall goes on the plan and its height goes in the
section — and arming each half separately means half your strokes land on a
surface that was not listening. So both are in sketch mode or neither is, and
opening the split while either was already armed arms both: if you were drawing
on the map when the iPad was turned, you meant to keep drawing.

It is also **just a toggle**. Outside split each surface carries its own bar of
Undo / Finish / Cancel; in half a portrait screen that is a panel sitting on the
drawing, and there is no "finish" to press when the mode is a switch. Note what
that costs, since both are reachable again the moment the iPad is turned flat:
**Undo and the colour swatches are not available while split.**

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

**But the filmstrip is shrunk, not clipped.** A `max-height` on its own left the
172×128 tiles running out of the bottom of a 120px strip with `overflow-y:hidden`
— a set's frames were cut in half and the group's controls were simply gone, so
half the strip's function went with them. Everything scales together instead
(tile, badge, buttons, the group box) and the strip is then exactly as tall as
what is in it: **195px → 127px**, about a third of the height back to the map,
with nothing hidden.

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

## My location is a three-tap cycle

The blue dot and its accuracy circle sit over the work, and a continuous
high-accuracy `watchPosition` is the most expensive thing the app asks of the
battery. The button cycles **off → centred, north up → centred, heading up →
off**, which is the cycle a phone map has, so nobody has to learn it. Turning it
off is graphics *and* `clearWatch`.

**A tap after the view has moved re-centres instead of advancing**, in whichever
mode you were already in. Having to tap twice to get back to yourself — and
losing heading-up on the way — is not what that tap meant.

### Heading up

**The heading is the device's TOP EDGE, not the camera.** `deviceTopBearing()`
is the same orientation matrix as `cameraBearing()`, a different column: device
+y is the second, so the top edge lands on the ground at `(-cos β·sin α,
cos α·cos β)`. The two are the ends of one problem — `webkitCompassHeading` is
*wrong* for the camera when the iPad is held up, and *right* for the top edge
when it is laid down — and the map is only ever used flat. Gamma does not appear
at all, which is correct by construction: rolling the iPad about its own long
axis does not change where its top edge points.

**The map turns by `−heading`**, since north started up. That is the same
`mapRotApply()` split screen uses, so the counter-rotated pin labels, the two
patched Leaflet input paths and the hidden zoom control all come for free.

**One function owns the rotation**, so the two claimants can never fight over
it. `mapRotSync()` gives it to **split screen** whenever the split is open —
that is the split's entire contract, that sliding a pin right on the plan moves
it right in the section, and a heading-up map would break it. Heading-up stands
down for the duration and gets it straight back when the split closes; that is
why `setSplit()` calls `mapRotSync()` rather than `mapRotApply(0)`.

**Smoothed, then gated.** `mapRotApply()` resizes the container and invalidates
the map, so turning it on every compass reading would be both jittery and
expensive. The raw bearing goes into a circular mean over 8 samples, and the map
only turns once that mean has moved `HEADING_UP_DEG` (4°) and at most every
`HEADING_UP_MS` (180ms). Standing still costs nothing.

**A turned map has lost *up is north*, so it says where north went.** A needle
in the corner, outside the rotated container (it has to hold still on screen),
drawn at `mapRotDeg` because north started up and the map turned by that much.
It shows for *any* rotation, so a split screen facing a section gets it too.

Note the placement trap, the same one `syncGridBtns()` hit: `syncCenterBtn()`
runs at the top level a few hundred lines above where the orientation code
lives, so the heading-up state is declared up with `mapRotApply()` rather than
down beside `handleOrientation()`. Read from up there it would be a temporal
dead zone throw, and that takes the entire script with it.

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
- **Fold drawings between views** — see *Folds* below.
- **Ground line in sections** — see *The ground line* below.
- **Preview column** — the pin inspector, on the map and in every elevation view.
- **Filmstrip** — likewise.
- **Split screen in portrait** — see *Split screen: section over plan*.
- **Outline cross follows the aim — sideways / up and down** — two switches, one
  per axis. See *Outlining a bed by aiming the iPad*.
- **Snap corners to detected edges** — draws them, and pulls the cross onto one
  within a thumb's width. Visible and refusable; see above.
- **Eye height when shooting grade** — the `h` in `d = h / tan|θ|`, used only to
  park a just-shot pin. The one preference here that is a number, not a switch.

## The window holds still

**Nothing zooms or scrolls the app itself.** It is held in one hand in a yard:
a stray second finger must not be able to leave the shutter half off the
screen, and a drag that misses the map must not bounce the whole page. What
still moves is what the app owns — the Leaflet map, the section stage, the plan
overlay, and the panels that scroll their own contents (start, done, Settings,
history, transcript, and the strips that scroll sideways).

It takes four separate things, because no one of them covers the others:

- `overflow:hidden` on `body` — the page has no scroll to begin with.
- `overscroll-behavior:none` on `html` and `body` — no rubber-band at the end
  of any scroll chain.
- `touch-action:manipulation` on `body` — no double-tap-to-zoom. Children that
  need finer control set their own (`.ev-stage` is `none`).
- **`gesturestart` / `gesturechange` / `gestureend` are refused in script.**
  This is the one that actually stops Safari pinching the window, and the
  reason it is safe is that those are WebKit's own two-finger events, **separate
  from the touch events** Leaflet, the section stage and the plan overlay pinch
  with. Blocking them costs the app no gesture it owns. Note what does *not*
  work: iOS Safari has ignored `user-scalable=no` since iOS 10 (it is in the
  meta tag for everything else), and `touch-action` does not govern Safari's
  pinch. The listener must be non-passive or `preventDefault()` is a no-op.

**And the page zoom no gesture blocker can catch: a focused text field.** iOS
zooms the whole window in when a field smaller than **16px** takes focus, and
three were under it — the pin note at 13, the address search and the eye-height
box at 15. All three are 16px exactly now. Any new field has to be too, or the
app will zoom the moment somebody types in it.

Worth knowing this is a deliberate accessibility trade: pinching to magnify
text is gone. For a single crew on a known iPad that is the right side of the
trade, but it is a trade.

## Only the pencil draws

**A pinch used to lay down a stroke with each finger while it zoomed.** Any
pointer drew, so two fingers spreading across the map wrote two lines and
uploaded both — measured against the old build, one pinch plus one finger-pan
left three strokes on the plan and a fourth in the section.

The rule now: **touch is never a drawing input.** Fingers pan and pinch exactly
as they do outside sketch mode. `isDrawInput()` is the single gate and it admits
`pen` and `mouse` — the pencil in the yard, and a mouse at a desk, where there
is no pencil and no pinch to confuse it with. On the iPad no mouse events are
generated at all, so admitting it changes nothing in the field.

That freed the constraint the section was working under. Sketching used to have
to hold the whole stage (`evGestArmed()` returned false) because a finger both
drew and panned and one of them had to go; a stroke is a pencil and a pan is a
finger now, so an unlocked section can be pinched about while the pen is
drawing on it. A drawing input still belongs to the sketch rather than the
gesture, or a mouse at a desk would pan and draw at once.

**The map's dragging is enabled during sketch mode now**, and stood down only
for the length of a stroke. That ordering is the load-bearing part:

- Leaflet drags off `touchstart mousedown`, **never `pointerdown`** — and on iOS
  the Apple Pencil fires touch events as well as pen ones, so a pencil stroke
  would otherwise pan the map underneath itself.
- Pointer Events dispatches `pointerdown` **before** the compatibility
  `touchstart`/`mousedown`, so `holdMapDrag(true)` inside the pointerdown
  handler lands in time for Leaflet's own handler to find dragging already
  disabled. This is why it is not simply a flag checked later.

Both surfaces also pin the stroke to the `pointerId` that started it, so a
finger landing mid-stroke is a pan rather than a continuation of the line.

One trap on the way, worth keeping: the map's sketch listeners were briefly
moved to the **capture** phase to get ahead of Leaflet. They must not be.
`pointerleave` does not bubble, so a bubble-phase listener on the container
never sees a descendant's — but a capture-phase one does, and the pointer
leaving the path it had *just drawn* ended every stroke on its second move.
The phase buys nothing anyway: Leaflet drags off `mousedown`/`touchstart`, and
`pointerdown` precedes both by event type whatever the phase.

## The ground line

Connect the points you actually shot, in order along the cut. That is all it is
— 1D interpolation along one line — and the split between measured and assumed
is the whole point of it:

- **The vertices are measurements.** Each is a point you sighted, at the height
  `elevationOf()` derives live.
- **The segments are assumptions.** Between two shots the ground is drawn as a
  straight ramp, so a swale or a mound in the gap does not show at all.

**It is never extrapolated.** The line starts at the first point and stops at
the last; past them the app has nothing to say and does not say it anyway.

**The honesty problem it has to carry:** a section shows points *near* its cut,
not on it, so two points 30 ft either side both project onto the line and
joining them draws ground neither of them stands on. `beyond` is already the
perpendicular distance from the cut, so a segment whose ends are further than
`GROUND_NEAR_FT` (20 ft) off it is **dashed**, and the note reports the worst
offender (`ground from 4 points · up to 61' off the cut`). Under four points it
says `thin`.

A faint fill under the line is what turns a scatter of dots into a hillside at a
glance; it is drawn under the datum so that stays crisp. One preference,
`prefs.ground`, with a **Ground** button in the elevation bar.

**What it unlocks immediately: folded plan strokes ride the ground.** The datum
was only ever the right answer while there was no ground to put them on — a bed
edge or a patio edge really is on the ground. `groundRun()` returns the ends
*plus every ground vertex between them*, because a span drawn as one straight
line cuts the corner wherever the ground bends inside it, which had the beads
floating over the very ground they were supposed to be lying on. Outside the
measured span there is still no ground, so those stretches fall back to the
datum and the label says which of the three cases you are looking at.

Next step, when it is wanted: a **triangulated surface** over all the placed
points rather than one line at a time. That is what unlocks contours, drainage
and cut/fill together — but it is gated on fieldwork, not code. Eight points
gives eight big flat triangles and a mesh that is mostly invention; it needs a
yard shot densely before it means anything.

## The surface: contours and drainage

The ground line is 1D interpolation along one cut. This is the 2D case:
triangulate **all** the placed points and you can ask what the ground does
anywhere inside them. **Surface** in the map toolbar cycles
`off → Contours → Contours + flow → off`.

Same discipline as everywhere else, stated plainly because a shaded surface is
the most authoritative-looking thing this app can put on screen:

- **The vertices are measurements.**
- **Every triangle is a flat plane** — an assumption spread over an *area*
  rather than along a line, so the sparser the shots, the more of what you are
  looking at is invention. The status line reports `N points · N triangles ·
  N' of fall · thin · up to N' between shots`; that last figure is how far it is
  interpolating at its worst.
- **It covers only the area inside the outermost points.** The hull is drawn
  dashed so you can see where it stops.
- **There are no breaklines.** Delaunay will happily triangulate straight across
  a retaining wall and smooth away the very feature you went out to measure.
  Until breaklines exist, read a wall in the sections, not here.

**`SUPER_MULT` is 1e5 and that is not paranoia.** Bowyer-Watson's enclosing
triangle has to be bigger than the biggest **circumcircle**, not merely bigger
than the points — and three nearly-collinear points have a circumradius of about
`L²/8h`, which runs away as `h` goes to zero. Shooting eight points along a
fence line is an ordinary thing to do. At the 20× this started with, the strip
step then ate the outermost slivers: measured, **90% of the hull covered on a
fence line and 39% on a straight run**, with no error and nothing on screen to
say so. 1e4 is where every degenerate case tested reaches 100%; 1e5 leaves an
order of magnitude on top and costs nothing. The in-circle epsilon is
**relative**, too — a sliver's `r²` is astronomical and an absolute epsilon
means nothing against it.

Flow arrows come from `triFlow()`: a triangle is a plane, so it has exactly one
downhill direction and one slope. Under 0.5% it draws a hollow ring instead of
an arrow, which is the useful signal — that is where it ponds.

**The arrow glyph points UP at rotation 0**, because `bear` is a compass bearing
and `rotate(0)` has to mean north. SVG y grows *downward*, so the arrowhead's
apex is the SMALLEST y. It shipped drawn the other way up and rendered exactly
180° out — every arrow pointing uphill, which is entirely plausible-looking and
the worst kind of wrong.

**That is the lesson worth keeping: the maths was verified and the rendering was
not.** `triFlow()`'s bearing was right to 3.4e-13° the whole time; the glyph
undid it. Numeric tests over a known plane cannot see a glyph, so `test54.js`
reads the direction off the RENDERED element — the vector from the glyph's own
box centre to the centre of its filled arrowhead, post-transform — and checks it
against the contour labels, which carry their own heights. Note what would NOT
have caught it: the perpendicularity check passes either way round, because a
reversed arrow still crosses the contours at 90°. It needed a check with a sign
in it. Against the broken build that test reports a dot product of −0.955 where
it should be +0.955.

**The maths is verified numerically, not by eye** (`test52.js`, no browser).
Over a known plane the contour vertices land on their own level to **3.6e-15 ft**,
every triangle reports the same downhill bearing to **3.4e-13°**, and the
contour/flow perpendicularity dot product is **7.4e-14**. The triangulation is
checked for the Delaunay property (no point inside any circumcircle) and for
tiling the convex hull exactly, on eight point sets including the degenerate
ones.

**Not built on top of it yet:** cut/fill needs a *proposed* surface to difference
against; a 3D view would render this mesh, and at this primitive count that is
SVG with a projection matrix, not WebGL. The sections still build their ground
line from nearby points rather than by slicing the mesh — the mesh would be more
correct, but the section's own off-cut honesty reporting would need rethinking
with it.

## Folds: each drawing shown on the other view

Two projections of data that already exists. **Nothing is stored** — same rule
as `elevationOf()` and `slopeOf()`. Drag a cut, turn the cross, or change a
section's visibility mode and both move. One preference, `prefs.folds`, and a
**Fold** button in the map toolbar and the elevation bar writing it, as Preview
and Filmstrip do.

They are **not the same operation in opposite directions**, and the difference
is the whole design:

**Section → plan is a measurement.** A section *is* a real line on the ground,
so a stroke drawn on it genuinely lives there. `cutLineAt(side, x)` is
`evProject()`'s `x = dot(localEN, along)` run backwards — the foot of the
perpendicular from the pivot is x zero by construction, whatever the rotation.
What is lost is height, which is a section's entire content, so what survives
the trip is **extent**: where along the cut the thing starts and stops. An
L-shaped wall becomes a segment and its vertical leg becomes a point. Hence the
shadow is drawn as the x-intervals covered (`foldMerge()`), not as the squiggle
itself — a stroke that doubles back reads as the ground it crosses rather than
as a scribble.

**Plan → section invents a height.** The plan has no y. Laying it on the datum
would read as *this is at 0.00 ft*, which in a yard with any fall is false.
What it actually means is *the plan, folded down, seen edge-on* — true, and
useful — but the two look identical on screen unless the mark says which. So it
is beaded **under** the anchor line rather than on it, at a third the weight,
and labelled `plan, folded down` in as many words.

Everything else about that direction is `evProject()`'s own rules, reused
rather than reimplemented: x along the axis, `beyond` across it, the lateral
band, the visibility mode, and the strict/faded distinction — because a stroke
on the ground obeys exactly the same visibility as a point on the ground does.

**PROJECTIONS ARE BEADS, DRAWINGS ARE LINES.** One visual rule on both
surfaces, so a fold can never be mistaken for something somebody drew there.
Neither is interactive (`interactive:false` on the plan, `pointer-events:none`
in the section) — a fold belongs to its source, and two owners for one stroke
is how you get edits that vanish. Legibility over bright turf comes from a
drop-shadow on `.fold-path` / `.fold-bead`, not from more weight, the same rule
the survey pins follow.

Worth knowing: it is **not a round trip**. Send a stroke across and back and
the heights are gone. And the same machinery would project measured polygons
and photo pins; only sketches use it so far.

The natural upgrade, once a ground line exists (interpolated between survey
points — it is on the not-yet-built list with contours): plan strokes could
ride the ground instead of the datum. That is their honest home. The datum is
the right answer only until that exists.

## A session is a context, not a destination

There is **one session screen**, and it describes whichever session is loaded —
the visit that has just ended, or one opened out of the history. Review, the
exports, Past sessions and Settings are all things you step into and back out
of *onto* it, without losing the session.

Before this, Review was a dead end. Closing it on an archived session called
`exitArchive()` and dumped you in the history list, so there was no way back to
anything resembling an intake screen; and the done panel — the only place the
ZIP and the audio download lived — never appeared in the archived path at all.

**So a past session could not be exported.** Not "awkwardly": there was no
button, and wiring one up would not have worked either, because
`exportPins()` did `p.photo.split(',')[1]` on what is a **Storage URL** in
archive mode and would have written a ZIP full of rubbish. Export now
**fetches**: a data URL is read as before, anything else is fetched into a blob,
and audio and clips follow the same rule (`c.blob || fetch(c.url)`).

Three things this pinned down:

- **What could not be fetched is named, in two places.** The status line says
  how many files are missing and `session.json` lists them. A ZIP quietly short
  of half its photos is exactly the failure the fire-and-forget write model
  already risks, and the one copy that is meant to be durable must not be silent
  about it.
- **A session with no audio is now openable.** It cannot be *replayed* — Review
  is driven by the master audio and is hidden — but that is not the same as
  there being nothing in it. Its pins, survey and export are all still there,
  and 6 of the 14 most recent sessions are in that state.
- **The export carries the survey now.** Points with their derived elevations,
  the object each belongs to and its derived height, spread and invert depth,
  plus slope runs with their grade and which end is downhill. All derived at
  export time by `elevationOf()`, `objHeightFt()` and `slopeOf()` — never a
  stored scalar, same rule as everywhere else.

**Open on map reopens the yard itself.** The same Leaflet map, the same pins,
the same survey — the session screen simply steps aside, and `Done` in the
header brings it back. Nothing is duplicated and nothing is read-only: dragging
a pin here PATCHes the row exactly as it would during the visit, which is the
rule Review's map already set.

Three things it needs that a live session gets for free:

- **The tilt switch has to be pinned**, the way grade mode pins it. There is no
  session to record into, so raising the iPad must not hand the screen to a
  camera preview — `handleOrientation()` returns early on `archiveMapOn` for
  the same reason it does on `gradeOn`.
- **The view has to be framed from the data.** A live session recentres on its
  first GPS fix; an archived one has none, so `fitArchiveView()` fits the pins,
  survey, sketches, measures and plan, or the map sits on the Hebron fallback
  tens of km away.
- **The export reports over the map.** `Export pins` in the map toolbar is the
  same function as the session screen's button, and its progress and
  missing-file report were landing in a status line that is off screen while
  the map is up. `say()` writes to whichever of the two is visible; an error
  toast has no timeout, because a missing-file report that fades has not been
  read.

Note the two navigation returns that had to become explicit: `historyFromSession`
so closing Past sessions goes back to the session you opened it from rather than
to the start screen, and `doneClose`, which is the only thing that now calls
`exitArchive()` by hand.

### Naming and deleting a session

**A name and a property tag are different things, so they are separate fields.**
The tag says *where* the visit was; the name says what it *was*. One property
has many sessions — the spring walkthrough, the regrade, the punch list — and an
address alone cannot tell them apart. Either can stand alone: a session can be
named without being tagged and tagged without being named.

Display is a fallback chain, `sessionTitleOf()`: **name → address → *Untagged
session***. When a session has both, the address does not disappear — it moves
to the line under the title, because it is still half of what identifies the
session. `upright_sessions.name` is trimmed server-side and a blank string is
stored as null rather than as an empty name.

Naming is the one write here that is **not fire-and-forget**. Everything else in
this app warns to the console and moves on, which is the right trade for a pin
dropped mid-visit; but a name someone typed and watched fail to save is worse
than one that never appeared to save at all, so the panel reports the failure
and keeps what was typed.

**Deleting is reachable wherever a session is** — the history list, the session
screen, the map view and Review — because that is where you are when you decide
a session was a false start. `deleteLoadedSession()` is one function behind the
last three; the history row passes its own counts instead.

Two things make it safe rather than merely confirmed:

- **It asks twice, and the first ask names what goes** (`Delete "Back yard
  regrade"? This permanently removes the audio recording, 2 photo pins, 3 video
  clips…`). A generic *are you sure* on a tool held one-handed in a yard is not
  a real question. The counts come from what is actually loaded, so they are the
  session's own numbers rather than a guess.
- **It puts the session down.** Deleting the session you are looking at closes
  Review, closes the map, exits archive mode and returns to the start screen —
  otherwise the app carries on showing rows that no longer exist.

Server side, `DELETE /sessions/:id`. **Every one of the eleven child tables
cascades on `session_id`** (verified against `information_schema`, and by a live
round trip: insert into six of them, delete the session, all zero). **Storage
does not cascade**, so `purgeSessionStorage()` walks `sessions/<id>/` — `list()`
is not recursive, so it is a folder queue — and removes every object before the
rows go. An orphaned file is invisible and billable forever, which is the one
failure mode a cascade cannot save you from.

**A crashed test is not a failing test, and the sweep used to hide that.** A
test that throws emits neither `PASS` nor `FAIL`, so a clean failure count says
nothing about it — `test13` sat broken through two sweeps after Open stopped
landing in Review, and the totals looked fine because its seventeen checks
simply stopped existing. `runsweep.sh` now names every test that produced no
checks and flags any that is not one of the known screenshot/probe scripts.

## Matching a session to its property

A visit happens AT a yard, so the session already knows which property it is —
it has just never been asked. One session in a hundred carried a `property_id`,
because tagging is something somebody has to remember afterwards and in a yard
nobody does. `match.ts` derives it from where the session's pins are.

**Every constant in it was set by the project's own data, not chosen.**

- **A true match is ~50 m away, not ~5 m.** The two sessions tagged by hand that
  can be checked sit **47 m and 50 m** from their property's stored coordinate.
  That is not error: a property's coordinate is a geocoded street address and
  the pins are spread around the yard behind it. A tight threshold would reject
  every real match. `MATCH_M` is 75.
- **But a threshold is essential.** 22 of the 71 sessions carrying pins are over
  a kilometre from any property with coordinates — their yard is not in the
  table with a position yet. Nearest-wins with no cutoff tags those to something
  13 km away and says nothing.
- **And nearest-wins alone is not enough.** `1580 Foulis Ct` is in `properties`
  **twice at identical coordinates**, and `2651` and `2658 Naples Dr` are
  different yards **20 m apart** — closer together than a true match's own
  error. The runner-up is therefore consulted and the match stood down when the
  two cannot be separated (`MARGIN_M`, 40).
- **The median, not the mean.** One pin left on the Hebron fallback before the
  first GPS fix drags a mean across the county; the median ignores it. The
  spread is reported alongside, and past `SPREAD_M` (500) the middle of the pins
  is a position no property is at, so no match is offered.

**Only `confident` may be assigned without asking.** Everything else — the best
guess, its distance, what it was confused with — is reported so a person can be
shown the choice rather than a blank.

**The reverse is what makes it work over time.** 49 properties have no
coordinates, so they can never be matched *to*; but a session somebody tagged by
hand is a surveyed fix for that yard. `backfillCandidate()` offers it, and
`POST /properties/:id/coordinates` writes it — **only when the property has
none**. An existing coordinate is a record somebody else entered, `properties`
is shared with the Sales Board, and a session's median pin is not grounds for
moving a yard somebody else relies on.

**Where it appears.** A session asks once when it ends, and the done panel says
what happened (`Tagged to 665 S. Baums Bridge Rd. — 154 ft away.`). Every
history row carries a second button: **Match** on an untagged session, and
**Location** on a tagged one, because a tagged session is the other half of the
job — it is the one that can give its property a position. Where the matcher
cannot separate two candidates the row puts the choice to the person rather
than guessing.

**Worth knowing before running it over the existing data: all 48 sessions that
currently match resolve to ONE address**, 665 S. Baums Bridge Rd., at 18–65 m.
That is the shop, and those are test sessions recorded there. The tag is
correct — that really is where they happened — but it is not 48 customer
visits being recovered, and the feature's value is in the visits still to come.
23 more sessions are refused as too far because their yard has no coordinates
on file, which is what the backfill is for.

`test61.js` pins all of it without a network call: the duplicate row and the
20 m neighbours are both refused, a 47 m match is accepted, a stray pin is
outvoted by the median but still reported in the spread, and a property that
already has coordinates is never offered new ones.

### And the name comes with it

A visit is remembered by *whose yard it was*, so tagging a session also names
it — `clientNameFrom()` reads `properties.primary_contact_id → contacts.last_name`
and `autoNameSession()` writes it. Both routes that can set a property do it:
the match POST and the by-hand `PATCH /sessions/:id`.

**It never overwrites a name somebody typed.** Naming runs only when the
session's `name` is null, so the auto name is a default, not a correction. Per
*Naming and deleting a session* above the two fields stay separate — the tag
says where, the name says whose — and `sessionTitleOf()` already falls back
name → address → *Untagged session*, so a session that cannot be named reads
exactly as it did before.

**That column is mostly a surname and is therefore cleaned, not trusted.** Of
the 100 contacts attached to a property, one holds a bare phone number
(`219-248-4569`) and one a company with a phone stuck on the end (`TLC Plumbing
- 219.922.6214`). A phone-shaped run is stripped wherever it appears along with
whatever punctuation was joining it on, and what survives must still contain a
letter — so the company keeps its name and the bare number yields **null**,
leaving the session unnamed, which is what it would have been anyway.

**What is deliberately not attempted: telling a first name from a surname.**
`2651 Naples Drive` has "Amy" in that column, and from one word there is no
honest way to know whether that is the wrong field or somebody's actual name.
Guessing would rename real clients. Ten of `test61.js`'s checks are this
function, including that one.

## The proposal helper

Suggested proposal lines pulled out of what was said on site. `POST
/sessions/:id/proposal` sends the transcript to Claude (`claude-opus-5`,
adaptive thinking, schema-constrained output) and writes back suggestions;
`upright_proposal_items` holds them. The code lives in
`supabase/functions/upright-api/proposal.ts`, split out because it is the one
part of that function with real logic rather than routing.

**Three rules make it honest, and all three are enforced in code rather than
asked for in the prompt.** A prompt is a request; a check is a guarantee.

- **Evidence or it does not exist.** Every item must carry a verbatim quote,
  and `buildProposalRows()` verifies that quote appears in the transcript
  before the row is written. This is the whole safety mechanism, because the
  failure mode here is specific and predictable: *mulch, edging, spring
  cleanup* belong to every landscaping conversation ever had, so a model will
  offer them whether or not anybody said them. Comparison is normalised for
  case and punctuation — speech-to-text should not be what rejects a real
  quote — but **a paraphrase is refused as firmly as an invention**. "We would"
  for "we'd" is a tidy-up, and tidying speech into something nobody quite said
  is how a proposal line stops being evidence.
- **Quantities come from the survey, or from somebody's mouth — and the row
  always says which.** The model may point at a measured thing by ref
  (`measure:…`, `sketch:…`, `object:…`); the number is then read off *our* row —
  a polygon's area, a drawn line's length. A ref naming something that does not
  exist yields **no** quantity rather than a number nobody measured, and an item
  with nothing measured says *needs measuring*.

  The second source is a **stated** quantity, and it exists because the first
  real transcript exposed the gap: *"2 loads of mulch"* and *"2,000 square feet
  of lawn"* are numbers the client said out loud, sitting inside the very quote
  that is already treated as evidence. Refusing them while accepting the
  sentence around them was inconsistent — so `quantity_source='stated'` records
  the figure as **a placeholder to confirm, never a measurement**. It is checked
  the same way the quote is: `statedQuantityIn()` requires the number to appear
  in the verbatim quote, which has itself already been matched against the
  transcript, so a stated quantity is evidence by the same chain the description
  is. A figure that is not in its own quote is dropped and **reported**, exactly
  as a bad quote is — and only the number goes, not the item.

  `quoteNumbers()` ungroups thousands first (`2,000` is one number; the quote
  normaliser turns every comma into a space, so it would otherwise arrive as
  `2 000` and never match) and reads single number *words*. Compound speech —
  *"two thousand"* — is deliberately not parsed: getting it subtly wrong would
  put a number nobody said onto a proposal, and the honest failure is no
  quantity at all.

  **A measured figure always wins**, since it is the one the survey can stand
  behind. Where the two disagree by more than 2% the row says so
  (`Client stated 2000 sq ft; measured 242.5 sq ft.`) rather than quietly
  preferring one — that disagreement is worth more than either number alone.
  The panel draws a stated figure unfilled, italic and in the anchor colour, so
  it can never be read as a survey number at a glance.
- **Nothing is accepted.** Everything lands `pending`. Re-running replaces only
  pending extracted rows, so a second pass never clobbers what a human has
  ruled on or typed.

**What the quote check throws away is reported, not swallowed** — in the status
line and at the foot of the panel. Silently discarding half the output would
hide a prompt that had started confabulating; that list is where it shows up
first.

The catalog (`upright_catalog_items`) is the **second pass** and is deliberately
optional: with the table empty every item stays free text, which is what makes
this degrade gracefully rather than silently dropping whatever the catalog does
not cover. Both halves are kept on a matched row — the phrase somebody actually
said *and* the catalog line — never one replacing the other.

`test59.js` covers the checks without spending a token (`proposal.ts` is a plain
module, so node imports it directly): a confabulated item is dropped, a
paraphrase is dropped, punctuation and casing are not, areas and lengths come
off the linked rows, a bogus ref yields nothing, a stated figure that is not in
its own quote is refused while the item survives, a grouped numeral and a number
word both read correctly, and a measurement beats a stated figure while
recording the disagreement. `test60.js` covers the panel.

The stated-quantity check is **mutation-tested**: making `statedQuantityIn()`
return `true` unconditionally turns two checks red, so the guarantee is the code
and not the wording of a prompt.

**Requires secret `ANTHROPIC_API_KEY`** (Supabase → Edge Functions → Secrets,
same place as `ASSEMBLYAI_API_KEY` — NOT Vault, NOT Vercel env). Without it the
endpoint returns a plain "not set" message rather than failing quietly.

**And `ANTHROPIC_WORKSPACE_ID` if — and only if — that key is identity-linked.**
An identity-linked key belongs to a person rather than to a workspace, so it
cannot say on its own which workspace a request acts in; Anthropic rejects it
with a **400** until an `anthropic-workspace-id` header (a `wrkspc_…` id, from
the Console under Settings → Workspaces) says so. A plain workspace key carries
that implicitly and needs no header, which is the other way out. The header is
sent only when the secret is present, so setting it wrongly on a plain key is
the one thing to avoid. Edge Functions read secrets at invocation, so neither
needs a redeploy.

**Every Anthropic failure is named, not swallowed.** `anthropicErrorMessage()`
turns the status and body into the thing to *do* — a rejected key, a low credit
balance, a rate limit, a workspace without Opus 5, the missing workspace id
above — and the panel shows it in place of the idle "Nothing yet" text. That
distinction is the whole point: an extraction that never ran and a visit with
nothing in it look identical otherwise, and reading the first as the second is
how you conclude the tool does not work.

**Unproven, and this is the important part.** There is no transcript corpus to
judge it against: 13 sessions have completed transcripts, 85 segments between
them, and the longest is 4½ minutes of a conversation about a birthday shoebox.
Nothing in the database is a site walkthrough. The plumbing and the checks are
tested; whether the extraction finds anything worth quoting is entirely unknown
until somebody records a real visit end to end — which is also the 30–60 minute
soak test already on the needs-testing list.

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

**`elevationOf()` and `slopeOf()` are mirrored in MasterDash.** Its Plan view
draws this survey as a layer under the take-off, and `lib/estimator/survey.ts`
there is a port of these two functions. Change the maths here and that copy is
wrong until it follows — its tests pin the numbers against a real
three-observation survey, so it should fail rather than drift silently, but it
will not update itself. The intended fix is to move the derivation into
`upright-api` so both apps read one answer; until then, treat this pair as
having a second home.

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

**Which way the camera is pointing is NOT `webkitCompassHeading`, and reading
it as though it were is the bug this section shipped with.** That value is the
alpha-equivalent: the compass direction of rotation about the device's *own* z
axis, the one normal to the screen. Lie the iPad flat and z points at the sky,
so it correctly describes which way the top edge faces — which is what a
compass app wants. But grade sighting is done with the iPad held **up**, screen
vertical, camera aimed at the target; z is then horizontal, pointing back out
of the screen at your face, and the reading stops being an azimuth at all.
Measured against the real geometry:

| how you were holding it | error in the recorded bearing |
| --- | --- |
| portrait, held plumb | none — which is why it ever looked right |
| portrait, rolled 20° in the hand | 20°: the roll leaks straight in |
| **landscape** | **90°**, sign depending on which way up |

Note what that did to the bearing cross-check below. Hold the iPad the same way
all set and the set's median offset quietly *absorbs* the error; change your
grip for one shot and that point alone disagrees with its set — which is
exactly the signature the check attributes to **a pin in the wrong place**. It
would have blamed the pin.

`cameraBearing()` takes the camera axis (−z in device coordinates, whatever the
grip) through the full orientation matrix instead. W3C has `R = Rz(a)Rx(b)Ry(g)`
mapping device to earth (X east, Y north, Z up), so the third column is z in
earth coords, the camera is its negation, and the azimuth is that vector
flattened onto the ground. **Roll falls out of it by construction** — which is
the same property `tilt` already had (`cos β · cos γ` is the z axis against
vertical), so the angle was always roll-invariant and only the bearing was not.

Aimed within ~5° of vertical there is no horizontal component left to take a
bearing from, and `cameraBearing()` returns null rather than inventing one. The
stance shot is aimed at your own feet, so `lastHeading` keeps the last good
value for the pin it parks while the live reading goes null.

On iOS `alpha` is referenced to an arbitrary start, so true north comes from
`webkitCompassHeading` via `heading = 360 − alpha`, and that alpha is what the
matrix is fed. iOS also reports **−1** for a heading it does not trust; stored
raw that became an accuracy of −1°, which reads as better than perfect.

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

**The compass on screen while shooting grade.** A dial in the sighting HUD:
white index fixed at the top for where you are aiming, red-north needle turning
under it, and `312° NW ±8°`. Two things make it worth the space, and neither is
the dial itself.

It reads the **camera** bearing — the number that actually gets recorded — so
what is on screen is the thing being verified, not a second opinion from the
same sensor. And it carries `webkitCompassAccuracy`, which is iOS's own
self-report and the only honest signal about whether the heading can be trusted
at all; past `HEADING_ACC_BAD` (20°) it is worse than the 15° the cross-check
flags at, so the check would be reading noise. A bad or unknown figure turns red
and says *figure-8 to calibrate*.

Be clear about what it can and cannot do, because it is easy to over-trust: a
miscalibrated compass reads **confidently wrong**, so a dial alone proves
nothing. What catches that is the cardinal against something you already know —
the street, the front of the house, the sun — plus the accuracy figure. The
needle makes both possible at a glance; it does not make either automatic.

A needle rather than a lettered rose: at 44px a letter and its tick land on top
of each other and read as one red smudge.

**View cones on photo pins.** A photo pin is a point; with a heading it is a
point *and* a direction. `upright_photos.heading_deg` records which way the
camera was pointed and the map draws a wedge — `PHOTO_FOV_DEG` (62°, roughly an
iPad's rear camera) over `PHOTO_CONE_M` (10 m). That is what turns a yard full
of *Pin 7* into something readable at the desk: it says what the picture is
**of**, not just where it was taken from. The inspector reads *Facing 320° NW*,
and the GeoJSON export carries `headingDeg`.

Fixed ground distance rather than fixed screen size, so it scales with the map
like everything else, and deliberately short — a GPS pin is good to 3–5 m, so a
10 m wedge is about as much precision as it has any business implying. Faint for
every pin, solid for the selected one: the wash reads as coverage, the solid one
answers *what am I looking at*.

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

### Sketching on a section, and the grid that squares it up

The map has had freehand sketch since the beginning; a section now has the same
thing. **Strokes are stored in view feet** — x along the section's own axis, y
above the anchor — never pixels and never lat/lng. Pixels would not survive a
pan, a zoom, a re-fit or a change of exaggeration, and a lat/lng cannot express
a height. One row per stroke in `upright_elevation_sketches`, tagged with its
side, so a stroke belongs to the section it was drawn on and no other.

**The grid runs both ways at the same spacing in feet.** The horizontal lines
were already there — they are the elevation scale, always drawn. The **Grid**
button adds the vertical half, distance along the section, which is what lets
you square something up. At a vertical exaggeration other than ×1 the cells are
therefore *not* square on screen, which is the honest way round: the grid states
real distances and the cell shape shows the exaggeration. It costs nothing for
drawing right angles, since the two axes are perpendicular on screen whatever
the scale.

**Align to grid — and it is align, not snap.** A visible grid only lets you
eyeball a right angle; this is what delivers one. The two are routinely
confused and the difference is the whole reason this is the one that shipped:

- **Snap constrains position.** Every point jumps to the nearest intersection,
  so a wall you drew at +11.4 ft becomes +10 ft. In a tool whose entire purpose
  is measuring, that silently rounds a measured height to fit a drawing aid —
  the one unforgivable move.
- **Align constrains direction.** Each run is made parallel to a grid axis and
  *nothing moves off where you put it*. The stroke starts exactly where the
  finger went down, the corner stays exactly where you turned, and the run
  keeps the height it was drawn at. Only the hand wobble across the run is
  taken out.

So a wall drawn at the height you actually measured stays at that height and
still comes out plumb. `ALIGN_START_PX` (7) is how far the finger must travel
before the stroke has a direction at all; `ALIGN_TURN_PX` (15) is how far
*across* the current run it must go to count as a turn rather than wobble — at
which point the tip as it stands becomes the corner and the next run starts
from there on the other axis. Both are measured in **screen** pixels, not feet:
with a vertical exaggeration in play a foot is a different number of pixels per
axis, so choosing the run direction in feet would lean towards whichever axis
is stretched.

With it off, the stroke is thinned by pixel distance instead, exactly as the
map's sketch is.

Picking the Sketch tool drops any image tool and re-locks the view — the same
rule the image tools apply to each other. It no longer stands the **gestures**
down, though; see below for why it used to have to.

**The plan gets the same grid, squared to the cuts.** This is the one place
where "aligned" is a real choice, and north is usually the wrong answer: a yard
is laid out against the house, not against the pole. `gridDraw()` runs its lines
along the cut cross's own two axes, so a bed or a patio drawn to it comes out
square with the building *and* square with what the elevation views show — they
are cuts through the same cross. Spacing is a round number of **feet**, never of
metres, picked from the current zoom by measuring pixels-per-foot through
Leaflet rather than assuming it. `cutsRefresh()` redraws it, so turning the
cross turns the grid.

**And the plan gets Align to grid too**, beside Grid in the map toolbar, under
the same rule: direction is constrained, position is not. `ALIGN_START_PX` and
`ALIGN_TURN_PX` are shared with the section, and the button is disabled while
the grid is off — there is nothing to be parallel to otherwise.

What differs is the axes. The section's grid is square with the screen; the
plan's is square with the **house**, so a run is projected on to `cutRot` /
`cutRot+90` rather than on to x and y. `gridAxesAt()` measures those two
directions **through Leaflet at the anchor** instead of computing them from
`cutRot`, which means the map's own rotation in split screen, the projection and
the zoom are all accounted for by construction — the same reason `splitXform()`
takes the section's scale from the plan rather than matching it. The whole thing
runs in container points, which is the space `containerPt()` already hands back
with any map rotation undone.

Consequence worth knowing: a stroke drawn **across** a turned grid staircases,
because that is what aligning a diagonal to two axes means. In the yard you draw
along the lines, which are right there on screen; it is only a problem if you
ignore them.

Note the placement trap this walked into. `syncGridBtns()` was first called at
the top level next to the button wiring, which sits ~800 lines *above*
`let mapGridOn`. That is a temporal dead zone throw, and it takes **the entire
script** with it — the map never wires up at all. It is called from
`wireMapAnnotation()` now, which runs long after every `let` is live.

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

**Two views, and the tile one is a map of the yard.** A visit is recognised by
the *place*, not by a line of text, so **Tiles** in the history header draws
each session as a satellite preview of its property, captioned with the title,
the date and the counts. Tapping one opens the session. The **list** keeps
Name, Tag, Open, Delete and Match: a tile cannot hold five buttons and still be
a picture, so tiles are for *finding* a session and the list is for managing
one. `prefs.historyTiles` remembers the choice — it is the one preference here
that defaults **off**, since the list is what was already there.

**The coordinates are joined client-side.** `GET /sessions` does not return
lat/lng, but `GET /properties` does and the address picker already fetches it —
a hundred rows, once, cached. That was worth more than a schema-shaped change
to a deployed function for two numbers it can already hand over another way.

**The imagery is the same Esri World Imagery the map draws**, addressed as
plain tiles, so a yard looks in a preview exactly as it looks on the map. No
key and no second provider. `mapPreviewInto()` is a little slippy map with no
Leaflet in it: it works out which tiles a box actually shows and positions them
so the property is at the **centre** rather than wherever it happens to fall in
one tile — a yard on the edge of its own preview is not a preview. Images are
`loading="lazy"`, which is what stops a list of fifty firing hundreds of
requests at once.

**Nowhere to show is two different problems and gets two different sentences**:
a property with no coordinates on file, and a session tagged to no property at
all. The first is what the backfill exists to fix; the second is what the
matcher does. Saying "no map" for both would hide which one you are looking at.

`test64.js` drives it in a real browser with Supabase and Esri stubbed: that
the imagery covers the tile on all four sides (the centring check), that each
of those two empty cases says the right thing, that a session with no audio is
flagged, and that the view survives closing the panel. 17 checks.

**Past sessions** (start screen and session screen) lists every session
newest-first from `GET /sessions`, labelled by its property address. Tapping
Open rehydrates the session and lands on the **session screen** — see *A session
is a context, not a destination* above; Review is a mode you choose from there,
not where Open drops you.

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

Sessions whose audio never uploaded **open, but cannot be replayed** — Review
is driven by the master audio, so its button is hidden and the row says why.
Everything else about them is reachable: pins, survey, and the export. As of
writing, 6 of the 14 most recent sessions are in that state; one of them has
clips, photos and a sketch, so this is the fire-and-forget write model showing
up in real data, not just abandoned starts.

## Object types

Every measured thing becomes an **object with a type**, and **the type is a
shoot order, not a label**. Tell the app what you are looking at and it walks
you through the shots. One rule underneath all of them:

> **origin first, then the height, then whatever ground points the structure
> needs.**

The origin is a ground point and it is always mandatory — *everything starts on
the ground*, so every object contributes at least one mesh vertex. **There is
exactly one height per object**, plumb above the origin; anything else about the
shape comes from more ground points, never more heights.

| type | shots | ground points | height | extra |
| --- | --- | --- | --- | --- |
| spot elevation | 1 | origin | — | |
| tree / shrub | 2 | origin | apex | **spread** diameter, typed |
| fence / wall | 2 + N | origin, then the path | top of the first post | level top along the whole run |
| house face | 3 | origin, opposite end | roof line | a rectangle standing on the base line |
| box / structure | 4 | origin + 2 more corners | top corner | three corners give the fourth |
| drain | 1 | origin | — | invert depth, typed |

That table is the whole feature: the prompts, the shot count, the geometry and
the mesh contribution all fall out of it, so adding a type is a row rather than
a code path.

**This closed a live hole.** `surfPoints()` took *every* placed point, so a shot
at the top of a fence silently became a ground vertex and pulled the mesh up by
the height of the fence. It now drops `role==='height'` outright — one line, and
it is the whole reason the types exist. And the quiet win: shooting the trees
and posts a crew wants on the plan *also* densifies the ground model, which is
the standing worry about the surface — eight points is mostly invention.

**A height point needs no pin of its own.** It is plumb above the origin, so it
inherits that pin's map distance and differs only in angle:

    height = d · (tan θ_top − tan θ_base)

The anchor cancels, so **an object's height does not depend on the datum** — the
most trustworthy number in the app, provided both shots come from the same
stance. Shooting origin and height back to back is what guarantees that, which
is another reason the order is fixed; if the observation changes between the
two, say so.

**A run's top is level, and that is the only mode.** Every ground point in the
run gets a partner plumb above it at the height shot at the origin, so the run
owns a **vertical face** — a ribbon of plumb pairs. A stepped fence is captured
as several short level runs rather than as a second derivation rule, which is
why `fence` and `wall` share one geometry and differ only cosmetically.

That also rescues the vertical face. A surface storing one height per ground
position cannot express one — but **the face never lives in the mesh**. The mesh
keeps the ground points; the object carries the face, so nothing has to bend.

Two display rules, both borrowed from things already built: an object draws as
**one map symbol** — the origin wears the type's own glyph, and the height point
gets no marker at all — with its detail in the pin inspector, which exists
precisely to hold that; and a plant's **spread** is a ground-scale ring, faint
for every pin and solid for the selected one, exactly as the photo view cones
behave.

### How it is wired

The type picker is a row of pills **in the sighting HUD**, above the compass —
the choice is made while you are stood up holding the iPad, so it cannot live in
the map toolbar. Tapping the type you are already on ends that object; tapping
another starts that one instead. `objNextRole()` is the single source of what
the next shot is, `objPrompt()` turns it into the line under the sight, and
`gradeFire()` routes the shot by that role rather than by anything the user
presses.

**A height point is created placed, at the origin's own lat/lng**, and
`objSyncPlumb()` keeps it there through every drag of the origin — plumb is a
relationship, not a position, so it is re-derived rather than stored (the same
rule `elevationOf()` and `slopeOf()` follow). On an archived session it is
rebuilt in `hydrateArchive()` from the membership the rows carry.

**The typed attributes are built once per pin and then left alone.** The rest of
the inspector is rewritten on every frame of a drag, and replacing a focused
field drops what is in it along with the caret — exactly the trap the photo
pin's note already dodges. `piBody.dataset.pin` is keyed `elev:<id>` so the
static half survives a re-render and a change of pin still rebuilds it.

**Settings writes the whole table out**, and *derives it from `OBJ_TYPES`* —
glyph, name, filmstrip code, shot count, the numbered shoot order with each
prompt exactly as the sighting overlay gives it, ground points, whether there is
a height, and what else the type carries. Hand-typing that beside the data is
how a reference goes stale the first time a prompt is reworded; `objRefBuild()`
reads the same object the overlay does, so adding a type is still one row.

Note the placement trap, third time now: `renderPrefs()` is called at the **top
level**, thousands of lines above `OBJ_TYPES`. Reading that `const` from there
is a temporal dead zone throw and takes the entire script with it, so
`objRefBuild()` hangs off `openSettings()` — which only ever runs on a tap —
rather than off `renderPrefs()`. Same fix as `syncGridBtns()`.

The table also earned a change in the app itself: a type with more than one
extra ground point repeats a single prompt, and *"a base corner along one side"*
twice running reads as a stuck screen rather than as two corners. `objGroundStep()`
appends `· 1 of 2` — and stays quiet at one, where there is nothing to count
through.

Server side: one `upright_objects` table (RLS on, zero policies, like every
other), `object_id` / `role` / `seq` on `upright_elevation_points`, and
`POST /sessions/:id/objects`, `PATCH /objects/:id` (attrs **merged**, not
replaced), `DELETE /objects/:id`. The point POST goes out before the object has
a server id, so membership is PATCHed on once both exist.

**The origin and the height ARE the object.** Deleting either from the filmstrip
removes the whole thing — a height with no origin measures nothing, and an
object with no origin never happened — while a later point on a run is just that
point. `objPrune()` repairs membership after any other route to a deleted point
(deleting a whole set, say) rather than leaving an object pointing at rows that
are gone. The filmstrip names an object's frames for the object (`TR`, `TR↑`,
`FN·2`): a picture of a treetop called *Target 5* is a picture you will not find
again.

`test55.js` covers the shoot order end to end: seven shots produce six pins, the
height is derived (+25.02' against an independently computed 51.4 ft × (tan 20°
− tan −7°)), it does not move when the datum is dragged, the mesh counts the
pins rather than the heights, a spread typed in the column becomes a ground-scale
ring, and deleting the origin takes the height with it. `test56.js` covers the
Settings table — that origin is always first, that there is at most one height
and it is always second, that a run is open-ended, and that it is built lazily
and only once.

**The origin is the only mandatory shot.** A height that cannot be sighted is
skipped and the object simply has none. A derived top is never presented as if
somebody sighted it.

**Breaklines are deliberately NOT in the first version.** A run of wall or fence
points is exactly the line the mesh must not cross, and without that the surface
still smooths a retaining wall away. But it means constrained Delaunay — finding
every triangle that crosses a required edge, removing them and re-triangulating
both sides — which is real surgery on a triangulation that is currently verified
and clean. The object model captures the data breaklines need, so it can be a
second, self-contained step, tested against real wall runs rather than invented
fixtures.

**Not yet built**
- Renaming an object, and typing more than a spread or an invert depth (species,
  material). `attrs` is a merged jsonb blob, so the storage is already there.
- Breaklines for the surface — telling it "these points are a wall, do not
  triangulate across them". Without them a retaining wall is smoothed away.
  Deferred on purpose; see *Object types* above for why, and for the capture
  model that would feed it.
- Cut/fill, which needs a proposed surface to difference against.
- A 3D view of the mesh.
- More of the compass ideas: auto-selecting the section you are standing in
  front of, and squaring the cuts to a wall by pointing at it. (A heading-up
  map is built — see *My location*.)
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
- **Object types against a real yard.** Whether the shoot order reads as help or
  as a cage — a fence with a gate in it, a tree you cannot see the top of, a
  wall that steps — and whether picking a type from the sighting HUD is
  something a crew actually does mid-visit or quietly ignores. The derived
  height is only trustworthy if origin and apex are shot from one stance; that
  is what the fixed order is for, but nothing stops somebody walking between the
  two.
- Split screen on a real iPad: whether half a portrait screen is enough map to
  place a pin in, whether the turned plan reads naturally or disorientingly
  against a yard you are standing in, and whether the split opening itself on
  every turn of the iPad is welcome or a nuisance.
- The pin inspector against a real yard: whether 34% of the map is the right
  width on an iPad in both orientations, whether the photo is big enough to
  match a pin to a place at arm's length, and whether losing that much map
  while dragging is a fair trade for never having a bubble over the pin.
- Sketch/Measure accuracy against known dimensions.
- **The surface against a real yard, and this is the one that decides whether it
  was worth building.** Eight points gives eight big flat triangles and contours
  that are mostly invention. The question is not whether the code works — that is
  verified — but whether a crew will shoot forty points instead of eight, and
  whether the contours that come back match what the eye sees on the ground.
- Whether folds read as help or as clutter in a yard: whether a section stroke's
  shadow is legible on the cut line at working zoom, and whether anyone reads
  the folded plan as a claim about height despite the label and the beads.
- **The pencil against a real iPad.** The pointerdown-before-touchstart ordering
  that keeps the map still under a stroke is per spec and holds in Chromium, but
  it has only been exercised with synthetic pen events; what needs confirming on
  device is that a pencil stroke never pans the map, that palm rejection leaves
  a resting hand out of it, and that a finger pan mid-stroke does not break the
  line.
- 58px sidebar buttons with a gloved thumb; marker base size (30% of screen); yellow marker visibility on sunny turf; stroke weight at 3× zoom.
- Extent-lock button reachability; whether the filmstrip eats too much map
  height in landscape — the answer now has a switch either way, so the question
  is whether people find it. In split it is deliberately small (104×78 tiles):
  whether that is still enough picture to recognise a frame at arm's length.
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
- The bearing cross-check against a real compass, now that the heading is the
  camera's rather than the screen normal's: whether iOS's heading is steady
  enough for `HEADING_FLAG_DEG` (15°) to catch real mistakes without crying
  wolf, and whether a set's median offset really is as consistent as the method
  assumes once you have walked around a yard with a metal-cased iPad. Sets shot
  before this fix are not worth reading back — a change of grip mid-set put 90°
  into a single point's bearing.
- Heading-up in a real yard: whether 4° and 180ms are the right gate on a
  handheld iPad or whether the map still swims, and whether a crew reads a
  turned map more easily than a north-up one once the house is not square to
  north.
- The on-screen compass against a known direction: whether the accuracy figure
  iOS reports actually tracks how wrong the heading is, and whether `±20°` is
  the right line to call it bad at.
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
