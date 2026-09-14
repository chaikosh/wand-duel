// Headless-симулятор дуэли для проверки баланса. Запуск: node tools/sim.js [--duels N] [--defpay 0|1] [--only подстрока] [--seed N]
// Правила (SPELLS, MULT, tierOf, DIFF, resolve, aiCast, aiPickAttack, aiPickDefense, mkPlayer) берутся из index.html
// напрямую (срезы исходника через new Function), ход (playTurn) переигран здесь без DOM и задержек.
// Защищающийся платит концентрацию за защиту с обеих сторон (--defpay 1, по умолчанию, как в игре после правки
// 2026-09-15). --defpay 0 воспроизводит старое поведение (ИИ в защите не платил) — для сравнения.
'use strict';
const fs = require('fs'), path = require('path');

// ---------- аргументы
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const N = +opt('duels', 5000), DEFPAY = opt('defpay', '1') !== '0', ONLY = opt('only', ''), SEED = +opt('seed', 42), BRIEF = args.includes('--brief');
// --set путь=значение (можно несколько): SPELLS.stupefy.dmg=20, SPELLS.petrificus.cost=2, MULT.1=0.7, DIFF.1.pDef=0.55,
//   PARAM.VENOM=5 (урон тика яда), PARAM.P2CONC=1 (бонус концентрации второму игроку), PARAM.CF_BACKFIRE=0 (Конфринго не взрывается)
const SETS = []; for (let i = 0; i < args.length; i++) if (args[i] === '--set') SETS.push(args[i + 1]);
// STARTBONUS — доп. стартовая концентрация обоим; REGEN — сколько концентрации даётся в начале своего хода;
// MASTERY_REFUND=1 — мастерский (tier 3) атакующий каст возвращает 1 концентрации
// HURT_GAIN — ДОПОЛНИТЕЛЬНАЯ концентрация за пропущенный урон сверх той, что уже даёт resolve() игры (+1 с 2026-09-15)
const PARAM = { VENOM: 6, P2CONC: 0, CF_BACKFIRE: 1, STARTBONUS: 0, REGEN: 1, MASTERY_REFUND: 0, HURT_GAIN: 0 };

// ---------- детерминированный RNG (подменяем Math.random, чтобы им пользовался и код игры)
let rs = SEED >>> 0 || 1;
function rnd() { rs = (rs + 0x6D2B79F5) >>> 0; let t = rs; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
Math.random = rnd;

// ---------- вытаскиваем правила из index.html
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function slice(from, to) {
  const a = html.indexOf(from), b = html.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`Не найден маркер: ${from} … ${to}`);
  return html.slice(a, b);
}
const rulesSrc = [
  slice('const SPELLS={', '// ---- navigation'),
  slice('function mkPlayer(', 'function statusText('),
  slice('function aiCast(', 'function castLabel('),
  slice('function resolve(', 'async function startGame('),
].join('\n');
// gauss/clamp продублированы (в index.html между ними теперь живёт код темпа, который тянет DOM-зависимости)
const stubs = `const SFX={hit(){},shield(){},clash(){},dispel(){},cast(){},misfire(){}};const msg=()=>{},log=()=>{},refresh=()=>{};let diff=0;const game={over:false,twoP:true,me:null,opp:null};
function gauss(m,sd){let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();return m+sd*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));`;
const G = new Function(stubs + rulesSrc + ';return {SPELLS,MULT,TIERS,tierOf,DIFF,resolve,aiCast,aiPickAttack,aiPickDefense,mkPlayer,gauss,clamp,setDiff:d=>{diff=d}};')();
const { SPELLS, MULT, tierOf, DIFF, resolve, aiCast, aiPickAttack, aiPickDefense, mkPlayer, gauss, clamp } = G;
for (const s of SETS) { const [p, v] = s.split('='); const ks = p.split('.'); let o = { SPELLS, MULT, DIFF, PARAM }; for (const k of ks.slice(0, -1)) o = o[k]; if (o === undefined || !(ks.at(-1) in o)) throw new Error('Неизвестный путь в --set: ' + p); o[ks.at(-1)] = +v; }
const IDS = Object.keys(SPELLS);
const ATTACKS = IDS.filter(id => SPELLS[id].dmg > 0);
const WRONG_POOL = ['protego', 'stupefy', 'finite', 'expelliarmus', 'rictusempra']; // как в aiPickDefense

