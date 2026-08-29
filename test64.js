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
  await ctx.route('**/functions/v1/upright-api/**', (r) => {
    const url = r.request().url();
    if (url.includes('/properties')) {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ properties: PROPERTIES }) });
    }
    if (/\/sessions(\?|$)/.test(url)) {
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ sessions: SESSIONS, limit: 50, offset: 0 }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  const page = await ctx.newPage();
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
