// Проверка жестов: взаимная похожесть шаблонов и распознавание неаккуратных росчерков.
// Запуск: node tools/gesture_test.js
// Чтобы примерить новый жест до добавления в игру — впиши его в CAND и передай имя аргументом:
//   node tools/gesture_test.js myshape
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const code = html.slice(html.indexOf('// ---REC START'), html.indexOf('// ---REC END'));
const { recognize, normalize, SHAPES, TEMPLATES, seg, arc, distBestAngle, SIZE } =
  new Function(code + ';return {recognize,normalize,SHAPES,TEMPLATES,seg,arc,distBestAngle,SIZE};')();

const CAND = {};
const only = process.argv.slice(2);
for (const k of only) if (CAND[k] && !SHAPES[k]) { SHAPES[k] = CAND[k]; TEMPLATES[k] = normalize(SHAPES[k]()); }
const ids = Object.keys(TEMPLATES);
const pad = s => (s + '             ').slice(0, 13);
const score = (p, id) => Math.max(0, 1 - distBestAngle(p, TEMPLATES[id]) / (0.5 * Math.SQRT2 * SIZE));

console.log('\nПохожесть шаблонов (выше = легче спутать; свой = 1.00):');
console.log(pad('') + ids.map(i => pad(i.slice(0, 6))).join(''));
let worst = { s: 0 };
for (const a of ids) {
  const row = ids.map(b => { const s = a === b ? 1 : score(TEMPLATES[a], b); if (a !== b && s > worst.s) worst = { s, a, b }; return s; });
  console.log(pad(a) + row.map(s => pad(s.toFixed(2))).join(''));
}
console.log(`Самая близкая пара: ${worst.a} ~ ${worst.b} = ${worst.s.toFixed(2)}`);

// Неаккуратный росчерк: белый шум ±jitter, плавная волна, поворот ±8°, сжатие по осям 0.8–1.25.
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
function sloppy(id, jitter) {
  const base = SHAPES[id]();
  const S = 260, rot = (rnd() * 16 - 8) * Math.PI / 180, sx = .8 + rnd() * .45, sy = .8 + rnd() * .45;
  const ph = rnd() * 6.28, amp = 6 + rnd() * 10, fr = 1 + rnd() * 2, c = Math.cos(rot), s = Math.sin(rot);
  return base.map((p, i) => {
    let x = (p.x - .5) * S * sx, y = (p.y - .5) * S * sy;
    const wob = amp * Math.sin(ph + fr * i / base.length * 6.28);
    x += gauss() * jitter + wob; y += gauss() * jitter - wob;
    return { x: x * c - y * s + 200, y: x * s + y * c + 200 };
  });
}
for (const jitter of [15, 30]) {
  console.log(`\nНеаккуратные росчерки, дрожание ±${jitter}px (K=300):`);
  let allOk = true;
  for (const id of ids) {
    let ok = 0, sum = 0, tiers = [0, 0, 0, 0]; const conf = {};
    for (let k = 0; k < 300; k++) {
      const r = recognize(sloppy(id, jitter), TEMPLATES);
      if (r.id === id) { ok++; sum += r.score; } else conf[r.id] = (conf[r.id] || 0) + 1;
      tiers[r.score < .62 ? 0 : r.score < .78 ? 1 : r.score < .9 ? 2 : 3]++;
    }
    const acc = ok / 300; if (acc < .9) allOk = false;
    const top = Object.entries(conf).sort((a, b) => b[1] - a[1])[0];
    console.log(`${pad(id)} точность ${(acc * 100).toFixed(0).padStart(3)}%  средний балл ${(ok ? sum / ok : 0).toFixed(2)}  осечка/слабо/чётко/мастер ${tiers.join('/')}` + (top ? `  путается с ${top[0]} ×${top[1]}` : ''));
  }
  console.log(allOk ? 'Все ≥90%' : 'ЕСТЬ НИЖЕ 90%');
}