// ---------- модели игроков
// Модель: {label, attack(p,o)->{id,want}, defense(p,att,slow)->id|null, cast(p,id)->{id,score,tier}}
// want — что игрок «хотел», если из-за концентрации пришлось взять другое (мягкий голод).
function penal(p, s) { if (p.laugh) s -= 0.08; if (p.stunned) s -= 0.15; if (p.blind) s -= 0.10; return s; }
function humanCast(mean, sd) { return (p, id) => { const s = penal(p, clamp(gauss(mean, sd), 0, 1)); return { id, score: s, tier: tierOf(s) }; }; }
function correctDef(att) { return att === 'expelliarmus' ? 'expelliarmus' : 'protego'; }
function defWithP(pDef) {
  return (p, att, slow) => {
    if (p.conc < 1) return null;
    const c = correctDef(att);
    if (c === 'expelliarmus' && p.conc < 2) return null; // против Экспеллиармуса ничто другое не помогает — не тратим концентрацию
    if (Math.random() < pDef - (slow ? .25 : 0)) return c;
    return WRONG_POOL[Math.floor(Math.random() * WRONG_POOL.length)];
  };
}
function aiModel(d) {
  return {
    label: `ИИ:${DIFF[d].name}`, d,
    attack(p, o) { G.setDiff(d); return { id: aiPickAttack(p, o), want: null }; },
    defense(p, att, slow) { G.setDiff(d); return aiPickDefense(att, slow, p.conc); }, // третий аргумент — новая сигнатура (может вернуть null)
    cast(p, id) { G.setDiff(d); return aiCast(p, id); },
  };
}
function randomModel(mean, sd = .1, pDef = .8) {
  return {
    label: `случайный ${mean}`,
    attack(p) { if (p.disarmed) return { id: 'accio', want: null }; const pool = IDS.filter(i => i !== 'accio'); return { id: pool[Math.floor(Math.random() * pool.length)], want: null }; },
    defense(p) { if (p.conc < 1) return null; return WRONG_POOL[Math.floor(Math.random() * WRONG_POOL.length)]; },
    cast: humanCast(mean, sd),
  };
}
function greedyModel(mean, sd = .1, pDef = .8) {
  return {
    label: `жадный ${mean}`,
    attack(p) {
      if (p.disarmed) return { id: 'accio', want: null };
      if (p.conc >= 2) return { id: 'confringo', want: null };
      return { id: 'stupefy', want: 'confringo' };
    },
    defense: defWithP(pDef),
    cast: humanCast(mean, sd),
  };
}
function smartModel(mean, sd = .1, pDef = .85) {
  return {
    label: `умный ${mean}`,
    attack(p, o) {
      if (p.disarmed) return { id: 'accio', want: null };
      if (o.disarmed) return p.conc >= 2 ? { id: 'confringo', want: null } : { id: 'stupefy', want: 'confringo' }; // защиты не будет — бьём максимально
      if (p.venom >= 2 && p.conc >= 1) return { id: 'finite', want: null }; // снять яд (2–3 тика по 6)
      if (p.slow && !p.guard && p.conc >= 1) return { id: 'protego', want: null }; // заранее щит перед короткой защитой
      if (o.hp <= 22) return { id: 'stupefy', want: null };
      if (!o.guard && Math.random() < .35) return p.conc >= 2 ? { id: 'expelliarmus', want: null } : { id: 'stupefy', want: 'expelliarmus' };
      if (mean >= .85 && Math.random() < .4) return p.conc >= 2 ? { id: 'confringo', want: null } : { id: 'stupefy', want: 'confringo' };
      if (Math.random() < .2) return p.conc >= 3 ? { id: 'petrificus', want: null } : { id: 'stupefy', want: 'petrificus' };
      return { id: 'stupefy', want: null };
    },
    defense: defWithP(pDef),
    cast: humanCast(mean, sd),
  };
}

