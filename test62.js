// The aiming crosshair's geometry, checked without a browser.
//
//   node test62.js
//
// The functions come out of index.html by source rather than being copied, so
// this checks the code that actually runs. Same trick the numeric tests use.
//
// What is worth pinning here is not "does it move" -- that is obvious the
// moment you hold the iPad -- but the two properties that are invisible until
// they are wrong:
//
//   ROLLING THE IPAD MUST NOT MOVE THE CROSSHAIR. Turning it about the axis it
//   is aiming along changes nothing about where it points, so a crosshair that
//   slid when somebody tilted their wrist would be reading the wrong column of
//   the matrix -- the exact bug the camera bearing shipped with once.
//
//   A CONSTANT COMPASS ERROR MUST CANCEL. The cursor is a pose relative to the
//   shot, so a fixed offset in alpha premultiplies both poses by the same
//   rotation, and a rotation preserves dot products. If that ever stopped being
//   true, an uncalibrated compass would drag the crosshair off the thing being
//   outlined and nothing on screen would say so.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/index.html', 'utf8');

function lift(name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('cannot find ' + name + ' in index.html');
  // Walk the braces so the whole body comes out whatever is inside it.
  let i = src.indexOf('{', at), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
  }
  return src.slice(at, end);
}

const INVERT = /const OUTLINE_INVERT = (-?\d+);/.exec(src);
if (!INVERT) throw new Error('cannot find OUTLINE_INVERT in index.html');

const { orientBasis, outlineProject, dot3 } = new Function(
  'const OUTLINE_INVERT = ' + INVERT[1] + ';\n'
  + lift('orientBasis')
  + '\nconst dot3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];\n'
  + lift('outlineProject')
  + '\nreturn { orientBasis, outlineProject, dot3 };',
)();

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A 1280x720 picture drawn 1000x562 in the middle of a 1000x800 viewport.
const RECT = { x: 0, y: 119, w: 1000, h: 562, iw: 1280, ih: 720 };
const FOV = 62;
const CX = RECT.x + RECT.w / 2, CY = RECT.y + RECT.h / 2;
// Held up, camera aimed at the horizon, screen vertical.
const UP = { a: 0, b: 90, g: 0 };
const at = (a, b, g) => orientBasis(a, b, g);
const shot = at(UP.a, UP.b, UP.g);
const put = (a, b, g, angle = 0) => outlineProject(shot, at(a, b, g), angle, RECT, FOV);

{
  // The basis has to be a basis, or every angle read off it is wrong.
  const B = at(37, 62, -18);
  const len = (v) => Math.hypot(v[0], v[1], v[2]);
  ok('the device axes are unit length',
     near(len(B.x), 1, 1e-12) && near(len(B.y), 1, 1e-12) && near(len(B.cam), 1, 1e-12));
  ok('and mutually perpendicular',
     Math.abs(dot3(B.x, B.y)) < 1e-12 && Math.abs(dot3(B.x, B.cam)) < 1e-12
     && Math.abs(dot3(B.y, B.cam)) < 1e-12);
  ok('the camera looks out of the back of the screen, not into it',
     near(dot3(at(0, 90, 0).cam, [0, 1, 0]), 1, 1e-12),
     'held vertical facing north, the camera axis is due north');
  ok('and at the ground when the iPad is laid flat',
     near(dot3(at(0, 0, 0).cam, [0, 0, 1]), -1, 1e-12));
}

{
  // Not moved: the crosshair starts where the shot was aimed.
  const p = put(UP.a, UP.b, UP.g);
  ok('an untouched iPad leaves the cross dead centre',
     near(p.x, CX, 1e-9) && near(p.y, CY, 1e-9));
}

