// The audio outbox, driven through the real UI in a real browser.
//
//   NODE_PATH=$(npm root -g) node test65.js      (needs playwright)
//
// WHY THIS EXISTS. On 31 Aug a real site visit lost its recording. The audio
// was captured perfectly -- it played back in Review -- and the single upload
// at the end never reached the server. Three things then conspired to hide it:
// apiUpload swallowed the failure into a console warning, the chain carried on
// and asked to TRANSCRIBE audio that had just failed to upload, and the done
// panel reported "N minutes of continuous audio" regardless. The 400 that came
// back said "session has no audio yet", which reads as a transcript fault and
// is not one, so a lost recording was reported to the user as a bad connection.
//
// So the checks that matter are behavioural, not cosmetic:
//   a failed upload SAYS it failed, in the panel, where somebody will see it;
//   a failed upload does NOT go on to request a transcript;
//   the audio is on disk from the first second, so it outlives the tab;
//   and a session left on disk is uploaded on the next app open.
//
// Real getUserMedia (fake devices), real MediaRecorder, real IndexedDB. Only
// the network is stubbed -- the sandbox cannot reach Supabase or the Leaflet
// CDN, and nothing under test needs either.

const { chromium } = require('playwright');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const LEAFLET_STUB = `window.L = (function(){
  const make = () => new Proxy(function(){}, {
    get: (t, k) => (k === Symbol.toPrimitive || k === 'valueOf') ? () => 0
                 : (k === 'then') ? undefined : make(),
    apply: () => make(), construct: () => make(),
  });
  return make();
})();`;

const URL = 'http://127.0.0.1:8931/index.html';

/** Everything the page asked of upright-api, in order. */
function makeRouter(state) {
  return async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const path = url.split('/upright-api')[1] || '';
    state.calls.push(method + ' ' + path.split('?')[0]);

    if (method === 'OPTIONS') return route.fulfill({ status: 200, body: '' });

    if (/\/audio$/.test(path) && method === 'POST') {
      state.audioPosts++;
      if (state.audioFails) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"a.m4a","url":"http://x/a.m4a"}' });
    }
    if (/\/transcribe$/.test(path)) {
      state.transcribePosts++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"processing"}' });
    }
    if (/\/property-match$/.test(path)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"none"}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  };
}