// умный, но иногда берёт заклинания-статусы (чтобы оценить их вклад у толкового игрока)
function smartWideModel(mean, sd = .1, pDef = .85) {
  const base = smartModel(mean, sd, pDef), util = ['serpensortia', 'impedimenta', 'obscuro', 'rictusempra'];
  return { ...base, label: `умный+ ${mean}`,
    attack(p, o) { if (!p.disarmed && !o.disarmed && o.hp > 22 && p.conc >= 1 && Math.random() < .3) return { id: util[Math.floor(Math.random() * util.length)], want: null }; return base.attack(p, o); } };
}

// ---------- статистика
function mkStats() {
  const sp = {}; for (const id of IDS) sp[id] = { tries: 0, misfire: 0, casts: 0, dmg: 0, self: 0, blocked: 0, n: 0, sx: 0, sy: 0, sxy: 0, sxx: 0, syy: 0, usedWin: 0, usedN: 0 };
  return { duels: 0, winsA: 0, firstWins: 0, draws: 0, rounds: 0, turns: 0, concSum: 0, concZero: 0, starvedHard: 0, starvedSoft: 0, defStarved: 0, defTries: 0, defPhases: 0, defNoConc: 0,
    venomDmg: 0, venomTicks: 0, serpCasts: 0, slowFlips: 0, slowFlipDmg: 0, slowedDefs: 0, impLanded: 0,
    disarms: 0, chainLocks: 0, disarmedTurns: 0, guardsRaised: 0, guardsEatenByExp: 0, finiteUseless: 0, sp };
}

// ---------- один ход (переигранный playTurn)
const wear = p => { for (const k of ['laugh', 'stunned', 'blind']) if (p[k]) p[k]--; };
function turn(A, D, S, ev) {
  A.conc = Math.min(5, A.conc + PARAM.REGEN); // связанный тоже получает +1 (как в игре после правки 2026-09-15)
  if (A.bound) { A.bound = false; return; }
  S.turns++; S.concSum += A.conc; if (A.conc === 0) S.concZero++;
  if (A.disarmed) S.disarmedTurns++; else A.justAccio = false;
  const pick = A.model.attack(A, D);
  if (pick.want && pick.want !== pick.id) S.starvedSoft++;
  const cast = A.model.cast(A, pick.id);
  const hadStatus = A.laugh || A.stunned || A.blind;
  wear(A); // статусы — счётчики на 2 каста (правка 2026-09-15)
  const st = S.sp[cast.id]; st.tries++;
  if (cast.tier === 0) { st.misfire++; return; }
  const sp = SPELLS[cast.id];
  if (A.disarmed && cast.id !== 'accio') return;
  if (sp.cost > A.conc) { S.starvedHard++; return; }
  A.conc -= sp.cost; st.casts++; A.use[cast.id]++;
  if (PARAM.MASTERY_REFUND && cast.tier === 3) A.conc = Math.min(5, A.conc + 1);
  if (cast.id === 'confringo' && cast.tier === PARAM.CF_BACKFIRE) { A.hp = Math.max(0, A.hp - 10); st.self += 10; return; }
  if (cast.id === 'accio') { if (A.disarmed) { A.disarmed = false; A.justAccio = true; } return; }
  if (cast.id === 'finite') { if (!A.venom && !A.slow && !hadStatus) S.finiteUseless++; A.laugh = A.stunned = A.blind = 0; A.venom = 0; A.slow = false; return; }
  if (cast.id === 'protego') { A.guard = cast.tier; S.guardsRaised++; return; }
  // фаза защиты
  let def = null, slowFlip = false;
  if (D.disarmed) { /* без палочки нет защиты */ }
  else if (D.guard && cast.id !== 'expelliarmus') { def = { id: 'protego', score: 0, tier: D.guard }; D.guard = 0; } // щит Экспеллиармус не трогает (правка 2026-09-15)
  else {
    const slow = D.slow; if (slow) S.slowedDefs++;
    S.defPhases++; if (D.conc === 0) S.defNoConc++;
    const s0 = rs; const id = D.model.defense(D, cast.id, slow); const s1 = rs;
    if (slow) { rs = s0; const idNoSlow = D.model.defense(D, cast.id, false); rs = s1; slowFlip = idNoSlow !== id && idNoSlow === correctDef(cast.id) && id !== correctDef(cast.id); if (slowFlip) S.slowFlips++; }
    D.slow = false;
    if (id) {
      S.defTries++;
      def = D.model.cast(D, id);
      wear(D);
      if (def.tier === 0) def = null;
      else if (SPELLS[id].cost > D.conc) { def = null; S.defStarved++; }
      else if (DEFPAY || D.model.d === undefined) D.conc -= SPELLS[id].cost; // ИИ при --defpay 0 не платит (как сейчас в игре)
    }
  }
  const hp0 = D.hp, wasDisarmed = D.disarmed;
  resolve(A, D, cast, def);
  const d = hp0 - D.hp; st.dmg += d; if (d === 0) st.blocked++;
  if (PARAM.HURT_GAIN && d > 0) D.conc = Math.min(5, D.conc + PARAM.HURT_GAIN);
  if (slowFlip) S.slowFlipDmg += d;
  if (cast.id === 'impedimenta' && D.slow) S.impLanded++;
  if (cast.id === 'serpensortia' && D.venom) { S.serpCasts++; D.venomSrc = A; }
  if (D.disarmed && !wasDisarmed) { S.disarms++; if (D.justAccio) S.chainLocks++; }
  if (A.disarmed && !ev.aWas) S.disarms++; // встречный Экспеллиармус разоружил атакующего
}

