// The proposal helper: suggested proposal lines pulled out of a session's
// transcript. Split out of index.ts because it is the one part of this
// function with real logic in it rather than routing -- and because
// buildProposalRows() is worth testing on its own, without spending a token.
//
// Three rules make this honest rather than merely plausible, and all three are
// enforced HERE rather than asked for in the prompt:
//
//   1. EVIDENCE OR IT DOES NOT EXIST. Every item must carry a verbatim quote,
//      and that quote is checked against the transcript before the row is
//      written. The predictable failure of this task is confabulation --
//      "mulch, edging, spring cleanup" belong to every landscaping
//      conversation ever had, so a model will offer them whether or not
//      anybody said them. A substring check is cheap and catches exactly that.
//   2. QUANTITIES COME FROM THE SURVEY. The model may point at a measured
//      thing by id; the number is then recomputed from that row. It may never
//      supply a number itself.
//   3. NOTHING IS ACCEPTED. Everything lands as `pending` for a human to rule
//      on, and a re-run never touches a row that has been ruled on.

const PROPOSAL_MODEL = "claude-opus-5";

// Loose comparison for the quote check: speech-to-text punctuation and casing
// should not be what rejects a real quote, but the WORDS have to be there.
export function normaliseForQuote(t: string) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export type Segment = { id: number; start_ms: number; end_ms: number; speaker: string; text: string };

// What the model is allowed to point at. Each entry carries the id, what it
// measures, and when it was captured, so an item can be tied to the thing that
// was being measured while it was said.
export function measurableInventory(
  measures: Record<string, unknown>[],
  sketches: Record<string, unknown>[],
  objects: Record<string, unknown>[],
  photos: Record<string, unknown>[],
) {
  const out: Record<string, unknown>[] = [];
  for (const m of measures) {
    out.push({
      ref: `measure:${m.id}`, what: "measured area",
      areaSqFt: m.area_sqft, perimeterFt: m.perimeter_ft, capturedAt: m.created_at,
    });
  }
  for (const k of sketches) {
    out.push({ ref: `sketch:${k.id}`, what: "drawn line", lengthFt: k.length_ft, capturedAt: k.created_at });
  }
  for (const o of objects) {
    out.push({
      ref: `object:${o.id}`, what: `object (${o.type})`,
      attrs: o.attrs, capturedAt: o.created_at,
    });
  }
  for (const p of photos) {
    out.push({ ref: `photo:${p.id}`, what: "photo pin", note: p.note, offsetMs: p.offset_ms });
  }
  return out;
}

