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
  await page.waitForTimeout(200);

  // SETTLING. The reference pose is not the one the picture was shot at: the
  // iPad was held up for that and nobody wants to keep holding it there. So
  // the cross waits, and centres wherever the hand comes to rest.
  const settling = await page.evaluate(() => {
    const t = document.querySelector('#outlineHud text');
    const hud = document.getElementById('outlineHud').getBoundingClientRect();
    const tb = t ? t.getBoundingClientRect() : null;
    return {
      frozen: document.getElementById('outlineFrame').classList.contains('show'),
      cross: document.querySelectorAll('#outlineHud circle').length,
      hint: document.getElementById('outlineHint').textContent,
      label: t ? t.textContent : null,
      labelLow: tb ? (tb.top > hud.top + hud.height * 0.6) : false,
      ...(() => {
        const c = document.getElementById('outlineEdges');
        if (!c.classList.contains('show')) return { edgesShown: false, edgePixels: 0, edgesAligned: false };
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let lit = 0, minY = c.height, maxY = 0;
        for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
          if (d[(y * c.width + x) * 4 + 3] > 0) { lit++; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        }
        // The picture is letterboxed, so nothing should be lit in the bars.
        const fr = document.getElementById('outlineFrame').getBoundingClientRect();
        const iw = 1280, ih = 720;
        const sc = Math.min(fr.width / iw, fr.height / ih);
        const top = (fr.height - ih * sc) / 2, bot = top + ih * sc;
        return {
          edgesShown: true, edgePixels: lit,
          edgesAligned: lit === 0 || (minY >= top - 4 && maxY <= bot + 4),
        };
      })(),
    };
  });
  ok('the picture freezes immediately', settling.frozen);
  ok('the detected edges are drawn over it', settling.edgesShown);
  ok('and something was actually found in the frame', settling.edgePixels > 0,
     `${settling.edgePixels} lit pixels`);
  ok('the edge layer is registered with the picture, not the element',
     settling.edgesAligned, 'it draws into the letterboxed rect');
  ok('and it is captioned with the take-off it is of',
     settling.label === 'Mulch Bed', settling.label);
  ok('the caption sits at the bottom of the picture',
     settling.labelLow, 'a caption over the middle would cover the bed');
  ok('but no cross appears until it has a centre', settling.cross === 0);
  ok('and it says to get comfortable first',
     /comfortable/i.test(settling.hint), settling.hint);

  // Move the way somebody lowering the iPad would, then hold.
  for (const b of [92, 100, 112, 124, 132]) { await aim(0, b, 0, 3); await page.waitForTimeout(70); }
  const midMove = await page.evaluate(() =>
    document.querySelectorAll('#outlineHud circle').length);
  ok('moving does not centre it -- it waits for the hand to stop', midMove === 0);

  // Come to rest at the lowered posture and let the settle window run.
  for (let i = 0; i < 12; i++) { await aim(0, 132, 0, 2); await page.waitForTimeout(70); }
  const settled = await page.evaluate(() => {
    const c = document.querySelectorAll('#outlineHud circle');
    const cross = c[c.length - 1];
    const h = document.getElementById('outlineHud').getBoundingClientRect();
    const b = cross ? cross.getBoundingClientRect() : null;
    return {
      cross: c.length,
      centred: b ? (Math.abs(b.left + b.width / 2 - (h.left + h.width / 2)) < 6
                    && Math.abs(b.top + b.height / 2 - (h.top + h.height / 2)) < 6) : false,
      hint: document.getElementById('outlineHint').textContent,
    };
  });
  ok('holding still brings the cross out', settled.cross > 0, settled.hint);
  ok('AND IT CENTRES AT THE NEW POSTURE, not the one the shot was taken at',
     settled.centred,
     'the iPad was tipped 42 degrees back after the shutter');

  await aim(-6, 134, 0);
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

  for (const [a, b] of [[-6, 134], [6, 134], [6, 126]]) {
    await aim(a, b, 0);
    await page.waitForTimeout(100);
    await page.click('#snapBtn');
    await page.waitForTimeout(100);
  }
  const three = await page.evaluate(() =>
    document.getElementById('outlineHint').textContent);
  ok('the shutter marks corners and they are counted', /3 corners/.test(three), three);

  await aim(-6, 134, 0);
  await page.waitForTimeout(200);
  const back = await page.evaluate(() =>
    document.getElementById('outlineHint').textContent);
  ok('coming back to the first corner offers to close', /closes/.test(back), back);

  await page.click('#snapBtn');
  // The finished ring is held up before the camera comes back, so what is on
  // screen a moment after closing is the outline, not a live preview.
  await page.waitForTimeout(180);
  const held = await page.evaluate(() => ({
    stillShowing: document.getElementById('outlineFrame').classList.contains('show'),
    closedRing: !!document.querySelector('#outlineHud polygon'),
    crossGone: document.querySelectorAll('#outlineHud line').length === 0,
    label: document.querySelector('#outlineHud text')
      ? document.querySelector('#outlineHud text').textContent : null,
    hint: document.getElementById('outlineHint').textContent,
  }));
  ok('the finished ring is held on screen rather than vanishing', held.stillShowing);
  ok('and it is drawn CLOSED, as a ring rather than a trail', held.closedRing);
  ok('with the crosshair gone, since there is nothing left to aim',
     held.crossGone);
  ok('and it says the outline was saved', /saved/i.test(held.hint), held.hint);
  ok('the caption is still under it while it is held',
     held.label === 'Mulch Bed', held.label);

  // Still up most of a second later: the hold is OUTLINE_HELD_MS, not a blink.
  await page.waitForTimeout(500);
  const midHold = await page.evaluate(() =>
    document.getElementById('outlineFrame').classList.contains('show'));
  ok('and it is still up two thirds of a second after closing', midHold);

  await page.waitForTimeout(700);
  const after = await page.evaluate(() => ({
    unfrozen: !document.getElementById('outlineFrame').classList.contains('show'),
    hudEmpty: document.getElementById('outlineHud').innerHTML === '',
    tilesBack: document.querySelectorAll('.asm-tile').length,
    shutter: getComputedStyle(document.getElementById('snapBtn')).display !== 'none',
  }));
  ok('closing puts the camera back', after.unfrozen && after.shutter);
  ok('and clears the overlay behind it', after.hudEmpty);
  ok('and the tiles return', after.tilesBack === 2);

  // ---- closing by HOLDING the shutter, rather than walking back to the first
  // corner. The last corner and the instruction to close are one thought.
  await page.click('.asm-tile');
  await page.waitForTimeout(200);
  for (let i = 0; i < 14; i++) { await aim(0, 120, 0, 2); await page.waitForTimeout(70); }
  const hold = async (ms) => {
    const box = await page.$eval('#snapBtn', (n) => {
      const r = n.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
    await page.mouse.move(box[0], box[1]);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
  };

  await aim(-5, 120, 0); await page.waitForTimeout(100);
  await hold(120);                                  // a tap: marks one corner
  await page.waitForTimeout(120);
  const oneCorner = await page.evaluate(() =>
    document.getElementById('outlineHint').textContent);
  ok('a brief press still just marks a corner', /1 corner/.test(oneCorner), oneCorner);
  ok('and the hint teaches the hold', /hold it to finish/i.test(oneCorner), oneCorner);

  await aim(5, 120, 0); await page.waitForTimeout(100);
  await hold(120);
  await page.waitForTimeout(120);
  const twoCorners = await page.evaluate(() =>
    document.getElementById('outlineHint').textContent);
  ok('two corners down', /2 corners/.test(twoCorners), twoCorners);

  // A hold with only two corners down has no ring to close, so it marks a third
  // rather than throwing the outline away as a cancel.
  await aim(5, 112, 0); await page.waitForTimeout(100);
  await hold(700);
  await page.waitForTimeout(1500);     // the hold-up, then the exit
  const closed = await page.evaluate(() => ({
    unfrozen: !document.getElementById('outlineFrame').classList.contains('show'),
    hudEmpty: document.getElementById('outlineHud').innerHTML === '',
    tiles: document.querySelectorAll('.asm-tile').length,
  }));
  ok('HOLDING the shutter drops the last corner and closes the ring',
     closed.unfrozen && closed.hudEmpty);
  ok('and the camera comes back with its tiles', closed.tiles === 2);

  // The click that follows a hold must not ALSO drop a corner -- if it did, a
  // hold would close the ring and then start a stray outline gesture.
  const stray = await page.evaluate(() =>
    document.getElementById('outlineFrame').classList.contains('show'));
  ok('and the tap after the hold does not act again', !stray);


  // The two Settings switches exist and default to following the aim, which is
  // what every direction check in test62 assumes.
  // Opened at the END, and from the start screen's own gear: renderPrefs()
  // only runs on openSettings(), so the switch classes are unset before that.
  await page.evaluate(() => document.getElementById('settingsBtn').click());
  await page.waitForTimeout(200);
  const sense = await page.evaluate(() => {
    const open = document.getElementById('prefOutlineAimX');
    return open ? {
      x: open.classList.contains('on'),
      y: document.getElementById('prefOutlineAimY').classList.contains('on'),
      xLabel: open.closest('.pref-row').querySelector('.pref-title').textContent,
    } : null;
  });
  ok('the outline sense is a Settings switch per axis', !!sense);
  ok('and both default to following the aim', sense && sense.x && sense.y);
  ok('the sideways one names the axis it governs',
     sense && /sideways/i.test(sense.xLabel), sense && sense.xLabel);

  // Optional, and off means off.
  const edgeToggle = await page.evaluate(() => {
    const sw = document.getElementById('prefOutlineEdges');
    return sw ? { present: true, on: sw.classList.contains('on') } : { present: false };
  });
  ok('the edge hint is a Settings switch', edgeToggle.present);
  ok('and it is on by default', edgeToggle.on);

  ok('nothing threw along the way', errors.length === 0, errors.join(' / '));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