// ---------- дуэль
function duel(mA, mB, S, first) {
  const P = [mkPlayer('A', false), mkPlayer('B', false)];
  P[0].model = mA; P[1].model = mB; P[1 - first].conc += PARAM.P2CONC; P[0].conc += PARAM.STARTBONUS; P[1].conc += PARAM.STARTBONUS;
  for (const p of P) { p.use = {}; for (const id of IDS) p.use[id] = 0; p.justAccio = false; }
  let cur = first, round = 1, t = 0;
  while (t++ < 400) {
    const A = P[cur], D = P[1 - cur];
    const ev = { aWas: A.disarmed };
    turn(A, D, S, ev);
    if (A.venom && A.hp > 0) { A.venom--; const v = Math.min(A.hp, PARAM.VENOM); A.hp -= v; S.venomDmg += v; S.venomTicks++; } // яд тикает в конце своего хода
    if (P[0].hp <= 0 || P[1].hp <= 0) break;
    cur = 1 - cur; if (cur === 0) round++;
  }
  S.duels++; S.rounds += round;
  const winner = P[0].hp <= 0 ? 1 : P[1].hp <= 0 ? 0 : -1;
  if (winner < 0) { S.draws++; return; }
  if (winner === 0) S.winsA++;
  if (winner === first) S.firstWins++;
  for (let i = 0; i < 2; i++) { const y = winner === i ? 1 : 0; for (const id of IDS) { const x = P[i].use[id], st = S.sp[id]; st.n++; st.sx += x; st.sy += y; st.sxy += x * y; st.sxx += x * x; st.syy += y * y; if (x) { st.usedN++; st.usedWin += y; } } }
}
function corr(st) { const { n, sx, sy, sxy, sxx, syy } = st; const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy)); return den ? (n * sxy - sx * sy) / den : 0; }

