import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Upright site-session app API.
// The client (a static HTML page) never talks to Postgres/Storage directly —
// it calls this function, which holds the service-role key. This matches the
// existing project convention: RLS is on everywhere with no policies, so
// only a trusted backend can read/write.

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, serviceRoleKey);

const ASSEMBLYAI_API_KEY = Deno.env.get("ASSEMBLYAI_API_KEY");

const BUCKET = "upright-media";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
function err(message: string, status = 400) {
  return json({ error: message }, status);
}
function publicUrl(path: string) {
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
function extFromMime(mime: string, fallback: string) {
  if (!mime) return fallback;
  if (mime.includes("mp4")) return mime.startsWith("audio") ? "m4a" : "mp4";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return fallback;
}
function firstOf<T>(v: unknown): T | null {
  if (Array.isArray(v)) return (v.length ? v[0] as T : null);
  return (v as T) ?? null;
}
function embeddedCount(v: unknown): number {
  const row = firstOf<{ count?: number }>(v);
  return row && typeof row.count === "number" ? row.count : 0;
}

console.log("ASSEMBLYAI_API_KEY present:", !!ASSEMBLYAI_API_KEY, ASSEMBLYAI_API_KEY ? `(len ${ASSEMBLYAI_API_KEY.length}, starts ${ASSEMBLYAI_API_KEY.slice(0,4)})` : "");

// ---------- AssemblyAI transcription ----------
// Submission and polling are both driven by short-lived client calls rather
// than a long-running job inside the Edge Function, since a 30-60 min
// session's transcript can take a few minutes to come back — well past a
// safe single-invocation budget.

async function submitTranscription(sessionId: string, audioUrl: string) {
  const res = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { authorization: ASSEMBLYAI_API_KEY!, "content-type": "application/json" },
    body: JSON.stringify({ audio_url: audioUrl, speaker_labels: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AssemblyAI submit failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  await supabase.from("upright_sessions").update({
    assemblyai_transcript_id: data.id,
    transcript_status: "processing",
  }).eq("id", sessionId);
  return data.id;
}

async function pollAndStoreTranscript(sessionId: string, transcriptId: string) {
  const res = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
    headers: { authorization: ASSEMBLYAI_API_KEY! },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AssemblyAI poll failed: ${res.status} ${text}`);
  }
  const data = await res.json();

  if (data.status === "completed") {
    const utterances = Array.isArray(data.utterances) ? data.utterances : [];
    if (utterances.length) {
      const rows = utterances.map((u: { speaker: string; text: string; start: number; end: number }) => ({
        session_id: sessionId, start_ms: u.start, end_ms: u.end, speaker: u.speaker, text: u.text,
      }));
      await supabase.from("upright_transcript_segments").delete().eq("session_id", sessionId);
      await supabase.from("upright_transcript_segments").insert(rows);
    }
    await supabase.from("upright_sessions").update({ transcript_status: "completed" }).eq("id", sessionId);
    return { status: "completed" };
  }
  if (data.status === "error") {
    await supabase.from("upright_sessions").update({ transcript_status: "error" }).eq("id", sessionId);
    return { status: "error", error: data.error };
  }
  return { status: "processing" };
}

function planUpdateFrom(body: Record<string, unknown>) {
  const u: Record<string, unknown> = {};
  if (body.planCenterLat !== undefined) u.plan_center_lat = body.planCenterLat;
  if (body.planCenterLng !== undefined) u.plan_center_lng = body.planCenterLng;
  if (body.planWidthM !== undefined) u.plan_width_m = body.planWidthM;
  if (body.planAspect !== undefined) u.plan_aspect = body.planAspect;
  if (body.planRotDeg !== undefined) u.plan_rot_deg = body.planRotDeg;
  if (body.planOpacity !== undefined) u.plan_opacity = body.planOpacity;
  if (body.planLocked !== undefined) u.plan_locked = body.planLocked;
  // Scale set from a known dimension on the drawing is a measurement, not a
  // preference -- it has to survive reopening the session.
  if (body.planScaleLocked !== undefined) u.plan_scale_locked = body.planScaleLocked;
  // Elevation view: the section-cut cross. Pivot lat/lng, rotation of the whole
  // cross, and whether the orientation has been locked.
  if (body.elevCutLat !== undefined) u.elev_cut_lat = body.elevCutLat;
  if (body.elevCutLng !== undefined) u.elev_cut_lng = body.elevCutLng;
  if (body.elevCutRotDeg !== undefined) u.elev_cut_rot_deg = body.elevCutRotDeg;
  if (body.elevCutLocked !== undefined) u.elev_cut_locked = body.elevCutLocked;
  if (body.basemap !== undefined) u.basemap = body.basemap;
  return u;
}

// Deleting a survey point should not leave its reference photos behind in
// Storage. Gather every path about to be orphaned before the rows go.
async function purgePointPhotos(pointIds: string[]) {
  if (!pointIds.length) return;
  const { data } = await supabase.from("upright_elevation_points")
    .select("photo_storage_path").in("id", pointIds);
  const paths = (data || []).map((r) => r.photo_storage_path).filter(Boolean) as string[];
  if (paths.length) {
    try { await supabase.storage.from(BUCKET).remove(paths); } catch (_e) { /* row delete still proceeds */ }
  }
}

// Storage has no foreign keys, so deleting a session's rows would leave every
// photo, clip and audio file behind it -- invisible and billable forever. The
// bucket is walked a folder at a time (list() is not recursive) and everything
// under sessions/<id>/ goes.
async function purgeSessionStorage(sessionId: string) {
  const root = `sessions/${sessionId}`;
  const dirs = [root];
  const files: string[] = [];
  // Depth is bounded by the layout we write: sessions/<id>/{photos,clips,elevation,elevation-views}.
  for (let guard = 0; dirs.length && guard < 64; guard++) {
    const dir = dirs.shift()!;
    const { data, error } = await supabase.storage.from(BUCKET)
      .list(dir, { limit: 1000 });
    if (error || !data) continue;
    for (const entry of data) {
      // A "folder" comes back with no id; a real object always has one.
      if (entry.id) files.push(`${dir}/${entry.name}`);
      else dirs.push(`${dir}/${entry.name}`);
    }
  }
  if (!files.length) return 0;
  // remove() takes at most a few hundred keys comfortably; chunk to be safe.
  let removed = 0;
  for (let i = 0; i < files.length; i += 100) {
    const chunk = files.slice(i, i + 100);
    try {
      const { error } = await supabase.storage.from(BUCKET).remove(chunk);
      if (!error) removed += chunk.length;
    } catch (_e) { /* the rows still go: an orphan is better than a live row pointing nowhere */ }
  }
  return removed;
}

// Replacing an image must land on a NEW path. Storage public URLs are cached
// by the browser and by the CDN in front of the bucket, so an upsert onto the
// same path hands back a URL that still resolves to the OLD picture -- which
// is exactly how a re-shot target kept showing the shot it was meant to
// replace. Delete the previous object only after the row points at the new
// one: an orphaned file is harmless, a row pointing at a deleted file is not.
async function dropOldObject(oldPath: string | null | undefined, newPath: string) {
  if (!oldPath || oldPath === newPath) return;
  try { await supabase.storage.from(BUCKET).remove([oldPath]); } catch (_e) { /* orphan is harmless */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/upright-api/, "");
  const parts = path.split("/").filter(Boolean);

  try {
    // POST /sessions  { id, startedAt, propertyId? }
    if (req.method === "POST" && parts.length === 1 && parts[0] === "sessions") {
      const body = await req.json();
      if (!body.id || !body.startedAt) return err("id and startedAt required");
      const { error } = await supabase.from("upright_sessions").insert({
        id: body.id, started_at: body.startedAt, property_id: body.propertyId ?? null,
        name: body.name ?? null,
      });
      if (error) return err(error.message, 500);
      return json({ id: body.id });
    }

    // GET /sessions?limit=&offset=  -> newest-first history list
    if (req.method === "GET" && parts.length === 1 && parts[0] === "sessions") {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 200);
      const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
      const { data, error } = await supabase
        .from("upright_sessions")
        .select(
          "id, name, started_at, ended_at, audio_storage_path, audio_duration_seconds, transcript_status, property_id, plan_storage_path, " +
          "properties(id,address,latitude,longitude), " +
          "upright_clips(count), upright_photos(count), upright_sketches(count), upright_measures(count), upright_elevation_points(count)"
        )
        .order("started_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) return err(error.message, 500);
      const sessions = (data || []).map((s: Record<string, unknown>) => {
        const prop = firstOf<{ id: number; address: string }>(s.properties);
        return {
          id: s.id, name: s.name ?? null, startedAt: s.started_at, endedAt: s.ended_at,
          hasAudio: !!s.audio_storage_path, hasPlan: !!s.plan_storage_path,
          durationSeconds: s.audio_duration_seconds, transcriptStatus: s.transcript_status,
          propertyId: s.property_id ?? null, propertyAddress: prop ? prop.address : null,
          clipCount: embeddedCount(s.upright_clips), photoCount: embeddedCount(s.upright_photos),
          sketchCount: embeddedCount(s.upright_sketches), measureCount: embeddedCount(s.upright_measures),
          elevationPointCount: embeddedCount(s.upright_elevation_points),
        };
      });
      return json({ sessions, limit, offset });
    }

    // GET /properties?q=
    if (req.method === "GET" && parts.length === 1 && parts[0] === "properties") {
      const q = (url.searchParams.get("q") || "").trim();
      let query = supabase.from("properties").select("id,address,latitude,longitude");
      if (q) query = query.ilike("address", `%${q}%`);
      const { data, error } = await query.order("address").limit(200);
      if (error) return err(error.message, 500);
      return json({ properties: data || [] });
    }

    // GET /sessions/:id
    if (req.method === "GET" && parts.length === 2 && parts[0] === "sessions") {
      const sessionId = parts[1];
      const [{ data: session, error: sErr }, { data: clips }, { data: photos }, { data: sketches }, { data: measures }, { data: elevPoints }, { data: elevShots }, { data: elevSlopes }, { data: elevViews }, { data: elevSketches }, { data: objects }] =
        await Promise.all([
          supabase.from("upright_sessions").select("*, properties(id,address,latitude,longitude)").eq("id", sessionId).single(),
          supabase.from("upright_clips").select("*").eq("session_id", sessionId).order("start_offset_ms"),
          supabase.from("upright_photos").select("*").eq("session_id", sessionId).order("seq"),
          supabase.from("upright_sketches").select("*").eq("session_id", sessionId),
          supabase.from("upright_measures").select("*").eq("session_id", sessionId),
          supabase.from("upright_elevation_points").select("*").eq("session_id", sessionId).order("created_at"),
          supabase.from("upright_elevation_shots").select("*").eq("session_id", sessionId).order("created_at"),
          supabase.from("upright_elevation_slopes").select("*").eq("session_id", sessionId).order("created_at"),
          supabase.from("upright_elevation_views").select("*").eq("session_id", sessionId),
          supabase.from("upright_elevation_sketches").select("*").eq("session_id", sessionId).order("created_at"),
          supabase.from("upright_objects").select("*").eq("session_id", sessionId).order("created_at"),
        ]);
      if (sErr || !session) return err("session not found", 404);
      const prop = firstOf<{ id: number; address: string }>((session as Record<string, unknown>).properties);
      return json({
        session: {
          ...session, property: prop, propertyAddress: prop ? prop.address : null,
          audioUrl: session.audio_storage_path ? publicUrl(session.audio_storage_path) : null,
          planUrl: session.plan_storage_path ? publicUrl(session.plan_storage_path) : null,
        },
        clips: (clips || []).map((c) => ({ ...c, url: publicUrl(c.storage_path) })),
        photos: (photos || []).map((p) => ({ ...p, url: publicUrl(p.storage_path) })),
        sketches: sketches || [],
        measures: measures || [],
        elevationPoints: (elevPoints || []).map((e) => ({
          ...e, photoUrl: e.photo_storage_path ? publicUrl(e.photo_storage_path) : null,
        })),
        elevationShots: elevShots || [],
        elevationSlopes: elevSlopes || [],
        elevationSketches: elevSketches || [],
        objects: objects || [],
        elevationViews: (elevViews || []).map((v) => ({
          ...v,
          planUrl: v.plan_storage_path ? publicUrl(v.plan_storage_path) : null,
          photoUrl: v.photo_storage_path ? publicUrl(v.photo_storage_path) : null,
        })),
      });
    }

    // PATCH /sessions/:id
    if (req.method === "PATCH" && parts.length === 2 && parts[0] === "sessions") {
      const sessionId = parts[1];
      const body = await req.json();
      const update: Record<string, unknown> = planUpdateFrom(body);
      if (body.propertyId !== undefined) update.property_id = body.propertyId;
      // A name and a property tag are independent: a visit can be named without
      // being tagged and tagged without being named. An empty string clears it
      // rather than storing a blank.
      if (body.name !== undefined) {
        const n = body.name === null ? null : String(body.name).trim();
        update.name = n ? n.slice(0, 200) : null;
      }
      if (!Object.keys(update).length) return err("nothing to update");
      const { data: row, error } = await supabase
        .from("upright_sessions").update(update).eq("id", sessionId).select().single();
      if (error) return err(error.message, 500);
      return json(row);
    }

    // DELETE /sessions/:id
    // Every child table cascades on session_id -- clips, photos, sketches,
    // measures, the whole elevation survey, objects and the transcript -- so
    // one row delete takes the lot. Storage does NOT cascade, so the session's
    // whole prefix is listed and removed first: an orphaned file is invisible
    // and costs money forever.
    if (req.method === "DELETE" && parts.length === 2 && parts[0] === "sessions") {
      const sessionId = parts[1];
      const { data: existing } = await supabase
        .from("upright_sessions").select("id").eq("id", sessionId).maybeSingle();
      if (!existing) return err("session not found", 404);
      const removed = await purgeSessionStorage(sessionId);
      const { error } = await supabase.from("upright_sessions").delete().eq("id", sessionId);
      if (error) return err(error.message, 500);
      return json({ ok: true, deleted: sessionId, filesRemoved: removed });
    }

    // ---------- relative elevation survey ----------
    // A SET is one observation plus the targets shot from it. Targets carry
    // set_observation_id so they survive their shots being deleted (reshoot)
    // and so the whole set can be hidden, locked or removed together.

    // POST /sessions/:id/elevation-points
    if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "elevation-points") {
      const sessionId = parts[1];
      const body = await req.json();
      if (!["observation", "anchor", "target"].includes(body.kind)) return err("kind must be observation|anchor|target");
      if (body.lat == null || body.lng == null) return err("lat and lng required");
      const { data: row, error } = await supabase.from("upright_elevation_points").insert({
        session_id: sessionId, kind: body.kind, label: body.label ?? null,
        lat: body.lat, lng: body.lng,
        gps_lat: body.gpsLat ?? null, gps_lng: body.gpsLng ?? null,
        placed: body.placed === undefined ? true : !!body.placed,
        set_observation_id: body.setObservationId ?? null,
        // Object membership. role is origin|height|ground; a height point is
        // plumb above its origin and is what the ground mesh must NOT include.
        object_id: body.objectId ?? null,
        role: body.role ?? null,
        seq: body.seq ?? null,
      }).select().single();
      if (error) return err(error.message, 500);
      return json(row);
    }

    // ---------- objects ----------
    // The type is a shoot order: origin first, then at most one height plumb
    // above it, then whatever ground points the structure needs.

    // POST /sessions/:id/objects { type, label, attrs }
    if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "objects") {
      const sessionId = parts[1];
      const body = await req.json();
      if (!body.type) return err("type required");
      const { data: row, error } = await supabase.from("upright_objects").insert({
        session_id: sessionId, type: String(body.type),
        label: body.label ?? null,
        attrs: body.attrs && typeof body.attrs === "object" ? body.attrs : {},
      }).select().single();
      if (error) return err(error.message, 500);
      return json(row);
    }

    // PATCH /objects/:id { label, attrs }  -- attrs is merged, not replaced, so
    // typing a spread does not wipe a species recorded earlier.
    if (req.method === "PATCH" && parts.length === 2 && parts[0] === "objects") {
      const objectId = parts[1];
      const body = await req.json();
      const update: Record<string, unknown> = {};
      if (body.label !== undefined) update.label = body.label;
      if (body.type !== undefined) update.type = String(body.type);
      if (body.attrs !== undefined && body.attrs && typeof body.attrs === "object") {
        const { data: cur } = await supabase
          .from("upright_objects").select("attrs").eq("id", objectId).single();
        update.attrs = { ...((cur?.attrs as Record<string, unknown>) || {}), ...body.attrs };
      }
      if (!Object.keys(update).length) return err("nothing to update");
      const { data: row, error } = await supabase
        .from("upright_objects").update(update).eq("id", objectId).select().single();
      if (error) return err(error.message, 500);
      return json(row);
    }

    // DELETE /objects/:id  -- its points cascade (object_id FK), and their shots
    // cascade from those, so one call removes the whole thing.
    if (req.method === "DELETE" && parts.length === 2 && parts[0] === "objects") {
      const objectId = parts[1];
      const { error } = await supabase.from("upright_objects").delete().eq("id", objectId);
      if (error) return err(error.message, 500);
      return json({ ok: true });
    }

    // PATCH /elevation-points/:id { label, lat, lng, placed, hidden, locked }
    if (req.method === "PATCH" && parts.length === 2 && parts[0] === "elevation-points") {
      const pointId = parts[1];
      const body = await req.json();
      const update: Record<string, unknown> = {};
      if (body.label !== undefined) update.label = body.label;
      if (body.lat !== undefined) update.lat = body.lat;
      if (body.lng !== undefined) update.lng = body.lng;
      if (body.placed !== undefined) update.placed = !!body.placed;
      if (body.hidden !== undefined) update.hidden = !!body.hidden;
      if (body.locked !== undefined) update.locked = !!body.locked;
      if (body.setObservationId !== undefined) update.set_observation_id = body.setObservationId;
      // Object membership. The point POST goes out before the object has a
      // remote id, so the client PATCHes this on once both exist.
      if (body.objectId !== undefined) update.object_id = body.objectId;
      if (body.role !== undefined) update.role = body.role;
      if (body.seq !== undefined) update.seq = body.seq;
      if (!Object.keys(update).length) return err("nothing to update");
      const { data: row, error } = await supabase
        .from("upright_elevation_points").update(update).eq("id", pointId).select().single();
      if (error) return err(error.message, 500);
      return json(row);
    }

    // DELETE /elevation-points/:id
    // Deleting an OBSERVATION removes its whole set: the FK from targets
    // (set_observation_id) and from shots (observation_id) both cascade.
    if (req.method === "DELETE" && parts.length === 2 && parts[0] === "elevation-points") {
      const pointId = parts[1];
      const { data: kids } = await supabase.from("upright_elevation_points")
        .select("id").eq("set_observation_id", pointId);
      await purgePointPhotos([pointId, ...((kids || []).map((k) => k.id))]);
      const { error } = await supabase.from("upright_elevation_points").delete().eq("id", pointId);
      if (error) return err(error.message, 500);
      return json({ ok: true, deleted: pointId, alsoDeleted: (kids || []).length });
    }

    // DELETE /elevation-points/:id/shots  -> clears a point's sightings so it
    // can be re-shot from scratch, without destroying the pin's position.
    if (req.method === "DELETE" && parts.length === 3 && parts[0] === "elevation-points" && parts[2] === "shots") {
      const pointId = parts[1];
      const obs = url.searchParams.get("observationId");
      let q = supabase.from("upright_elevation_shots").delete().eq("point_id", pointId);
      if (obs) q = q.eq("observation_id", obs);
      const { error } = await q;
      if (error) return err(error.message, 500);
      return json({ ok: true });
    }

    // POST /elevation-points/:id/photo  (multipart: file)
    // Re-shooting a target replaces its reference photo, so the object goes to
    // a versioned path -- see dropOldObject() for why overwriting in place did
    // not work.
    if (req.method === "POST" && parts.length === 3 && parts[0] === "elevation-points" && parts[2] === "photo") {
      const pointId = parts[1];
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return err("file required");
      const { data: existing, error: getErr } = await supabase
        .from("upright_elevation_points").select("session_id, photo_storage_path").eq("id", pointId).single();
      if (getErr || !existing) return err("point not found", 404);
      const path = `sessions/${existing.session_id}/elevation/${pointId}-${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || "image/jpeg", upsert: true,
      });
      if (upErr) return err(upErr.message, 500);
      const { error: updErr } = await supabase.from("upright_elevation_points")
        .update({ photo_storage_path: path }).eq("id", pointId);
      if (updErr) return err(updErr.message, 500);
      await dropOldObject(existing.photo_storage_path, path);
      return json({ path, url: publicUrl(path) });
    }

    // POST /sessions/:id/elevation-shots
    if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "elevation-shots") {
      const sessionId = parts[1];
      const body = await req.json();
      if (!body.observationId || !body.pointId) return err("observationId and pointId required");
      if (body.angleDeg == null) return err("angleDeg required");
      const { data: row, error } = await supabase.from("upright_elevation_shots").insert({
        session_id: sessionId, observation_id: body.observationId, point_id: body.pointId,
        angle_deg: body.angleDeg, angle_spread_deg: body.angleSpreadDeg ?? null,
        distance_m: body.distanceM ?? null,
        // Evidence, not input: the heading feeds the sight line and the bearing
        // cross-check. No elevation is ever computed from it.
        heading_deg: body.headingDeg ?? null,
        heading_acc_deg: body.headingAccDeg ?? null,
      }).select().single();
      if (error) return err(error.message, 500);
      return json(row);
    }

    // POST /sessions/:id/elevation-slopes  { fromPointId, toPointId, note? }
    // A slope stores only WHICH two points it joins. The percent grade and the
    // run length are derived from the pins and their elevations every time they
    // are drawn, so moving either pin corrects the slope instead of leaving a
    // stale number behind.
    if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "elevation-slopes") {
      const sessionId = parts[1];
      const body = await req.json();
      if (!body.fromPointId || !body.toPointId) return err("fromPointId and toPointId required");
      if (body.fromPointId === body.toPointId) return err("a slope needs two different points");
      const { data: row, error } = await supabase.from("upright_elevation_slopes").insert({
        session_id: sessionId, from_point_id: body.fromPointId,
        to_point_id: body.toPointId, note: body.note ?? null,
      }).select().single();
      // The same pair either way round is the same run; a duplicate is the
      // client re-sending, not an error worth surfacing in the field.
      if (error) {
        if (error.code === "23505") {
          const { data: existing } = await supabase.from("upright_elevation_slopes")
            .select("*").eq("session_id", sessionId)
            .or(`and(from_point_id.eq.${body.fromPointId},to_point_id.eq.${body.toPointId}),` +
                `and(from_point_id.eq.${body.toPointId},to_point_id.eq.${body.fromPointId})`)
            .maybeSingle();
          if (existing) return json(existing);
        }
        return err(error.message, 500);
      }
      return json(row);
    }

    // POST /sessions/:id/elevation-sketches  { side, colour, points }
    // points are view feet -- x along the section, y above the anchor -- so the
    // stroke is stored in the same units the profile is plotted in and survives
    // any pan, zoom or change of vertical exaggeration.
    if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "elevation-sketches") {
      const sessionId = parts[1];
      const body = await req.json();
      if (!["north", "south", "east", "west"].includes(body.side)) return err("side must be north|south|east|west");
      if (!Array.isArray(body.points) || body.points.length < 2) return err("points must have at least two entries");
      const { data: row, error } = await supabase.from("upright_elevation_sketches").insert({
        session_id: sessionId, side: body.side,
        colour: body.colour ?? null, points: body.points,
      }).select().single();
      if (error) return err(error.message, 500);
      return json(row);
    }

    // DELETE /elevation-sketches/:id
    if (req.method === "DELETE" && parts.length === 2 && parts[0] === "elevation-sketches") {
      const { error } = await supabase.from("upright_elevation_sketches").delete().eq("id", parts[1]);
      if (error) return err(error.message, 500);
      return json({ ok: true, deleted: parts[1] });
    }

    // DELETE /elevation-slopes/:id
    if (req.method === "DELETE" && parts.length === 2 && parts[0] === "elevation-slopes") {
      const { error } = await supabase.from("upright_elevation_slopes").delete().eq("id", parts[1]);
      if (error) return err(error.message, 500);
      return json({ ok: true, deleted: parts[1] });
    }

    // ---------- elevation view: four perpendicular section cuts ----------
    // One row per side, created on first touch. The cross's rotation and pivot
    // live on the session; each side owns only its own offset, exaggeration and
    // overlays.
    const SIDES = ["north", "south", "east", "west"];

    // PATCH /sessions/:id/elevation-views/:side
    if (req.method === "PATCH" && parts.length === 4 && parts[0] === "sessions" && parts[2] === "elevation-views") {
      const sessionId = parts[1], side = parts[3];
      if (!SIDES.includes(side)) return err("side must be north|south|east|west");
      const body = await req.json();
      const row: Record<string, unknown> = { session_id: sessionId, side };
      if (body.offsetM !== undefined) row.offset_m = body.offsetM;
      if (body.vertExag !== undefined) row.vert_exag = body.vertExag;
      if (body.planOpacity !== undefined) row.plan_opacity = body.planOpacity;
      if (body.planCorners !== undefined) row.plan_corners = body.planCorners;
      if (body.photoOpacity !== undefined) row.photo_opacity = body.photoOpacity;
      if (body.photoCorners !== undefined) row.photo_corners = body.photoCorners;
      const { data, error } = await supabase.from("upright_elevation_views")
        .upsert(row, { onConflict: "session_id,side" }).select().single();
      if (error) return err(error.message, 500);
      return json(data);
    }

    // POST /sessions/:id/elevation-views/:side/plan|photo  (multipart: file, meta)
    // Versioned paths for the same caching reason as every other replaceable
    // image: re-shooting a facade must not hand back the previous picture.
    if (req.method === "POST" && parts.length === 5 && parts[0] === "sessions"
        && parts[2] === "elevation-views" && (parts[4] === "plan" || parts[4] === "photo")) {
      const sessionId = parts[1], side = parts[3], slot = parts[4];
      if (!SIDES.includes(side)) return err("side must be north|south|east|west");
      const form = await req.formData();
      const file = form.get("file");
      const metaRaw = form.get("meta");
      if (!(file instanceof File)) return err("file required");
      const meta = metaRaw ? JSON.parse(String(metaRaw)) : {};
      const { data: existing } = await supabase.from("upright_elevation_views")
        .select("plan_storage_path, photo_storage_path").eq("session_id", sessionId).eq("side", side).maybeSingle();
      const ext = extFromMime(file.type, "jpg");
      const path = `sessions/${sessionId}/elevation-views/${side}-${slot}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || "image/jpeg", upsert: true,
      });
      if (upErr) return err(upErr.message, 500);
      const row: Record<string, unknown> = { session_id: sessionId, side };
      row[slot === "plan" ? "plan_storage_path" : "photo_storage_path"] = path;
      if (meta.corners !== undefined) row[slot === "plan" ? "plan_corners" : "photo_corners"] = meta.corners;
      if (meta.opacity !== undefined) row[slot === "plan" ? "plan_opacity" : "photo_opacity"] = meta.opacity;
      const { data, error: updErr } = await supabase.from("upright_elevation_views")
        .upsert(row, { onConflict: "session_id,side" }).select().single();
      if (updErr) return err(updErr.message, 500);
      await dropOldObject(existing ? (slot === "plan" ? existing.plan_storage_path : existing.photo_storage_path) : null, path);
      return json({ ...data, path, url: publicUrl(path) });
    }

    // DELETE /sessions/:id/elevation-views/:side/plan|photo
    if (req.method === "DELETE" && parts.length === 5 && parts[0] === "sessions"
        && parts[2] === "elevation-views" && (parts[4] === "plan" || parts[4] === "photo")) {
      const sessionId = parts[1], side = parts[3], slot = parts[4];
      if (!SIDES.includes(side)) return err("side must be north|south|east|west");
      const { data: existing } = await supabase.from("upright_elevation_views")
        .select("plan_storage_path, photo_storage_path").eq("session_id", sessionId).eq("side", side).maybeSingle();
      if (!existing) return json({ ok: true });
      const old = slot === "plan" ? existing.plan_storage_path : existing.photo_storage_path;
      const row: Record<string, unknown> = { session_id: sessionId, side };
      row[slot === "plan" ? "plan_storage_path" : "photo_storage_path"] = null;
      row[slot === "plan" ? "plan_corners" : "photo_corners"] = null;
      const { error } = await supabase.from("upright_elevation_views")
        .upsert(row, { onConflict: "session_id,side" });
      if (error) return err(error.message, 500);
      if (old) { try { await supabase.storage.from(BUCKET).remove([old]); } catch (_e) { /* orphan is harmless */ } }
      return json({ ok: true });
    }

    // POST /sessions/:id/plan  (multipart: file, meta)
    if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "plan") {
      const sessionId = parts[1];
      const form = await req.formData();
      const file = form.get("file");
      const metaRaw = form.get("meta");
      if (!(file instanceof File)) return err("file required");
      const meta = metaRaw ? JSON.parse(String(metaRaw)) : {};
      const ext = extFromMime(file.type, "jpg");
      const { data: prevPlan } = await supabase.from("upright_sessions")
        .select("plan_storage_path").eq("id", sessionId).single();
      const path = `sessions/${sessionId}/plan-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || "image/jpeg", upsert: true,
      });
      if (upErr) return err(upErr.message, 500);
      const update: Record<string, unknown> = planUpdateFrom(meta);
      update.plan_storage_path = path;
      const { error: updErr } = await supabase.from("upright_sessions").update(update).eq("id", sessionId);
      if (updErr) return err(updErr.message, 500);
      await dropOldObject(prevPlan?.plan_storage_path, path);
      return json({ path, url: publicUrl(path) });
    }

    // POST /sessions/:id/audio
    if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "audio") {
      const sessionId = parts[1];
      const form = await req.formData();
      const file = form.get("file");
      const metaRaw = form.get("meta");
      if (!(file instanceof File)) return err("file required");
      const meta = metaRaw ? JSON.parse(String(metaRaw)) : {};
      const ext = extFromMime(file.type, "webm");
      const path = `sessions/${sessionId}/audio.${ext}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || "application/octet-stream", upsert: true,
      });
      if (upErr) return err(upErr.message, 500);
      const { error: updErr } = await supabase.from("upright_sessions").update({
        audio_storage_path: path,
        audio_duration_seconds: meta.durationSeconds ?? null,
        ended_at: new Date().toISOString(),
      }).eq("id", sessionId);
      if (updErr) return err(updErr.message, 500);
      return json({ path, url: publicUrl(path) });
    }

    // POST /sessions/:id/clips
    if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "clips") {
      const sessionId = parts[1];
      const form = await req.formData();
      const file = form.get("file");
      const metaRaw = form.get("meta");
      if (!(file instanceof File)) return err("file required");
      const meta = metaRaw ? JSON.parse(String(metaRaw)) : {};
      if (meta.startOffsetMs == null || meta.endOffsetMs == null) return err("startOffsetMs/endOffsetMs required");
      const ext = extFromMime(file.type, "webm");
      const path = `sessions/${sessionId}/clips/clip-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || "application/octet-stream", upsert: true,
      });
      if (upErr) return err(upErr.message, 500);
      const { data: row, error: insErr } = await supabase.from("upright_clips").insert({
        session_id: sessionId, start_offset_ms: meta.startOffsetMs,
        end_offset_ms: meta.endOffsetMs, storage_path: path,
      }).select().single();
      if (insErr) return err(insErr.message, 500);
      return json({ ...row, url: publicUrl(path) });
    }

    // POST /sessions/:id/photos
    if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "photos") {
      const sessionId = parts[1];
      const form = await req.formData();
      const file = form.get("file");
      const metaRaw = form.get("meta");
      if (!(file instanceof File)) return err("file required");
      const meta = metaRaw ? JSON.parse(String(metaRaw)) : {};
      if (meta.seq == null) return err("seq required");
      const path = `sessions/${sessionId}/photos/pin-${meta.seq}.jpg`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || "image/jpeg", upsert: true,
      });
      if (upErr) return err(upErr.message, 500);
      const { data: row, error: insErr } = await supabase.from("upright_photos").insert({
        session_id: sessionId, seq: meta.seq, offset_ms: meta.offsetMs ?? null,
        storage_path: path, lat: meta.lat ?? null, lng: meta.lng ?? null,
        gps_accuracy_m: meta.accM ?? null, note: meta.note ?? null,
        manually_adjusted: !!meta.manuallyAdjusted, has_drawing: !!meta.hasDrawing,
        taken_at: meta.takenAt ?? null,
        // Which way the camera was pointed: the view cone on the map. Evidence,
        // like the elevation shot headings -- never an input to a measurement.
        heading_deg: meta.headingDeg ?? null,
        heading_acc_deg: meta.headingAccDeg ?? null,
      }).select().single();
      if (insErr) return err(insErr.message, 500);
      return json({ ...row, url: publicUrl(path) });
    }

    // PATCH /photos/:id
    if (req.method === "PATCH" && parts.length === 2 && parts[0] === "photos") {
      const photoId = parts[1];
      const body = await req.json();
      const update: Record<string, unknown> = {};
      if (body.lat !== undefined) update.lat = body.lat;
      if (body.lng !== undefined) update.lng = body.lng;
      if (body.note !== undefined) update.note = body.note;
      if (body.manuallyAdjusted !== undefined) update.manually_adjusted = body.manuallyAdjusted;
      if (body.hasDrawing !== undefined) update.has_drawing = body.hasDrawing;
      const { data: row, error } = await supabase.from("upright_photos").update(update).eq("id", photoId).select().single();
      if (error) return err(error.message, 500);
      return json(row);
    }

    // POST /photos/:id/image
    // Saving a drawing replaces the pin's picture, so it lands on a versioned
    // path for the same caching reason as the elevation photos above.
    if (req.method === "POST" && parts.length === 3 && parts[0] === "photos" && parts[2] === "image") {
      const photoId = parts[1];
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return err("file required");
      const { data: existing, error: getErr } = await supabase.from("upright_photos")
        .select("session_id, seq, storage_path").eq("id", photoId).single();
      if (getErr || !existing) return err("photo not found", 404);
      const path = `sessions/${existing.session_id}/photos/pin-${existing.seq}-${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || "image/jpeg", upsert: true,
      });
      if (upErr) return err(upErr.message, 500);
      const { error: updErr } = await supabase.from("upright_photos")
        .update({ has_drawing: true, storage_path: path }).eq("id", photoId);
      if (updErr) return err(updErr.message, 500);
      await dropOldObject(existing.storage_path, path);
      return json({ ok: true, path, url: publicUrl(path) });
    }

    // POST /sessions/:id/sketches
    if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "sketches") {
      const sessionId = parts[1];
      const body = await req.json();
      const { data: row, error } = await supabase.from("upright_sketches").insert({
        session_id: sessionId, colour: body.colour ?? null,
        length_ft: body.lengthFt ?? null, latlngs: body.latlngs,
      }).select().single();
      if (error) return err(error.message, 500);
      return json(row);
    }

    // POST /sessions/:id/measures
    if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "measures") {
      const sessionId = parts[1];
      const body = await req.json();
      const { data: row, error } = await supabase.from("upright_measures").insert({
        session_id: sessionId, anchor_photo_id: body.anchorPhotoId ?? null,
        colour: body.colour ?? null, area_sqft: body.areaSqft ?? null,
        perimeter_ft: body.perimeterFt ?? null, latlngs: body.latlngs,
      }).select().single();
      if (error) return err(error.message, 500);
      return json(row);
    }

    // POST /sessions/:id/transcribe
    if (req.method === "POST" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "transcribe") {
      if (!ASSEMBLYAI_API_KEY) return err("ASSEMBLYAI_API_KEY secret is not set on this Edge Function", 500);
      const sessionId = parts[1];
      const { data: session, error: sErr } = await supabase
        .from("upright_sessions").select("audio_storage_path, transcript_status").eq("id", sessionId).single();
      if (sErr || !session) return err("session not found", 404);
      if (!session.audio_storage_path) return err("session has no audio yet", 400);
      if (session.transcript_status === "processing" || session.transcript_status === "completed") {
        return json({ status: session.transcript_status });
      }
      try {
        const transcriptId = await submitTranscription(sessionId, publicUrl(session.audio_storage_path));
        return json({ status: "processing", id: transcriptId });
      } catch (e) {
        await supabase.from("upright_sessions").update({ transcript_status: "error" }).eq("id", sessionId);
        return err(e instanceof Error ? e.message : String(e), 500);
      }
    }

    // GET /sessions/:id/transcript
    if (req.method === "GET" && parts.length === 3 && parts[0] === "sessions" && parts[2] === "transcript") {
      const sessionId = parts[1];
      const { data: session, error: sErr } = await supabase
        .from("upright_sessions").select("transcript_status, assemblyai_transcript_id").eq("id", sessionId).single();
      if (sErr || !session) return err("session not found", 404);
      if (!session.transcript_status || !session.assemblyai_transcript_id) return json({ status: "none" });
      if (session.transcript_status === "completed") {
        const { data: segments, error: segErr } = await supabase
          .from("upright_transcript_segments").select("*").eq("session_id", sessionId).order("start_ms");
        if (segErr) return err(segErr.message, 500);
        return json({ status: "completed", segments: segments || [] });
      }
      if (session.transcript_status === "error") return json({ status: "error" });
      if (!ASSEMBLYAI_API_KEY) return err("ASSEMBLYAI_API_KEY secret is not set on this Edge Function", 500);
      try {
        const result = await pollAndStoreTranscript(sessionId, session.assemblyai_transcript_id);
        if (result.status === "completed") {
          const { data: segments } = await supabase
            .from("upright_transcript_segments").select("*").eq("session_id", sessionId).order("start_ms");
          return json({ status: "completed", segments: segments || [] });
        }
        return json(result);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 500);
      }
    }

    return err("not found", 404);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
});
