// The aiming outline, driven through the real UI in a real browser.
//
//   NODE_PATH=$(npm root -g) node test63.js      (needs playwright)
//
// WHY THIS EXISTS, AND WHY test62 WAS NOT ENOUGH. test62 proves the geometry:
// where the crosshair should be, to fourteen decimal places. It cannot see
// whether the crosshair is on the screen at all -- and it was not. The SVG had
// no width or height, so it took an SVG's intrinsic 300x150, clipped to that,
// and threw away every mark drawn where the picture actually is. The maths was
// right and nothing appeared.
//
// That is the same lesson the flow arrows learned: the maths was verified and
// the rendering was not. So this reads the RENDERED elements -- is the cross
// inside its own overlay, does the hint change when it comes back to the first
// corner, does closing put the camera back.
//
// The sandbox cannot reach Supabase or the Leaflet CDN, so both are stubbed.
// Nothing being tested here touches either: the outline is client-side, and the
// map only has to survive being built.

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

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
           '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 } });

  await ctx.route('**/leaflet*.js', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_STUB }));
  await ctx.route('**/leaflet*.css', (r) =>
    r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.route('**/functions/v1/upright-api/**', (r) =>
    r.request().url().endsWith('/assemblies')
      ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          assemblies: [
            { id: 'mulch_bed_installation_standard', name: 'Mulch Bed Installation – Standard',
              shortName: 'Mulch Bed', unitOfWork: 'sq_ft' },
            { id: 'lawn_installation_standard', name: 'Lawn Installation – Standard',
              shortName: 'Lawn', unitOfWork: 'sq_ft' },
          ] }) })
      : r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"id":"stub"}' }));

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await page.goto('file://' + __dirname + '/index.html');
  await page.waitForTimeout(400);

  // A real iPad reports about sixty times a second and the crosshair is
  // smoothed, so one synthetic event only moves it a fraction of the way.
  const aim = (alpha, beta, gamma, n = 25) => page.evaluate(([a, b, g, count]) => {
    for (let i = 0; i < count; i++) {
      const e = new Event('deviceorientation');
      Object.assign(e, { alpha: a, beta: b, gamma: g, absolute: true });
      window.dispatchEvent(e);
    }
  }, [alpha, beta, gamma, n]);

  await page.click('#enableBtn');
  await page.waitForTimeout(1200);
  // Stand it up and HOLD: the flat/upright switch waits out HOLD_MS.
  for (let i = 0; i < 14; i++) { await aim(0, 90, 0, 1); await page.waitForTimeout(60); }
  await page.waitForTimeout(400);

  const view = await page.evaluate(() => ({
    mapUp: document.querySelector('.mapwrap').classList.contains('show'),
    shutter: getComputedStyle(document.getElementById('snapBtn')).display !== 'none',
    tiles: [...document.querySelectorAll('.asm-tile')].map((n) => n.textContent),
  }));
  ok('the camera comes up when the iPad is stood on end', !view.mapUp && view.shutter);
  ok('and the take-off tiles are there with it', view.tiles.length === 2,
     view.tiles.join(' | '));
  ok('the tiles are labelled short enough for a thumb', view.tiles[0] === 'Mulch Bed');

  await page.click('.asm-tile');           // Mulch: the one that outlines
  await page.waitForTimeout(300);
  await aim(-6, 92, 0);
  await page.waitForTimeout(150);

  const frozen = await page.evaluate(() => {
    const hud = document.getElementById('outlineHud');
    const circles = hud.querySelectorAll('circle');
    const cross = circles[circles.length - 1];
    const h = hud.getBoundingClientRect();
    const c = cross ? cross.getBoundingClientRect() : null;
    const f = document.getElementById('outlineFrame').getBoundingClientRect();
    return {
      showing: document.getElementById('outlineFrame').classList.contains('show'),
      hudBox: [Math.round(h.width), Math.round(h.height)],
      frameBox: [Math.round(f.width), Math.round(f.height)],
      hasCross: !!cross,
      inside: c ? (c.left >= h.left && c.right <= h.right
                   && c.top >= h.top && c.bottom <= h.bottom) : false,
      tilesGone: document.querySelectorAll('.asm-tile').length === 0,
    };
  });
  ok('tapping Mulch freezes the picture', frozen.showing);
  ok('the overlay is the size of the picture, not an SVG default',
     frozen.hudBox[0] === frozen.frameBox[0] && frozen.hudBox[1] === frozen.frameBox[1],
     `hud ${frozen.hudBox} vs frame ${frozen.frameBox}`);
  ok('there is a crosshair', frozen.hasCross);
  ok('AND IT IS INSIDE THE OVERLAY, which is the whole bug this test exists for',
     frozen.inside);
  ok('the tiles stand down while an outline is open', frozen.tilesGone);

  for (const [a, b] of [[-6, 92], [6, 92], [6, 84]]) {
    await aim(a, b, 0);
    await page.waitForTimeout(100);
    await page.click('#snapBtn');
    await page.waitForTimeout(100);
  }
  const three = await page.evaluate(() =>
    document.getElementById('outlineHint').textContent);
  ok('the shutter marks corners and they are counted', /3 corners/.test(three), three);

  await aim(-6, 92, 0);
  await page.waitForTimeout(200);
  const back = await page.evaluate(() =>
    document.getElementById('outlineHint').textContent);
  ok('coming back to the first corner offers to close', /closes/.test(back), back);

  await page.click('#snapBtn');
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    unfrozen: !document.getElementById('outlineFrame').classList.contains('show'),
    hudEmpty: document.getElementById('outlineHud').innerHTML === '',
    tilesBack: document.querySelectorAll('.asm-tile').length,
    shutter: getComputedStyle(document.getElementById('snapBtn')).display !== 'none',
  }));
  ok('closing puts the camera back', after.unfrozen && after.shutter);
  ok('and clears the overlay behind it', after.hudEmpty);
  ok('and the tiles return', after.tilesBack === 2);

  ok('nothing threw along the way', errors.length === 0, errors.join(' / '));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