// ---------- запуск матчапа
const pct = x => (100 * x).toFixed(1) + '%';
const f1 = x => x.toFixed(1), f2 = x => x.toFixed(2);
function run(mA, mB, alternate = true) {
  const S = mkStats();
  for (let i = 0; i < N; i++) duel(mA, mB, S, alternate ? i % 2 : 0);
  return S;
}
function shortName(id) { return SPELLS[id].name.split(' ')[0]; }
function printMatch(title, S, verbose) {
  const dec = S.duels - S.draws;
  const stu0 = S.sp.stupefy, cf0 = S.sp.confringo, totalDmg0 = IDS.reduce((a, id) => a + S.sp[id].dmg, 0);
  if (BRIEF) { console.log(`${title.padEnd(44)} A ${pct(S.winsA / dec).padStart(6)} · 1-й ход ${pct(S.firstWins / dec).padStart(6)} · ${f1(S.rounds / S.duels).padStart(5)} р · конц ${f2(S.concSum / S.turns)} · защ. с 0 ${pct(S.defNoConc / Math.max(1, S.defPhases)).padStart(5)} · Ступефай ${f1(stu0.dmg / Math.max(1, stu0.casts))}/каст (${pct(stu0.dmg / Math.max(1, totalDmg0))}) · Конфринго чист. ${f1((cf0.dmg - cf0.self) / Math.max(1, cf0.casts))} · Петрификус ${S.sp.petrificus.casts} кастов`); return; }
  console.log(`\n=== ${title} ===  дуэлей ${S.duels}, ничьих ${S.draws}`);
  console.log(`  Победы A ${pct(S.winsA / dec)} · первый ход побеждает ${pct(S.firstWins / dec)} · средняя длина ${f1(S.rounds / S.duels)} раундов`);
  console.log(`  Концентрация в начале хода ${f2(S.concSum / S.turns)} (0 в ${pct(S.concZero / S.turns)} ходов) · голод жёсткий ${pct(S.starvedHard / S.turns)} ходов, мягкий ${pct(S.starvedSoft / S.turns)} · защита не по карману ${pct(S.defStarved / Math.max(1, S.defTries))} защит · к защите с 0 концентрации ${pct(S.defNoConc / Math.max(1, S.defPhases))}`);
  console.log(`  Разоружений ${f2(S.disarms / S.duels)}/дуэль, из них цепных (сразу после Акцио) ${pct(S.chainLocks / Math.max(1, S.disarms))} · ходов без палочки ${pct(S.disarmedTurns / S.turns)}`);
  console.log(`  Щитов заранее ${f2(S.guardsRaised / S.duels)}/дуэль, из них съедено Экспеллиармусом ${pct(S.guardsEatenByExp / Math.max(1, S.guardsRaised))} · Фините «впустую» (только смех/оглушение/слепота) ${f2(S.finiteUseless / S.duels)}/дуэль`);
  const serp = S.sp.serpensortia, stu = S.sp.stupefy;
  console.log(`  Серпенсортия: ${serp.casts} кастов, прямой урон ${f1(serp.dmg / Math.max(1, serp.casts))} + яд ${f1(S.venomDmg / Math.max(1, S.serpCasts))} за наложенную змею (тиков ${f2(S.venomTicks / Math.max(1, S.serpCasts))}) = ${f1((serp.dmg + S.venomDmg) / Math.max(1, serp.casts))}/каст · Ступефай ${f1(stu.dmg / Math.max(1, stu.casts))}/каст`);
  const imp = S.sp.impedimenta;
  console.log(`  Импедимента: попаданий ${S.impLanded}, замедленных защит ${S.slowedDefs}, замедление изменило выбор защиты ${S.slowFlips} раз (${pct(S.slowFlips / Math.max(1, S.slowedDefs))}), пропущено из-за этого ${S.slowFlipDmg} урона (${f1(S.slowFlipDmg / Math.max(1, imp.casts))}/каст Импедименты)`);
  const cf = S.sp.confringo;
  console.log(`  Конфринго: ${cf.casts} кастов, взрывов в руке ${pct(cf.self / 10 / Math.max(1, cf.casts))}, урон ${f1(cf.dmg / Math.max(1, cf.casts))}/каст, себе ${f1(cf.self / Math.max(1, cf.casts))}/каст, чистый ${f1((cf.dmg - cf.self) / Math.max(1, cf.casts))}`);
  if (verbose) {
    console.log('  ' + ['заклинание', 'попыток', 'осечек', 'кастов', 'урон/каст', 'блок%', 'corr(исп,поб)', 'побед если исп.'].map((s, i) => s.padEnd(i ? 11 : 14)).join(''));
    const totalDmg = IDS.reduce((a, id) => a + S.sp[id].dmg, 0);
    for (const id of IDS) { const st = S.sp[id]; if (!st.tries) continue;
      console.log('  ' + shortName(id).padEnd(14) + [String(st.tries), pct(st.misfire / st.tries), String(st.casts), st.casts ? f1(st.dmg / st.casts) + ' (' + pct(st.dmg / totalDmg) + ')' : '-', st.casts && SPELLS[id].dmg ? pct(st.blocked / st.casts) : '-', f2(corr(st)), st.usedN ? pct(st.usedWin / st.usedN) : '-'].map(s => s.padEnd(11)).join(''));
    }
  }
}

