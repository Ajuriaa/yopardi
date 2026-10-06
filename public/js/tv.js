import { connect } from './net.js';
import { sfx, unlockAudio } from './sound.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let state = null;

// ---------- Inicio (desbloquea audio + pantalla completa) ----------

function goFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
}
$('#start-btn').addEventListener('click', () => {
  unlockAudio();
  goFullscreen();
  $('#start').classList.add('gone');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') goFullscreen();
});
// Cualquier click también desbloquea el audio por si se recargó la página.
document.addEventListener('click', unlockAudio);

// ---------- Cola de efectos (para que un TOMA no tape un STRIKE) ----------

const fxQueue = [];
let fxBusy = false;
function queueFx(run, duration) {
  fxQueue.push({ run, duration });
  if (!fxBusy) nextFx();
}
function nextFx() {
  const item = fxQueue.shift();
  if (!item) {
    fxBusy = false;
    return;
  }
  fxBusy = true;
  try {
    item.run();
  } catch (err) {
    console.error(err);
  }
  setTimeout(nextFx, item.duration);
}
function restartAnim(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function showStrike(count) {
  const el = $('#fx-strike');
  el.innerHTML = '<div class="bigx">X</div>'.repeat(Math.max(1, Math.min(3, count)));
  restartAnim(el, 'show');
  sfx.strike();
}
function showDrink({ team, reason }) {
  const el = $('#fx-drink');
  const who = team === null || team === undefined ? '' : state?.teams[team]?.name ?? '';
  el.querySelector('.drink-who').textContent = who;
  el.querySelector('.drink-reason').textContent = reason || '';
  restartAnim(el, 'show');
  sfx.drink();
}
function showBanner(text, color) {
  const el = $('#fx-banner');
  el.textContent = text;
  el.style.setProperty('--banner', color || 'var(--gold-2)');
  restartAnim(el, 'show');
}

function onEvent(name, data) {
  switch (name) {
    case 'reveal':
      queueFx(() => (data.top ? sfx.top() : sfx.reveal()), data.top ? 1100 : 0);
      bump($('.feud-bank'));
      break;
    case 'revealRest':
      queueFx(() => sfx.reveal(), 0);
      break;
    case 'strike':
      queueFx(() => showStrike(data.count), 1600);
      break;
    case 'drink':
      queueFx(() => showDrink(data), 3300);
      break;
    case 'steal':
      queueFx(() => {
        showBanner(`¡Robo! ${state?.teams[data.team]?.name ?? ''}`, data.team === 0 ? 'var(--red)' : 'var(--blue)');
        sfx.steal();
      }, 2500);
      break;
    case 'award':
      queueFx(() => {
        sfx.award();
        showBanner(`+${data.points} ${state?.teams[data.team]?.name ?? ''}`, data.team === 0 ? 'var(--red)' : 'var(--blue)');
      }, 2500);
      break;
    case 'open':
      sfx.open();
      break;
    case 'dd':
      sfx.dailyDouble();
      break;
    case 'correct':
      queueFx(() => sfx.correct(), 600);
      break;
    case 'wrong':
      queueFx(() => sfx.wrong(), 900);
      break;
    case 'win':
      queueFx(() => {
        sfx.win();
        confetti();
      }, 0);
      break;
  }
}

// ---------- Marcador ----------

const shownScores = [null, null];
function bump(el) {
  if (!el) return;
  restartAnim(el, 'bump');
}
function tweenScore(i, to) {
  const from = shownScores[i];
  shownScores[i] = to;
  const els = [document.querySelector(`.score[data-team="${i}"] .score-num`), document.querySelector(`.big-score.team-${i} .s`)];
  if (from === null || from === to) {
    els.forEach((el) => (el.textContent = to));
    return;
  }
  bump(document.querySelector(`.score[data-team="${i}"]`));
  const start = performance.now();
  const dur = 900;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const v = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
    els.forEach((el) => (el.textContent = v));
    if (t < 1 && shownScores[i] === to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderScores(s) {
  s.teams.forEach((t, i) => {
    document.querySelector(`.score[data-team="${i}"] .score-name`).textContent = t.name;
    document.querySelector(`.big-score.team-${i} .n`).textContent = t.name;
    document.querySelector(`.vs-team.team-${i}`).textContent = t.name;
    tweenScore(i, t.score);
  });
  const f = s.feud;
  const highlighted = s.scene === 'feud' && f.question && f.awarded === null && f.control !== null ? (f.steal ? 1 - f.control : f.control) : null;
  document.querySelectorAll('.score').forEach((el) => el.classList.toggle('control', Number(el.dataset.team) === highlighted));
}

const SCENE_LABELS = { lobby: '', rules: 'Reglas', scores: 'Marcador', feud: 'Family Feud', jeopardy: 'Jeopardy', final: 'Final', end: '¡Fin!' };

function renderScene(s) {
  document.querySelectorAll('.scene').forEach((el) => el.classList.toggle('active', el.id === `scene-${s.scene}`));
  $('#scorebar').style.visibility = s.scene === 'lobby' || s.scene === 'end' ? 'hidden' : 'visible';
  let label = SCENE_LABELS[s.scene] ?? '';
  if (s.scene === 'feud' && s.feud.mult > 1) label += ` · ${s.feud.mult}X`;
  $('#scene-label').textContent = label;
}

// ---------- Family Feud ----------

let feudBuiltFor = null;
function renderFeud(s) {
  const f = s.feud;
  const scene = $('#scene-feud');
  scene.classList.toggle('no-question', !f.question);
  if (!f.question) {
    feudBuiltFor = null;
    return;
  }
  const board = $('#feud-board');
  if (feudBuiltFor !== f.question.id) {
    feudBuiltFor = f.question.id;
    $('#feud-question').textContent = f.question.text;
    board.innerHTML = Array.from({ length: 8 }, (_, i) => {
      const exists = i < f.question.answers.length;
      return `<div class="slot ${exists ? '' : 'empty'} ${i === 0 ? 'top' : ''}" data-i="${i}">
        <div class="slot-inner">
          <div class="slot-face slot-front"><div class="num">${i + 1}</div></div>
          <div class="slot-face slot-back"><div class="text"></div><div class="pts"></div></div>
        </div></div>`;
    }).join('');
  }
  f.question.answers.forEach((a, i) => {
    const slot = board.querySelector(`.slot[data-i="${i}"]`);
    if (a.revealed) {
      slot.querySelector('.text').textContent = a.text;
      slot.querySelector('.pts').textContent = a.points;
    }
    slot.classList.toggle('revealed', !!a.revealed);
  });
  $('#feud-bank').textContent = f.bank;
  const mult = $('#feud-mult');
  mult.classList.toggle('hidden', f.mult === 1);
  mult.textContent = f.mult === 2 ? 'PUNTOS DOBLES' : f.mult === 3 ? 'PUNTOS TRIPLES' : '';
  $('#feud-strikes').innerHTML = '<div class="x">X</div>'.repeat(f.strikes);
}

// ---------- Jeopardy ----------

let jeopSig = null;
function renderJeop(s) {
  const j = s.jeop;
  const board = $('#jeop-board');
  $('#jeop-empty').classList.toggle('hidden', j.categories.length > 0);
  board.classList.toggle('hidden', j.categories.length === 0);
  const sig = j.categories.join('|') + '#' + j.values.join(',');
  if (sig !== jeopSig) {
    jeopSig = sig;
    board.style.setProperty('--cols', j.categories.length || 1);
    let html = j.categories.map((c) => `<div class="jeop-cat">${esc(c)}</div>`).join('');
    j.values.forEach((v, r) => {
      j.categories.forEach((_, c) => (html += `<div class="jeop-cell" data-k="${c}-${r}">${v}</div>`));
    });
    board.innerHTML = html;
  }
  board.querySelectorAll('.jeop-cell').forEach((el) => {
    el.classList.toggle('used', !!j.used[el.dataset.k]);
  });

  const showDD = j.cell && j.stage === 'dd';
  const showClue = j.cell && (j.stage === 'clue' || j.stage === 'answer');
  $('#jeop-dd').classList.toggle('hidden', !showDD);
  const clueEl = $('#jeop-clue');
  const wasHidden = clueEl.classList.contains('hidden');
  clueEl.classList.toggle('hidden', !showClue);
  if (showClue) {
    $('#clue-cat').textContent = j.categories[j.cell.c] ?? '';
    $('#clue-val').textContent = j.isDD ? `Daily Double · ${j.ddWager ?? 0}` : j.values[j.cell.r];
    $('#clue-text').textContent = j.clue ?? '';
    const ans = $('#clue-answer');
    ans.classList.toggle('hidden', j.stage !== 'answer');
    ans.textContent = j.answer ?? '';
    if (wasHidden) restartAnim(clueEl, 'pop');
  }
}

// ---------- Final ----------

function renderFinal(s) {
  const fin = s.final;
  const stage = ['category', 'clue', 'answer', 'results'].indexOf(fin.stage);
  $('#final-cat').textContent = fin.category ?? 'Pendiente';
  $('#scene-final').classList.toggle('has-clue', stage >= 1);
  const clue = $('#final-clue');
  clue.classList.toggle('hidden', stage < 1 || !fin.clue);
  clue.textContent = fin.clue ?? '';
  const ans = $('#final-answer');
  ans.classList.toggle('hidden', stage < 2 || !fin.answer);
  ans.textContent = fin.answer ?? '';
  const res = $('#final-results');
  res.classList.toggle('hidden', stage < 3);
  if (stage >= 3) {
    res.innerHTML = s.teams
      .map((t, i) => {
        const r = fin.results[i];
        const mark = r === null ? '…' : r ? '✅ +' + (fin.wagers?.[i] ?? 0) : '❌ −' + (fin.wagers?.[i] ?? 0);
        return `<div class="final-result team-${i}"><div class="n">${esc(t.name)}</div><div class="w">Apostó ${fin.wagers?.[i] ?? '?'}</div><div class="r">${mark}</div></div>`;
      })
      .join('');
  }
}

// ---------- Fin ----------

function renderEnd(s) {
  const [a, b] = s.teams;
  const winner = $('#end-winner');
  if (a.score === b.score) {
    winner.textContent = '¡EMPATE!';
    winner.style.removeProperty('--team');
    $('#end-score').textContent = `${a.score} a ${b.score}`;
    $('#end-loser').textContent = '🥃 Shot para todos';
    return;
  }
  const w = a.score > b.score ? 0 : 1;
  winner.textContent = s.teams[w].name;
  winner.style.setProperty('--team', w === 0 ? 'var(--red)' : 'var(--blue)');
  $('#end-score').textContent = `${s.teams[w].score} a ${s.teams[1 - w].score}`;
  $('#end-loser').textContent = `🥃 ${s.teams[1 - w].name}: ¡SHOT GRUPAL!`;
}

function confetti() {
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  const colors = ['#ffc53d', '#ff3b5c', '#2f8cff', '#22d37a', '#ffffff'];
  const parts = Array.from({ length: 260 }, () => ({
    x: Math.random() * canvas.width,
    y: -Math.random() * canvas.height,
    w: 6 + Math.random() * 10,
    h: 8 + Math.random() * 14,
    vy: 2 + Math.random() * 5,
    vx: -2 + Math.random() * 4,
    rot: Math.random() * Math.PI,
    vr: -0.2 + Math.random() * 0.4,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const end = performance.now() + 7000;
  const frame = (now) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y > canvas.height && now < end) p.y = -20;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (now < end + 4000) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
  requestAnimationFrame(frame);
}

// ---------- Timer ----------

let lastSecond = null;
let net = null;
setInterval(() => {
  const el = $('#timer');
  const t = state?.timer;
  if (!t) {
    el.classList.add('hidden');
    lastSecond = null;
    return;
  }
  const left = Math.max(0, Math.ceil((t.endsAt - net.now()) / 1000));
  el.classList.remove('hidden');
  el.classList.toggle('urgent', left <= 10);
  el.querySelector('span').textContent = left;
  if (left !== lastSecond) {
    if (lastSecond !== null && left <= 10 && left > 0) sfx.tick();
    if (lastSecond !== null && left === 0) sfx.timeUp();
    lastSecond = left;
  }
}, 200);

// ---------- Conexión ----------

function render(s) {
  state = s;
  renderScene(s);
  renderScores(s);
  renderFeud(s);
  renderJeop(s);
  renderFinal(s);
  renderEnd(s);
}

net = connect('tv', {
  onState: render,
  onEvent,
  onStatus: (ok) => $('#offline').classList.toggle('hidden', ok),
});
