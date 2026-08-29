// Past sessions as map tiles, driven through the real UI in a real browser.
//
//   NODE_PATH=$(npm root -g) node test64.js      (needs playwright)
//
// A picture of the yard is the whole point, so the checks that matter are
// about the RENDERED tiles: does a session with a located property get map
// imagery, is that imagery positioned so the property is at the centre rather
// than wherever it happens to fall in a tile, and does a session with nowhere
// to show say so instead of drawing a grey box.
//
// It also covers CHOOSING SEVERAL AT ONCE, which is the other thing a tile
// view is for: the checks that matter there are that a tap in the mode does
// not open a session, that exactly the chosen ids are DELETEd, and that one
// that refuses is named and stays chosen rather than being quietly dropped.
//
// Every network call is stubbed. Nothing here needs Supabase, Esri or Leaflet
// to be reachable, and the sandbox cannot reach any of them.

const { chromium } = require('playwright');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// A 1x1 transparent PNG, standing in for Esri's imagery.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const LEAFLET_STUB = `window.L = (function(){
  const make = () => new Proxy(function(){}, {
    get: (t, k) => (k === Symbol.toPrimitive || k === 'valueOf') ? () => 0
                 : (k === 'then') ? undefined : make(),
    apply: () => make(), construct: () => make(),
  });
  return make();
})();`;

// Two properties: one with a position, one without. Three sessions covering
// every case a tile has to render.
const PROPERTIES = [
  { id: 1, address: '665 S. Baums Bridge Rd.', latitude: 41.3241, longitude: -87.1997 },
  { id: 2, address: '87 Gingerwood Ct.', latitude: null, longitude: null },
];
const SESSIONS = [
  { id: 'a', name: 'Yoder', startedAt: '2026-08-29T15:20:20Z', hasAudio: true,
    durationSeconds: 24, propertyId: 1, propertyAddress: '665 S. Baums Bridge Rd.',
    photoCount: 2, clipCount: 2, sketchCount: 0, measureCount: 0,
    elevationPointCount: 0, transcriptStatus: 'none' },
  { id: 'b', name: null, startedAt: '2026-08-24T10:02:00Z', hasAudio: false,
    durationSeconds: null, propertyId: 2, propertyAddress: '87 Gingerwood Ct.',
    photoCount: 1, clipCount: 0, sketchCount: 0, measureCount: 0,
    elevationPointCount: 0, transcriptStatus: 'none' },
  { id: 'c', name: null, startedAt: '2026-08-20T09:00:00Z', hasAudio: true,
    durationSeconds: 600, propertyId: null, propertyAddress: null,
    photoCount: 0, clipCount: 0, sketchCount: 0, measureCount: 0,
    elevationPointCount: 0, transcriptStatus: 'completed' },
];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 } });

  await ctx.route('**/leaflet*.js', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_STUB }));
  await ctx.route('**/leaflet*.css', (r) =>
    r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  let tileRequests = 0;
  await ctx.route('**/World_Imagery/**', (r) => {
    tileRequests++;
    return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  // Deletes are honoured, so the grid really shrinks and the refresh after a
  // batch is reading a changed world rather than the same one.
  const deleted = new Set();
  const deleteCalls = [];
  /** An id whose DELETE refuses, for the half-failed batch. */
  let refuseId = null;
  await ctx.route('**/functions/v1/upright-api/**', (r) => {
    const url = r.request().url();
    if (url.includes('/properties')) {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ properties: PROPERTIES }) });
    }
    const del = r.request().method() === 'DELETE' && /\/sessions\/([^/?]+)$/.exec(url);
    if (del) {
      const id = del[1];
      deleteCalls.push(id);
      if (id === refuseId) {
        return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' });
      }
      deleted.add(id);
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (/\/sessions(\?|$)/.test(url)) {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ sessions: SESSIONS.filter((s) => !deleted.has(s.id)),
                               limit: 50, offset: 0 }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  const page = await ctx.newPage();
  // Both confirmations, captured: the first one has to NAME what goes, since
  // "7 sessions" is not something anybody can check.
  const dialogs = [];
  let dialogAction = 'accept';
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    return dialogAction === 'accept' ? d.accept() : d.dismiss();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await page.goto('file://' + __dirname + '/index.html');
  await page.waitForTimeout(400);

  await page.click('#historyBtn');
  await page.waitForTimeout(500);

  const listed = await page.evaluate(() => ({
    rows: document.querySelectorAll('.hist-row').length,
    gridHidden: getComputedStyle(document.getElementById('histGrid')).display === 'none',
    button: document.getElementById('historyView').textContent,
  }));
  ok('the list is what opens', listed.rows === 3 && listed.gridHidden);
  ok('and the switch offers tiles', listed.button === 'Tiles', listed.button);

  await page.click('#historyView');
  await page.waitForTimeout(600);

  const tiled = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.hist-tile')];
    const first = tiles[0];
    const box = first ? first.querySelector('.map') : null;
    const imgs = box ? [...box.querySelectorAll('img')] : [];
    const br = box ? box.getBoundingClientRect() : null;
    return {
      count: tiles.length,
      listHidden: getComputedStyle(document.getElementById('histList')).display === 'none',
      button: document.getElementById('historyView').textContent,
      mapImgs: imgs.length,
      // Does the imagery actually cover the tile, on all four sides?
      covers: br && imgs.length ? (() => {
        const rs = imgs.map((i) => i.getBoundingClientRect());
        return Math.min(...rs.map((r) => r.left)) <= br.left + 1
            && Math.max(...rs.map((r) => r.right)) >= br.right - 1
            && Math.min(...rs.map((r) => r.top)) <= br.top + 1
            && Math.max(...rs.map((r) => r.bottom)) >= br.bottom - 1;
      })() : false,
      captions: tiles.map((t) => t.querySelector('.cap .t').textContent),
      whens: tiles.map((t) => t.querySelector('.cap .w').textContent),
      noMaps: tiles.map((t) => {
        const n = t.querySelector('.nomap');
        return n ? n.textContent : null;
      }),
      warnPips: tiles.filter((t) => t.querySelector('.warnpip')).length,
    };
  });

  ok('every session gets a tile', tiled.count === 3, `${tiled.count} tiles`);
  ok('and the list stands down', tiled.listHidden);
  ok('the switch offers the list back', tiled.button === 'List', tiled.button);

  ok('a located property gets map imagery', tiled.mapImgs > 0, `${tiled.mapImgs} tiles`);
  ok('AND THE IMAGERY COVERS THE TILE, so the yard is centred rather than'
     + '\n      wherever it fell in one map tile', tiled.covers);
  ok('the imagery was actually fetched', tileRequests > 0, `${tileRequests} requests`);

  ok('a tile is captioned by what identifies the session',
     tiled.captions[0] === 'Yoder', tiled.captions.join(' | '));
  ok('an untagged one says so rather than looking broken',
     tiled.captions[2] === 'Untagged session', tiled.captions[2]);
  ok('and the caption carries when it was',
     /Aug/.test(tiled.whens[0]), tiled.whens[0]);

  // The two ways a tile can have nowhere to show, which are different problems
  // and get different words.
  ok('a property with no coordinates says THAT, not "untagged"',
     /no map location/i.test(tiled.noMaps[1] || ''), tiled.noMaps[1]);
  ok('a session with no property says it is not tagged',
     /not tagged/i.test(tiled.noMaps[2] || ''), tiled.noMaps[2]);

  ok('a session that cannot be replayed is flagged on its tile',
     tiled.warnPips === 1, `${tiled.warnPips} flagged`);

  // ---------- choosing several at once ----------
  //
  // The whole point is bulk: 48 of the sessions on file are test runs recorded
  // at the shop, and clearing those one tile at a time is four taps and two
  // confirmations each.
  const armed = await page.evaluate(() => ({
    selectShown: getComputedStyle(document.getElementById('historySelect')).display !== 'none',
    barShown: document.getElementById('histBar').classList.contains('show'),
    checks: document.querySelectorAll('.hist-tile .pick').length,
  }));
  ok('the tile view offers Select', armed.selectShown);
  ok('and nothing is ticked until it is asked for',
     !armed.barShown && armed.checks === 0, `${armed.checks} checks`);

  await page.click('#historySelect');
  await page.waitForTimeout(120);
  const onNow = await page.evaluate(() => ({
    barShown: document.getElementById('histBar').classList.contains('show'),
    checks: document.querySelectorAll('.hist-tile .pick').length,
    count: document.getElementById('histPickCount').textContent,
    delDisabled: document.getElementById('histPickDelete').disabled,
    selectHidden: getComputedStyle(document.getElementById('historySelect')).display === 'none',
  }));
  ok('Select arms the mode and puts a check on every tile',
     onNow.barShown && onNow.checks === 3, JSON.stringify(onNow));
  ok('with nothing chosen yet, and Delete refusing to be pressed',
     onNow.delDisabled && /choose/i.test(onNow.count), onNow.count);
  ok('and Select stands down while the bar is up', onNow.selectHidden);

  // A TAP MUST NOT OPEN THE SESSION. That is the whole risk of a mode: the
  // gesture is the same one, and landing in a visit you meant to tick is a
  // long way back.
  await page.click('.hist-tile >> nth=0');
  await page.waitForTimeout(150);
  const afterTap = await page.evaluate(() => ({
    picked: document.querySelectorAll('.hist-tile.picked').length,
    count: document.getElementById('histPickCount').textContent,
    delLabel: document.getElementById('histPickDelete').textContent,
    stillOnHistory: document.getElementById('historyPanel').classList.contains('show'),
  }));
  ok('a tap chooses rather than opening the session',
     afterTap.picked === 1 && afterTap.stillOnHistory, JSON.stringify(afterTap));
  ok('and the bar counts what is chosen',
     /1 chosen/.test(afterTap.count) && afterTap.delLabel === 'Delete 1', afterTap.delLabel);

  await page.click('.hist-tile >> nth=0');
  await page.waitForTimeout(120);
  ok('tapping it again lets it go',
     (await page.evaluate(() => document.querySelectorAll('.hist-tile.picked').length)) === 0);

  await page.click('#histPickAll');
  await page.waitForTimeout(120);
  const all = await page.evaluate(() => ({
    picked: document.querySelectorAll('.hist-tile.picked').length,
    label: document.getElementById('histPickAll').textContent,
    del: document.getElementById('histPickDelete').textContent,
  }));
  ok('Select all takes the lot', all.picked === 3 && all.del === 'Delete 3', JSON.stringify(all));
  ok('and the same button then offers to let them go', all.label === 'Select none', all.label);
  await page.click('#histPickAll');
  await page.waitForTimeout(120);
  ok('which it does',
     (await page.evaluate(() => document.querySelectorAll('.hist-tile.picked').length)) === 0);

  // Backing out of the first confirmation deletes nothing. It is the ask that
  // has to be refusable, not just the mode.
  await page.click('.hist-tile >> nth=1');
  await page.waitForTimeout(100);
  dialogs.length = 0;
  dialogAction = 'dismiss';
  await page.click('#histPickDelete');
  await page.waitForTimeout(250);
  ok('the first confirmation names the session, not just a count',
     dialogs.length === 1 && /Gingerwood/.test(dialogs[0]), dialogs[0] || '(none)');
  ok('and says what goes with it',
     /photo pin/.test(dialogs[0] || ''), dialogs[0] || '(none)');
  ok('saying no deletes nothing', deleteCalls.length === 0, deleteCalls.join(','));
  ok('and leaves the choice standing',
     (await page.evaluate(() => document.querySelectorAll('.hist-tile.picked').length)) === 1);

  // Two of the three, one of which refuses. Exactly the chosen ids go, and the
  // refusal is named rather than swallowed.
  await page.click('.hist-tile >> nth=2');
  await page.waitForTimeout(100);
  dialogs.length = 0;
  dialogAction = 'accept';
  refuseId = 'c';
  await page.click('#histPickDelete');
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({
    tiles: [...document.querySelectorAll('.hist-tile')].map((t) => t.dataset.session),
    picked: [...document.querySelectorAll('.hist-tile.picked')].map((t) => t.dataset.session),
    status: document.getElementById('histStatus').textContent,
    err: document.getElementById('histStatus').classList.contains('err'),
    barShown: document.getElementById('histBar').classList.contains('show'),
  }));
  ok('it asks twice for a batch, and only twice', dialogs.length === 2, String(dialogs.length));
  ok('EXACTLY the chosen sessions are deleted, and no others',
     deleteCalls.slice().sort().join(',') === 'b,c', deleteCalls.join(','));
  ok('the one that went is gone from the grid',
     !after.tiles.includes('b') && after.tiles.includes('a'), after.tiles.join(','));
  ok('the one that refused is still there', after.tiles.includes('c'), after.tiles.join(','));
  ok('IT IS NAMED, not swallowed',
     after.err && /could not be deleted/i.test(after.status), after.status);
  ok('and it stays chosen, so a retry is one tap',
     after.picked.length === 1 && after.picked[0] === 'c', after.picked.join(','));
  ok('so the mode stays open around it', after.barShown);

  // Cancel puts it down.
  await page.click('#histPickCancel');
  await page.waitForTimeout(120);
  const cancelled = await page.evaluate(() => ({
    barShown: document.getElementById('histBar').classList.contains('show'),
    checks: document.querySelectorAll('.hist-tile .pick').length,
    picked: document.querySelectorAll('.hist-tile.picked').length,
  }));
  ok('Cancel takes the checks off every tile',
     !cancelled.barShown && cancelled.checks === 0 && cancelled.picked === 0,
     JSON.stringify(cancelled));

  // A hold is the other way in, and the click that follows it must not undo it.
  await page.hover('.hist-tile >> nth=0');
  await page.mouse.down();
  await page.waitForTimeout(750);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const held = await page.evaluate(() => ({
    barShown: document.getElementById('histBar').classList.contains('show'),
    picked: document.querySelectorAll('.hist-tile.picked').length,
    stillOnHistory: document.getElementById('historyPanel').classList.contains('show'),
  }));
  ok('a hold arms the mode on the tile held',
     held.barShown && held.picked === 1, JSON.stringify(held));
  ok('and the click that follows the hold does not undo it, nor open the session',
     held.picked === 1 && held.stillOnHistory);

  // The mode belongs to the tiles.
  await page.click('#historyView');
  await page.waitForTimeout(300);
  const toList = await page.evaluate(() => ({
    barShown: document.getElementById('histBar').classList.contains('show'),
    selectShown: getComputedStyle(document.getElementById('historySelect')).display !== 'none',
  }));
  ok('switching to the list puts the mode down',
     !toList.barShown && !toList.selectShown, JSON.stringify(toList));
  await page.click('#historyView');
  await page.waitForTimeout(400);
  ok('and coming back to tiles does not bring a stale selection with it',
     (await page.evaluate(() => document.querySelectorAll('.hist-tile.picked').length)) === 0);

  // The choice is a preference, not a mood.
  await page.click('#historyClose');
  await page.waitForTimeout(150);
  await page.click('#historyBtn');
  await page.waitForTimeout(600);
  const remembered = await page.evaluate(() => ({
    grid: getComputedStyle(document.getElementById('histGrid')).display !== 'none',
    stored: JSON.parse(localStorage.getItem('upright.prefs') || '{}').historyTiles,
  }));
  ok('the view is remembered on reopening', remembered.grid);
  ok('and it is stored as a preference', remembered.stored === true);

  ok('nothing threw along the way', errors.length === 0, errors.join(' / '));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