const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string", description: "The work or material, as a proposal line would name it." },
          category: {
            type: "string",
            description: "One of: material, labour, plant, hardscape, drainage, cleanup, other.",
          },
          quote: {
            type: "string",
            description:
              "The VERBATIM sentence from the transcript that this came from, copied exactly. " +
              "If no sentence in the transcript supports this item, do not emit the item at all.",
          },
          speaker: { type: "string", description: "The speaker label of that sentence." },
          measurableRef: {
            type: "string",
            description:
              "Optional. The ref of a measured thing this item is about, copied exactly from the " +
              "inventory supplied (e.g. 'measure:...'). Only when the transcript makes the link " +
              "clear. Never invent a ref, and never state a quantity yourself.",
          },
          note: { type: "string", description: "Optional short context worth keeping." },
        },
        required: ["description", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const PROPOSAL_SYSTEM = [
  "You read the transcript of a landscaping site visit and list the work and materials that were",
  "actually discussed, so an estimator has a starting point.",
  "",
  "Rules, in order of importance:",
  "",
  "1. Every item MUST quote the sentence it came from, verbatim. If you cannot quote it, leave it out.",
  "   Items with no support in the transcript are worse than useless here -- they get read as things",
  "   the client asked for. Do not add the obvious ones (mulch, edging, cleanup) unless they were said.",
  "2. Never state a quantity, size, price or product code. If the transcript points at something that",
  "   was measured on site, give its ref from the inventory and nothing more; the app computes the",
  "   number from its own measurements.",
  "3. Prefer the words the crew used. Do not translate 'shred' into 'hardwood mulch, double-ground'.",
  "4. Something raised and rejected on site ('we could take the tree out' / 'no, leave it') is not an",
  "   item. Something the client asked for is. If in doubt whether it was decided, include it and say",
  "   so in the note.",
  "5. Speech-to-text makes mistakes. If a sentence is garbled, quote it as it stands rather than",
  "   tidying it -- the quote is checked against the transcript.",
].join("\n");

// The two rules that make an extraction trustworthy, applied to the model's
// raw output. Pure and side-effect free on purpose: this is the part worth
// testing, and it can be tested without spending a token.
export function buildProposalRows(
  raw: Record<string, unknown>[],
  ctx: {
    sessionId: string;
    segments: Segment[];
    measures: Record<string, unknown>[];
    sketches: Record<string, unknown>[];
    objects: Record<string, unknown>[];
    photos: Record<string, unknown>[];
  },
) {
  // EVIDENCE OR IT DOES NOT EXIST. What is dropped is reported rather than
  // swallowed: silently discarding half the output would hide a prompt that
  // has started confabulating.
  const haystack = normaliseForQuote(ctx.segments.map((x) => x.text).join(" "));
  const kept: Record<string, unknown>[] = [];
  const rejected: { description: string; reason: string }[] = [];
  for (const it of raw) {
    const desc = String(it?.description || "").trim();
    if (!desc) continue;
    const quote = String(it?.quote || "").trim();
    if (!quote) { rejected.push({ description: desc, reason: "no quote" }); continue; }
    const needle = normaliseForQuote(quote);
    if (!needle || !haystack.includes(needle)) {
      rejected.push({ description: desc, reason: "quote not found in the transcript" });
      continue;
    }
    // Which segment it came from, so the app can put the playhead there.
    const seg = ctx.segments.find((x) => normaliseForQuote(x.text).includes(needle))
      || ctx.segments.find((x) => needle.includes(normaliseForQuote(x.text)));
    // QUANTITIES COME FROM THE SURVEY. The model may point at a measured thing
    // by ref; the number is read off OUR row. A ref naming something that does
    // not exist is ignored rather than trusted.
    let quantity: number | null = null, unit: string | null = null;
    let quantitySource: string | null = null;
    let measureId: string | null = null, sketchId: string | null = null;
    let objectId: string | null = null, photoId: string | null = null;
    const ref = String(it?.measurableRef || "");
    const sep = ref.indexOf(":");
    const refKind = sep > 0 ? ref.slice(0, sep) : "";
    const refId = sep > 0 ? ref.slice(sep + 1) : "";
    if (refKind === "measure" && refId) {
      const m = ctx.measures.find((x) => x.id === refId);
      if (m) {
        measureId = m.id as string; quantitySource = "measure";
        quantity = (m.area_sqft as number) ?? null;
        unit = m.area_sqft != null ? "sq ft" : null;
      }
    } else if (refKind === "sketch" && refId) {
      const k = ctx.sketches.find((x) => x.id === refId);
      if (k) {
        sketchId = k.id as string; quantitySource = "sketch";
        quantity = (k.length_ft as number) ?? null;
        unit = k.length_ft != null ? "ft" : null;
      }
    } else if (refKind === "object" && refId) {
      const o = ctx.objects.find((x) => x.id === refId);
      if (o) { objectId = o.id as string; quantitySource = "object"; quantity = 1; unit = "ea"; }
    } else if (refKind === "photo" && refId) {
      const ph = ctx.photos.find((x) => x.id === refId);
      if (ph) photoId = ph.id as string;
    }
    kept.push({
      session_id: ctx.sessionId,
      description: desc,
      category: it?.category ? String(it.category).slice(0, 40) : null,
      quote: quote.slice(0, 2000),
      quote_start_ms: seg ? seg.start_ms : null,
      speaker: seg ? seg.speaker : (it?.speaker ? String(it.speaker).slice(0, 20) : null),
      segment_ids: seg ? [seg.id] : null,
      quantity, unit, quantity_source: quantitySource,
      measure_id: measureId, sketch_id: sketchId, object_id: objectId, photo_id: photoId,
      note: it?.note ? String(it.note).slice(0, 1000) : null,
      status: "pending", origin: "extracted",
    });
  }
  return { kept, rejected };
}

// Turn an upstream failure into something a person in a yard can act on.
// The three that actually happen have different fixes and none of them is a
// code change, so saying which one it is saves a round trip every time.
export function anthropicErrorMessage(status: number, body: string) {
  const b = String(body || "");
  if (status === 401 || status === 403) {
    return "Anthropic rejected the API key (" + status + "). Check ANTHROPIC_API_KEY in " +
      "Supabase \u2192 Edge Functions \u2192 Secrets \u2014 a trailing space when it was pasted " +
      "is the usual cause.";
  }
  if (/credit balance is too low|insufficient_quota|billing/i.test(b)) {
    return "The Anthropic account has no credit on it. Top it up at " +
      "console.anthropic.com \u2192 Billing, then try again.";
  }
  if (status === 429) {
    return "Anthropic is rate-limiting this key (429). Wait a moment and try again.";
  }
  if (status === 404 && /model/i.test(b)) {
    return "This API key cannot reach the model the extractor asks for. Check the key's " +
      "workspace has access to Claude Opus 5.";
  }
  // Anything else: hand back what the API actually said, trimmed.
  let detail = b.slice(0, 300);
  try {
    const j = JSON.parse(b);
    if (j?.error?.message) detail = String(j.error.message).slice(0, 300);
  } catch (_e) { /* not JSON; the raw text will do */ }
  return `Anthropic ${status}: ${detail}`;
}

export async function extractProposalItems(
  apiKey: string,
  segments: Segment[],
  inventory: Record<string, unknown>[],
  addressLine: string,
) {
  const transcript = segments
    .map((s) => `[${Math.round(s.start_ms / 1000)}s ${s.speaker || "?"}] ${s.text}`)
    .join("\n");
  const body = {
    model: PROPOSAL_MODEL,
    max_tokens: 8000,
    // Adaptive thinking: deciding what was actually agreed rather than merely
    // mentioned is the whole judgement this is for.
    thinking: { type: "adaptive" },
    system: PROPOSAL_SYSTEM,
    output_config: { format: { type: "json_schema", schema: PROPOSAL_SCHEMA } },
    messages: [{
      role: "user",
      content:
        (addressLine ? `Site: ${addressLine}\n\n` : "") +
        `Measured on site (you may reference these by ref, never by number):\n` +
        `${JSON.stringify(inventory, null, 1)}\n\n` +
        `Transcript:\n${transcript}`,
    }],
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    // Log it as well as returning it. An error that exists only in a UI status
    // line is invisible the moment nobody is looking at that line, which is
    // exactly the position this failed from the first time.
    console.error(`[proposal] Anthropic ${res.status}: ${text.slice(0, 800)}`);
    throw new Error(anthropicErrorMessage(res.status, text));
  }
  const data = await res.json();
  // A refusal is an HTTP 200 with no usable content -- check before reading.
  if (data.stop_reason === "refusal") throw new Error("The model declined to answer this request.");
  const block = (data.content || []).find((b: { type: string }) => b.type === "text");
  if (!block) throw new Error("No text block in the response");
  let parsed;
  try { parsed = JSON.parse(block.text); }
  catch (_e) { throw new Error("Response was not valid JSON"); }
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  console.log(`[proposal] model returned ${items.length} item(s) from ${segments.length} segment(s)`);
  return items;
}