/** What the outbox holds right now, read straight out of IndexedDB. */
const READ_OUTBOX = `(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('upright-outbox');
    r.onsuccess = () => res(r.result); r.onerror = () => res(null);
  });
  if (!db) return { sessions: [], chunks: [] };
  const all = (store) => new Promise((res) => {
    const rq = db.transaction(store, 'readonly').objectStore(store).getAll();
    rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
  });
  const sessions = await all('sessions');
  const chunks = await all('chunks');
  return {
    sessions: sessions.map((s) => ({ id: s.id, seconds: s.seconds, mime: s.mime })),
    chunks: chunks.map((c) => ({ session: c.session, seq: c.seq, bytes: c.buf.byteLength })),
  };
})()`;

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
           '--autoplay-policy=no-user-gesture-required'],
  });

  // ---- a visit whose audio upload fails ------------------------------------
  const state = { calls: [], audioPosts: 0, transcribePosts: 0, audioFails: true };
  const ctx = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    permissions: ['camera', 'microphone', 'geolocation'],
    geolocation: { latitude: 41.3241, longitude: -87.1997 },
  });
  await ctx.route('**/leaflet*.js', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_STUB }));
  await ctx.route('**/leaflet*.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.route('**/jszip*', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await ctx.route('**/functions/v1/upright-api/**', makeRouter(state));

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(600);

  await page.click('#enableBtn');
  // Long enough for MediaRecorder's 1s timeslice to have produced several
  // chunks, so "it is on disk while recording" is a real claim.
  await page.waitForTimeout(3500);

  const during = await page.evaluate(READ_OUTBOX);
  ok('audio is on disk WHILE recording, not just at the end', during.chunks.length >= 2,
     'chunks=' + during.chunks.length);
  ok('the outbox knows which session the chunks belong to',
     during.sessions.length === 1 && during.chunks.every((c) => c.session === during.sessions[0].id));
  ok('chunks are numbered in order from zero',
     during.chunks.map((c) => c.seq).sort((a, b) => a - b).every((v, i) => v === i));
  ok('and they carry real bytes', during.chunks.every((c) => c.bytes > 0));

  await page.click('#endBtn');
  // 4 attempts at 0/2/4/8s, plus slack.
  await page.waitForTimeout(17000);

  const audioTxt = await page.textContent('#doneAudio');
  const audioErr = await page.evaluate(() => document.getElementById('doneAudio').classList.contains('err'));
  const retryShown = await page.evaluate(() => {
    const b = document.getElementById('retryAudioBtn');
    return !!b && getComputedStyle(b).display !== 'none';
  });
  ok('a failed upload SAYS so on the panel', /did NOT save/i.test(audioTxt || ''), JSON.stringify(audioTxt));
  ok('and says it in the error style, not as an aside', audioErr);
  ok('and points at the ZIP, which is the copy that needs no network',
     /ZIP/i.test(audioTxt || ''));
  ok('and offers to retry', retryShown);
  ok('it really did retry rather than giving up on the first failure',
     state.audioPosts >= 4, 'audio POSTs=' + state.audioPosts);

  // THE REGRESSION THIS WAS WRITTEN FOR.
  ok('a failed upload does NOT go on to ask for a transcript',
     state.transcribePosts === 0, 'transcribe POSTs=' + state.transcribePosts);

  const afterFail = await page.evaluate(READ_OUTBOX);
  ok('the recording is KEPT on disk when the upload fails',
     afterFail.chunks.length >= 2, 'chunks=' + afterFail.chunks.length);
  ok('and the real duration is recorded with it, not guessed later',
     afterFail.sessions.length === 1 && afterFail.sessions[0].seconds > 0);

  // ---- retry by hand, now that the network is back -------------------------
  state.audioFails = false;
  const postsBefore = state.audioPosts;
  await page.click('#retryAudioBtn');
  await page.waitForTimeout(2500);

  const savedTxt = await page.textContent('#doneAudio');
  ok('retrying uploads it', state.audioPosts > postsBefore);
  ok('and the panel stops warning once it is saved', /saved/i.test(savedTxt || '') && !/did NOT/i.test(savedTxt || ''),
     JSON.stringify(savedTxt));
  ok('NOW it asks for a transcript', state.transcribePosts === 1,
     'transcribe POSTs=' + state.transcribePosts);

  const afterSave = await page.evaluate(READ_OUTBOX);
  ok('and the disk copy is dropped once the server has it',
     afterSave.chunks.length === 0 && afterSave.sessions.length === 0,
     'chunks=' + afterSave.chunks.length + ' sessions=' + afterSave.sessions.length);

  ok('no page errors through the whole flow', errors.length === 0, errors.join(' | '));

  // ---- a visit stranded on disk is recovered on the next app open ----------
  // Same origin, so the same IndexedDB: seed it as a crash would have left it.
  const seeded = await page.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('upright-outbox');
      r.onsuccess = () => res(r.result); r.onerror = () => res(null);
    });
    if (!db) return false;
    const put = (store, val) => new Promise((res) => {
      const rq = db.transaction(store, 'readwrite').objectStore(store).put(val);
      rq.onsuccess = () => res(true); rq.onerror = () => res(false);
    });
    await put('sessions', { id: 'stranded-1', startedAt: '2026-08-31T14:06:10Z', mime: 'audio/mp4', seconds: 1220 });
    await put('chunks', { session: 'stranded-1', seq: 0, buf: new ArrayBuffer(2048) });
    await put('chunks', { session: 'stranded-1', seq: 1, buf: new ArrayBuffer(2048) });
    return true;
  });
  ok('(seeded a stranded session)', seeded);

  state.calls.length = 0; state.audioPosts = 0; state.transcribePosts = 0;
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  ok('a stranded recording is uploaded on the next app open', state.audioPosts >= 1,
     'audio POSTs=' + state.audioPosts);
  ok('to the session it actually belonged to',
     state.calls.some((c) => c === 'POST /sessions/stranded-1/audio'), state.calls.join(', '));
  ok('and it is transcribed once it is safely up', state.transcribePosts >= 1);

  const afterRecover = await page.evaluate(READ_OUTBOX);
  ok('the recovered session is cleared off the disk',
     !afterRecover.sessions.some((s) => s.id === 'stranded-1'));

  const recoverMsg = await page.textContent('#errorMsg');
  ok('and the app says what it recovered rather than doing it silently',
     /Recovered/i.test(recoverMsg || ''), JSON.stringify(recoverMsg));

  // ---- storage failure must never stop a recording -------------------------
  const ctx2 = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    permissions: ['camera', 'microphone', 'geolocation'],
    geolocation: { latitude: 41.3241, longitude: -87.1997 },
  });
  const state2 = { calls: [], audioPosts: 0, transcribePosts: 0, audioFails: false };
  await ctx2.route('**/leaflet*.js', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_STUB }));
  await ctx2.route('**/leaflet*.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx2.route('**/jszip*', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await ctx2.route('**/functions/v1/upright-api/**', makeRouter(state2));
  const page2 = await ctx2.newPage();
  const errors2 = [];
  page2.on('pageerror', (e) => errors2.push(e.message));
  // Safari THROWS on storage in private browsing. A thrown open must not be
  // able to take the recording down with it.
  await page2.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      get() { throw new Error('storage is disabled'); },
    });
  });
  await page2.goto(URL, { waitUntil: 'load' });
  await page2.waitForTimeout(600);
  await page2.click('#enableBtn');
  await page2.waitForTimeout(2500);
  await page2.click('#endBtn');
  await page2.waitForTimeout(2500);

  const txt2 = await page2.textContent('#doneAudio');
  ok('a session still records and uploads when storage is unavailable',
     state2.audioPosts >= 1, 'audio POSTs=' + state2.audioPosts);
  ok('and still reports the audio saved', /saved/i.test(txt2 || ''), JSON.stringify(txt2));
  ok('with no page errors from the dead storage', errors2.length === 0, errors2.join(' | '));

  await browser.close();
  console.log('\n=== ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