{
  // THE DIRECTIONS ARE INVERTED, from the hand rather than from the geometry.
  //
  // Read as tracking the scene -- aim at a real corner and the cross lands on
  // that corner in the frozen picture -- the offsets want the sign they are
  // computed with. On the iPad they read backwards, so OUTLINE_INVERT negates
  // both: the picture behaves as though it is dragged under a fixed cross
  // rather than aimed at. These checks pin the sense that SHIPS, and the
  // constant is lifted from the source, so flipping it there fails them here
  // rather than changing the feel of the tool silently.
  //
  // Alpha itself is unchanged and still turns LEFT -- it is counter-clockwise
  // about the up axis, which is why a heading elsewhere in index.html is
  // 360 - alpha.
  const half = put(UP.a + FOV / 2, UP.b, UP.g);
  ok('turning by half the field of view reaches the far edge',
     near(half.x, RECT.x + RECT.w, 0.5), `x=${half.x.toFixed(1)}`);
  ok('and stays on the horizon while it does', near(half.y, CY, 0.5));
  const other = put(UP.a - FOV / 2, UP.b, UP.g);
  ok('turning back the other way reaches the opposite edge',
     near(other.x, RECT.x, 0.5));

  // Half of that is NOT half the distance: the lens is a pinhole, not a ruler.
  const quarter = put(UP.a + FOV / 4, UP.b, UP.g);
  const linear = CX + RECT.w / 4;
  ok('a quarter turn is not a quarter of the way across',
     Math.abs(quarter.x - linear) > 8,
     `pinhole ${quarter.x.toFixed(1)} vs linear ${linear.toFixed(1)}`);
  ok('and it is nearer the middle than a straight scaling would put it',
     quarter.x < linear);
}

{
  // BETA PAST 90 AIMS UP. Below 90 the camera is tipped toward the ground: at
  // beta 80 the axis has a downward component, at 100 an upward one. Inverted,
  // aiming higher runs the cross DOWN the picture.
  const upward = put(UP.a, UP.b + 10, UP.g);
  ok('aiming higher moves the cross down the picture', upward.y > CY + 20,
     `y=${upward.y.toFixed(1)} against a centre of ${CY}`);
  const downward = put(UP.a, UP.b - 10, UP.g);
  ok('and aiming lower moves it up', downward.y < CY - 20);
}

{
  // ROLL INVARIANCE, with a roll that is actually a roll.
  //
  // Gamma is NOT roll: it turns about the device's own y axis, which for an
  // iPad held vertical is a yaw. Held vertical the axis obeys alpha + gamma
  // alone -- so a genuine roll about the viewing axis is the pair moving
  // together and cancelling, which is what the aim being unchanged means.
  const held = orientBasis(UP.a, UP.b, UP.g);
  for (const d of [-45, -30, -10, 10, 30, 45]) {
    const p = outlineProject(held, at(UP.a + d, UP.b, UP.g - d), 0, RECT, FOV);
    ok(`rolling ${d}° in the hand leaves the cross where it was`,
       near(p.x, CX, 1.5) && near(p.y, CY, 1.5),
       `landed ${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  }
  // And the thing that is easy to confuse it with really does move it, so the
  // check above is not passing because nothing moves anything.
  const yawed = outlineProject(held, at(UP.a, UP.b, UP.g + 10), 0, RECT, FOV);
  ok('while turning gamma alone -- a yaw, not a roll -- does move it',
     Math.abs(yawed.x - CX) > 50);
}

{
  // A CONSTANT COMPASS ERROR CANCELS. Offset alpha in both poses by the same
  // amount and nothing moves.
  for (const off of [17, 90, -140, 250]) {
    const base = at(UP.a + off, UP.b, UP.g);
    const now = at(UP.a + off + 12, UP.b, UP.g);
    const p = outlineProject(base, now, 0, RECT, FOV);
    const clean = put(UP.a + 12, UP.b, UP.g);
    ok(`a ${off}° compass error changes nothing`,
       near(p.x, clean.x, 1e-6) && near(p.y, clean.y, 1e-6));
  }
}

{
  // The cross cannot leave the picture: a corner marked outside it would map
  // to a pixel the saved photograph does not have.
  const wild = put(UP.a + 170, UP.b, UP.g);
  ok('a wild swing is clamped to the picture',
     wild.x >= RECT.x && wild.x <= RECT.x + RECT.w
     && wild.y >= RECT.y && wild.y <= RECT.y + RECT.h);
}

{
  // Turning the iPad turns the mapping with it, or the cross would run
  // sideways when it should run up.
  const turned = put(UP.a + FOV / 4, UP.b, UP.g, 90);
  ok('at 90° of screen rotation a yaw moves the cross vertically',
     Math.abs(turned.y - CY) > 20 && Math.abs(turned.x - CX) < 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