// ---------- аналитика по точности (без защиты): матожидание урона Ступефай vs Конфринго
function analytic() {
  console.log('\n=== Матожидание за каст без защиты (200k выборок gauss(mean,0.1)) ===');
  console.log('  mean   осечка  слабо   чётко  мастер | Ступефай  Конфринго(чистый)  Риктусемпра  Петрификус');
  for (const mean of [.68, .7, .78, .8, .88, .9]) {
    const c = [0, 0, 0, 0]; const K = 200000; for (let i = 0; i < K; i++) c[tierOf(clamp(gauss(mean, .1), 0, 1))]++;
    const p = c.map(x => x / K);
    const stu = 22 * (.6 * p[1] + p[2] + 1.4 * p[3]), cf = 26 * (p[2] + 1.4 * p[3]) - 10 * p[1], ric = 12 * (.6 * p[1] + p[2] + 1.4 * p[3]), pet = 15 * (.6 * p[1] + p[2] + 1.4 * p[3]);
    console.log(`  ${mean.toFixed(2)}   ${p.map(x => pct(x).padStart(6)).join('  ')} | ${f1(stu).padStart(8)}  ${f1(cf).padStart(17)}  ${f1(ric).padStart(11)}  ${f1(pet).padStart(10)}`);
  }
}

// ---------- программа
const matchups = [];
const add = (title, a, b, verbose = false, alt = true) => matchups.push({ title, a, b, verbose, alt });
for (let d = 0; d < 3; d++) add(`ИИ ${DIFF[d].name} vs ИИ ${DIFF[d].name}`, aiModel(d), aiModel(d), d === 1);
for (const m of [.7, .8, .9]) { add(`случайный ${m} зеркало`, randomModel(m), randomModel(m), m === .8); add(`жадный ${m} зеркало`, greedyModel(m), greedyModel(m), m === .8); add(`умный ${m} зеркало`, smartModel(m), smartModel(m), true); }
add('умный+ 0.8 зеркало', smartWideModel(.8), smartWideModel(.8), true);
add('умный+ 0.9 зеркало', smartWideModel(.9), smartWideModel(.9), true);
add('умный+ 0.8 (A) vs умный 0.8 (B)', smartWideModel(.8), smartModel(.8));
add('умный 0.8 (A) vs умный 0.9 (B)', smartModel(.8), smartModel(.9));
add('умный 0.7 (A) vs умный 0.9 (B)', smartModel(.7), smartModel(.9));
add('умный 0.7 (A) vs умный 0.8 (B)', smartModel(.7), smartModel(.8));
add('жадный 0.8 (A) vs умный 0.8 (B)', greedyModel(.8), smartModel(.8));
add('случайный 0.8 (A) vs умный 0.8 (B)', randomModel(.8), smartModel(.8));
add('жадный 0.9 (A) vs умный 0.9 (B)', greedyModel(.9), smartModel(.9));
for (let d = 0; d < 3; d++) add(`умный 0.8 (A, ходит первым) vs ИИ ${DIFF[d].name}`, smartModel(.8), aiModel(d), false, false);
for (let d = 0; d < 3; d++) add(`случайный 0.8 (A, ходит первым) vs ИИ ${DIFF[d].name}`, randomModel(.8), aiModel(d), false, false);

console.log(`Дуэлей на матчап: ${N}, защита платит концентрацию: ${DEFPAY ? 'обе стороны' : 'только не-ИИ (старое поведение)'}, seed ${SEED}${SETS.length ? ', правки: ' + SETS.join(' ') : ''}`);
if (!BRIEF) analytic();
const t0 = Date.now();
for (const m of matchups) { if (ONLY && !m.title.includes(ONLY)) continue; rs = SEED >>> 0 || 1; printMatch(m.title, run(m.a, m.b, m.alt), m.verbose); }
console.log(`\nГотово за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
