// Yopardi: servidor local. Es la única fuente de verdad del juego.
// La TV y el celular del host se conectan por WebSocket y solo muestran lo que el servidor dice.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FONTS_DIR = path.join(__dirname, 'node_modules', '@fontsource');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const KEY_FILE = path.join(DATA_DIR, '.host-key');
const HISTORY_LIMIT = 100;

const SCENES = ['lobby', 'rules', 'scores', 'feud', 'jeopardy', 'final', 'end'];
const FINAL_STAGES = ['category', 'clue', 'answer', 'results'];
// Acciones que no se guardan en el historial de "deshacer".
const NO_HISTORY = new Set(['drink', 'timerStart', 'timerStop', 'reloadContent', 'undo']);

fs.mkdirSync(DATA_DIR, { recursive: true });

class GameError extends Error {}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`⚠️  No se pudo leer ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

function writeJSONAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// ---------- Contenido (preguntas) ----------

let content = { feud: [], jeop: { values: [], categories: [], final: null } };

function loadContent() {
  const feudRaw = readJSON(path.join(DATA_DIR, 'family-feud.json'), { questions: [] });
  // Preguntas del grupo (privadas, no van al repo): van primero en la lista.
  const feudPrivate = readJSON(path.join(DATA_DIR, 'family-feud.private.json'), { questions: [] });
  const feud = [...(feudPrivate.questions || []), ...(feudRaw.questions || [])]
    .map((q, i) => ({
      id: String(q.id || `ff-${i + 1}`),
      question: q.question_es || q.question || q.question_en || '',
      questionEn: q.question_en || '',
      answers: (q.answers || [])
        .map((a) => ({ text: a.text_es || a.text || a.text_en || '?', textEn: a.text_en || '', points: Number(a.points) || 0 }))
        .sort((a, b) => b.points - a.points)
        .slice(0, 8),
    }))
    .filter((q) => q.question && q.answers.length);

  // jeopardy.json es privado (no va al repo); si no existe se usa el ejemplo.
  const jeopRaw = readJSON(path.join(DATA_DIR, 'jeopardy.json'), null) ?? readJSON(path.join(DATA_DIR, 'jeopardy.example.json'), {});
  const values = Array.isArray(jeopRaw.values) && jeopRaw.values.length ? jeopRaw.values.map(Number) : [20, 40, 60, 80, 100];
  const categories = (jeopRaw.categories || []).slice(0, 6).map((c) => ({
    name: c.name || '???',
    clues: values.map((_, r) => {
      const clue = (c.clues || [])[r] || {};
      return { q: clue.q || '(pendiente)', a: clue.a || '(pendiente)', dd: !!clue.dd };
    }),
  }));
  const final = jeopRaw.final && jeopRaw.final.q
    ? { category: jeopRaw.final.category || 'Final', q: jeopRaw.final.q, a: jeopRaw.final.a || '' }
    : null;

  const playlistRaw = readJSON(path.join(DATA_DIR, 'feud-playlist.json'), { rounds: [] });
  const feudIds = new Set(feud.map((q) => q.id));
  const rounds = (playlistRaw.rounds || []).map((r) => ({
    name: String(r.name || 'Ronda'),
    mult: [1, 2, 3].includes(Number(r.mult)) ? Number(r.mult) : 1,
    ids: (r.ids || []).filter((id) => feudIds.has(id)),
  }));

  content = { feud, rounds, jeop: { values, categories, final } };
  console.log(`📚 Contenido: ${feud.length} preguntas de Feud, ${categories.length} categorías de Jeopardy${final ? ', final lista' : ', sin final'}`);
}

// Casillas Daily Double: las marcadas con "dd" en el JSON, o una al azar en filas medias/altas.
function pickDailyDoubles() {
  const { categories, values } = content.jeop;
  const marked = [];
  categories.forEach((c, ci) => c.clues.forEach((cl, ri) => cl.dd && marked.push(`${ci}-${ri}`)));
  if (marked.length) return marked;
  if (!categories.length) return [];
  const ci = crypto.randomInt(categories.length);
  const ri = values.length > 2 ? crypto.randomInt(Math.floor(values.length / 2), values.length) : 0;
  return [`${ci}-${ri}`];
}

// ---------- Estado ----------

function freshState(teamNames) {
  return {
    rev: 0,
    scene: 'lobby',
    teams: [
      { name: teamNames?.[0] || 'Equipo Rojo', score: 0 },
      { name: teamNames?.[1] || 'Equipo Azul', score: 0 },
    ],
    feud: { qid: null, mult: 1, revealed: [], strikes: 0, control: null, bank: 0, steal: false, awarded: null, usedQids: [] },
    jeop: { used: {}, dd: pickDailyDoubles(), cell: null, stage: null, isDD: false, ddTeam: null, ddWager: null, judged: [null, null] },
    final: { stage: 'category', wagers: [0, 0], results: [null, null], applied: [0, 0] },
    timer: null,
  };
}

function mergeState(saved) {
  const base = freshState();
  if (!saved || typeof saved !== 'object') return base;
  return {
    ...base,
    ...saved,
    feud: { ...base.feud, ...saved.feud },
    jeop: { ...base.jeop, ...saved.jeop },
    final: { ...base.final, ...saved.final },
    teams: Array.isArray(saved.teams) && saved.teams.length === 2 ? saved.teams : base.teams,
  };
}

loadContent();
const saved = readJSON(STATE_FILE, null);
let state = mergeState(saved?.state);
let history = Array.isArray(saved?.history) ? saved.history : [];
if (!state.jeop.dd?.length) state.jeop.dd = pickDailyDoubles();

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      writeJSONAtomic(STATE_FILE, { state, history: history.slice(-30) });
    } catch (err) {
      console.error('⚠️  No se pudo guardar el estado:', err.message);
    }
  }, 50);
}

// ---------- Acciones del host ----------

const team = (t) => {
  const i = Number(t);
  if (i !== 0 && i !== 1) throw new GameError('Equipo inválido');
  return i;
};
const other = (t) => (t === 0 ? 1 : 0);
const int = (n) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) throw new GameError('Número inválido');
  return v;
};
const currentFeud = () => {
  const q = content.feud.find((x) => x.id === state.feud.qid);
  if (!q) throw new GameError('No hay pregunta de Feud cargada');
  return q;
};

// Tope de apuesta final: lo que tenía antes de la final, o al menos el valor de la casilla más alta
// (así un equipo en 0 o negativo todavía puede apostar algo).
function finalMaxWager(i) {
  const base = state.teams[i].score - (state.final.applied?.[i] || 0);
  return Math.max(base, Math.max(0, ...content.jeop.values));
}

const actions = {
  setScene({ scene }, emit) {
    if (!SCENES.includes(scene)) throw new GameError('Escena inválida');
    // Si se sale de Feud con la pregunta ya cobrada, se limpia para volver a la lista.
    if (state.scene === 'feud' && scene !== 'feud' && state.feud.awarded !== null) state.feud.qid = null;
    state.scene = scene;
    if (scene === 'end') emit('win');
  },
  setTeamName({ team: t, name }) {
    const clean = String(name ?? '').trim().slice(0, 24);
    if (clean) state.teams[team(t)].name = clean;
  },
  adjustScore({ team: t, delta }, emit) {
    const i = team(t);
    state.teams[i].score += int(delta);
    emit('score', { team: i, delta: int(delta) });
  },
  drink({ team: t, reason }, emit) {
    emit('drink', { team: t === null || t === undefined ? null : team(t), reason: String(reason || '¡TOMA!').slice(0, 80) });
  },
  timerStart({ seconds }) {
    const s = Math.min(Math.max(int(seconds), 5), 600);
    state.timer = { endsAt: Date.now() + s * 1000, seconds: s };
  },
  timerStop() {
    state.timer = null;
  },
  reset() {
    const names = state.teams.map((t) => t.name);
    const rev = state.rev;
    state = freshState(names);
    state.rev = rev;
  },
  reloadContent(_, emit) {
    loadContent();
    const { dd } = state.jeop;
    const valid = dd.every((k) => {
      const [c, r] = k.split('-').map(Number);
      return content.jeop.categories[c]?.clues[r];
    });
    if (!valid || !dd.length) state.jeop.dd = pickDailyDoubles();
    emit('toast', { msg: 'Preguntas recargadas' });
  },

  // --- Family Feud ---
  feudLoad({ qid, mult }) {
    const q = content.feud.find((x) => x.id === qid);
    if (!q) throw new GameError('Pregunta no encontrada');
    const f = state.feud;
    Object.assign(f, { qid, revealed: q.answers.map(() => false), strikes: 0, control: null, bank: 0, steal: false, awarded: null });
    if ([1, 2, 3].includes(Number(mult))) f.mult = Number(mult);
    if (!f.usedQids.includes(qid)) f.usedQids.push(qid);
  },
  feudClear() {
    state.feud.qid = null;
  },
  feudMult({ mult }) {
    const m = int(mult);
    if (![1, 2, 3].includes(m)) throw new GameError('Multiplicador inválido');
    const f = state.feud;
    // Recalcular el banco si cambia el multiplicador a medio juego.
    if (f.qid && f.awarded === null) {
      const q = currentFeud();
      const base = q.answers.reduce((sum, a, i) => sum + (f.revealed[i] ? a.points : 0), 0);
      f.bank = base * m;
    }
    f.mult = m;
  },
  feudControl({ team: t }) {
    currentFeud();
    state.feud.control = t === null ? null : team(t);
  },
  feudReveal({ idx }, emit) {
    const q = currentFeud();
    const f = state.feud;
    const i = int(idx);
    if (!q.answers[i]) throw new GameError('Respuesta inválida');
    if (f.revealed[i]) return;
    f.revealed[i] = true;
    const points = q.answers[i].points * f.mult;
    if (f.awarded === null) f.bank += points;
    emit('reveal', { idx: i, points, top: i === 0 });
    if (i === 0 && f.awarded === null) {
      const picker = f.control === null ? null : f.steal ? other(f.control) : f.control;
      emit('drink', {
        team: picker === null ? null : other(picker),
        reason: picker === null
          ? '¡La #1! El que la dijo escoge quién del otro equipo toma'
          : `¡La #1! ${state.teams[picker].name} escoge quién toma`,
      });
    }
  },
  feudRevealRest(_, emit) {
    const q = currentFeud();
    q.answers.forEach((_, i) => (state.feud.revealed[i] = true));
    emit('revealRest');
  },
  feudStrike(_, emit) {
    currentFeud();
    const f = state.feud;
    if (f.awarded !== null) throw new GameError('Ya se dieron los puntos de esta pregunta');
    if (f.control === null) {
      emit('strike', { count: 1, faceoff: true });
      emit('drink', { team: null, reason: 'Falló en el face-off' });
      return;
    }
    if (f.steal) {
      emit('strike', { count: 1 });
      emit('drink', { team: other(f.control), reason: '¡Falló el robo!' });
      return;
    }
    f.strikes = Math.min(f.strikes + 1, 3);
    emit('strike', { count: f.strikes });
    if (f.strikes === 3) {
      f.steal = true;
      emit('drink', { team: f.control, reason: '3 strikes: ¡TOMA TODO EL EQUIPO!' });
      emit('steal', { team: other(f.control) });
    } else {
      emit('drink', { team: f.control, reason: 'Toma el que falló' });
    }
  },
  feudAward({ team: t }, emit) {
    currentFeud();
    const f = state.feud;
    const i = team(t);
    if (f.awarded !== null) throw new GameError('Ya se dieron los puntos');
    state.teams[i].score += f.bank;
    f.awarded = i;
    emit('award', { team: i, points: f.bank });
    if (f.steal && f.control !== null && i !== f.control) {
      emit('drink', { team: f.control, reason: '¡Les robaron! Toma todo el equipo' });
    }
  },

  // --- Jeopardy ---
  jeopOpen({ c, r }, emit) {
    const ci = int(c);
    const ri = int(r);
    const clue = content.jeop.categories[ci]?.clues[ri];
    if (!clue) throw new GameError('Casilla inválida');
    const key = `${ci}-${ri}`;
    const j = state.jeop;
    if (j.used[key]) throw new GameError('Esa casilla ya se usó');
    const isDD = j.dd.includes(key);
    Object.assign(j, { cell: { c: ci, r: ri }, stage: isDD ? 'dd' : 'clue', isDD, ddTeam: null, ddWager: null, judged: [null, null] });
    emit(isDD ? 'dd' : 'open');
  },
  jeopWager({ team: t, amount }) {
    const j = state.jeop;
    if (!j.cell || !j.isDD) throw new GameError('No hay Daily Double abierto');
    const i = team(t);
    const max = Math.max(state.teams[i].score, Math.max(...content.jeop.values));
    j.ddTeam = i;
    j.ddWager = Math.min(Math.max(int(amount), 0), max);
    j.stage = 'clue';
  },
  jeopJudge({ team: t, correct }, emit) {
    const j = state.jeop;
    if (!j.cell) throw new GameError('No hay pregunta abierta');
    if (j.stage === 'dd') throw new GameError('Primero poné la apuesta');
    const i = team(t);
    if (j.isDD && i !== j.ddTeam) throw new GameError('El Daily Double es solo del equipo que apostó');
    if (j.judged[i] !== null) throw new GameError('Ese equipo ya fue calificado');
    const value = j.isDD ? j.ddWager : content.jeop.values[j.cell.r];
    state.teams[i].score += correct ? value : -value;
    j.judged[i] = !!correct;
    emit(correct ? 'correct' : 'wrong', { team: i, value });
    if (correct) j.stage = 'answer';
    else emit('drink', { team: i, reason: j.isDD ? 'Falló el Daily Double: ¡TOMA DOBLE!' : 'Toma el que respondió' });
  },
  jeopReveal() {
    if (!state.jeop.cell) throw new GameError('No hay pregunta abierta');
    if (state.jeop.stage === 'dd') throw new GameError('Primero poné la apuesta');
    state.jeop.stage = 'answer';
  },
  jeopClose() {
    const j = state.jeop;
    if (!j.cell) return;
    j.used[`${j.cell.c}-${j.cell.r}`] = true;
    Object.assign(j, { cell: null, stage: null, isDD: false, ddTeam: null, ddWager: null, judged: [null, null] });
  },

  // --- Final Jeopardy ---
  finalStage({ stage }, emit) {
    if (!FINAL_STAGES.includes(stage)) throw new GameError('Etapa inválida');
    state.final.stage = stage;
    if (stage === 'clue') emit('open');
  },
  finalWager({ team: t, amount }) {
    const i = team(t);
    state.final.wagers[i] = Math.min(Math.max(int(amount), 0), finalMaxWager(i));
  },
  finalJudge({ team: t, correct }, emit) {
    const i = team(t);
    const fin = state.final;
    if (fin.stage !== 'results') throw new GameError('Pasá a "Resultados" para calificar');
    const wager = fin.wagers[i];
    // Si ya se había calificado, revertir lo que se aplicó (aunque la apuesta haya cambiado).
    state.teams[i].score -= fin.applied[i] || 0;
    const delta = correct ? wager : -wager;
    state.teams[i].score += delta;
    fin.applied[i] = delta;
    fin.results[i] = !!correct;
    emit(correct ? 'correct' : 'wrong', { team: i, value: wager });
    if (!correct) emit('drink', { team: i, reason: 'Falló la final' });
  },
};

const REPEATABLE = new Set(['adjustScore']);
let lastAction = { sig: '', at: 0 };

function applyAction(action, payload, rev) {
  if (action === 'undo') {
    if (rev !== undefined && rev !== state.rev) return { stale: true };
    if (!history.length) throw new GameError('No hay nada que deshacer');
    const currentRev = state.rev;
    state = mergeState(JSON.parse(history.pop()));
    state.rev = currentRev + 1;
    persist();
    return { events: [{ name: 'undo' }] };
  }

  const fn = actions[action];
  if (!fn) throw new GameError(`Acción desconocida: ${action}`);
  // Protección contra doble toque: el host manda la versión que estaba viendo…
  if (rev !== undefined && rev !== state.rev) return { stale: true };
  // …y además se ignora la misma acción repetida en menos de 600 ms (por si la respuesta aún no llegaba).
  const sig = action + JSON.stringify(payload ?? {});
  const now = Date.now();
  if (!REPEATABLE.has(action) && lastAction.sig === sig && now - lastAction.at < 600) return { stale: true };
  lastAction = { sig, at: now };

  const before = JSON.stringify(state);
  const events = [];
  try {
    fn(payload || {}, (name, data) => events.push({ name, data }));
  } catch (err) {
    state = JSON.parse(before);
    throw err;
  }
  if (!NO_HISTORY.has(action)) {
    history.push(before);
    if (history.length > HISTORY_LIMIT) history.shift();
  }
  state.rev += 1;
  persist();
  return { events };
}

// ---------- Vistas por rol (la TV nunca recibe respuestas ocultas) ----------

function viewFor(role) {
  const isHost = role === 'host';
  const s = state;
  const f = s.feud;
  const q = content.feud.find((x) => x.id === f.qid);
  const feudView = {
    ...f,
    question: q
      ? {
          id: q.id,
          text: q.question,
          answers: q.answers.map((a, i) =>
            isHost || f.revealed[i] ? { text: a.text, points: a.points, revealed: !!f.revealed[i] } : { revealed: false }
          ),
        }
      : null,
  };

  const j = s.jeop;
  const { categories, values, final } = content.jeop;
  const clue = j.cell ? categories[j.cell.c]?.clues[j.cell.r] : null;
  const jeopView = {
    used: j.used,
    values,
    categories: categories.map((c) => c.name),
    cell: j.cell,
    stage: j.stage,
    isDD: j.isDD,
    ddTeam: j.ddTeam,
    ddWager: j.ddWager,
    judged: j.judged,
    clue: clue && (isHost || j.stage === 'clue' || j.stage === 'answer') ? clue.q : null,
    answer: clue && (isHost || j.stage === 'answer') ? clue.a : null,
  };

  const fin = s.final;
  const stageIdx = FINAL_STAGES.indexOf(fin.stage);
  const finalView = {
    stage: fin.stage,
    results: fin.results,
    maxWagers: isHost ? [finalMaxWager(0), finalMaxWager(1)] : null,
    wagers: isHost || fin.stage === 'results' ? fin.wagers : null,
    category: final?.category ?? null,
    clue: final && (isHost || stageIdx >= 1) ? final.q : null,
    answer: final && (isHost || stageIdx >= 2) ? final.a : null,
  };

  const view = {
    rev: s.rev,
    scene: s.scene,
    teams: s.teams,
    timer: s.timer,
    feud: feudView,
    jeop: jeopView,
    final: finalView,
  };

  if (isHost) {
    view.feudList = content.feud.map((x) => ({ id: x.id, text: x.question, count: x.answers.length, used: f.usedQids.includes(x.id) }));
    view.feudRounds = content.rounds;
    view.jeopFull = categories.map((c) => ({ name: c.name, clues: c.clues.map((cl) => ({ q: cl.q, a: cl.a })) }));
    view.dd = j.dd;
    view.canUndo = history.length > 0;
  }
  return view;
}

// ---------- HTTP estático ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function safeJoin(root, rel) {
  const full = path.normalize(path.join(root, rel));
  return full.startsWith(root + path.sep) ? full : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  if (p === '/') {
    res.writeHead(302, { Location: '/tv' });
    res.end();
    return;
  }
  if (p === '/tv') return sendFile(res, path.join(PUBLIC_DIR, 'tv.html'));
  if (p === '/host') return sendFile(res, path.join(PUBLIC_DIR, 'host.html'));
  if (p.startsWith('/fonts/')) {
    const file = safeJoin(FONTS_DIR, p.slice('/fonts/'.length));
    return file ? sendFile(res, file) : sendFile(res, '');
  }
  const file = safeJoin(PUBLIC_DIR, p.slice(1));
  return file ? sendFile(res, file) : sendFile(res, '');
});

// ---------- WebSocket ----------

let HOST_KEY = '';
try {
  HOST_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
} catch {}
if (!HOST_KEY) {
  HOST_KEY = crypto.randomBytes(3).toString('hex');
  fs.writeFileSync(KEY_FILE, HOST_KEY);
}

const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastState() {
  const views = { tv: null, host: null };
  for (const c of clients) {
    if (!c.role) continue;
    views[c.role] ??= viewFor(c.role);
    send(c.ws, { type: 'state', state: views[c.role], serverNow: Date.now() });
  }
}

function broadcastEvents(events) {
  for (const e of events) {
    for (const c of clients) if (c.role) send(c.ws, { type: 'event', ...e });
  }
}

wss.on('connection', (ws) => {
  const client = { ws, role: null };
  clients.add(client);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      if (msg.role === 'host') {
        if (msg.key !== HOST_KEY) {
          send(ws, { type: 'error', code: 'bad-key', msg: 'Llave de host inválida. Escaneá el QR de la terminal.' });
          return;
        }
        client.role = 'host';
      } else {
        client.role = 'tv';
      }
      send(ws, { type: 'state', state: viewFor(client.role), serverNow: Date.now() });
      return;
    }
    if (msg.type === 'action') {
      if (client.role !== 'host') return;
      try {
        const result = applyAction(msg.action, msg.payload, msg.rev);
        if (result.stale) {
          send(ws, { type: 'state', state: viewFor('host'), serverNow: Date.now() });
          return;
        }
        broadcastState();
        broadcastEvents(result.events);
      } catch (err) {
        if (!(err instanceof GameError)) console.error('💥 Error en acción', msg.action, err);
        send(ws, { type: 'toast', msg: err instanceof GameError ? err.message : 'Error inesperado (revisá la terminal)', error: true });
      }
    }
  });

  ws.on('close', () => clients.delete(client));
  ws.on('error', () => clients.delete(client));
});

// Detectar conexiones muertas (cel con pantalla apagada, etc.)
setInterval(() => {
  for (const c of clients) {
    if (!c.ws.isAlive) {
      c.ws.terminate();
      clients.delete(c);
      continue;
    }
    c.ws.isAlive = false;
    c.ws.ping();
  }
}, 10000);

// ---------- Arranque ----------

function lanAddress() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push({ name, address: a.address });
    }
  }
  candidates.sort((a, b) => (a.name === 'en0' ? -1 : b.name === 'en0' ? 1 : 0));
  return candidates[0]?.address || 'localhost';
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ El puerto ${PORT} ya está en uso. ¿Ya tenés Yopardi abierto en otra terminal? Probá: PORT=3001 npm start`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', async () => {
  const ip = lanAddress();
  const tvUrl = `http://localhost:${PORT}/tv`;
  const hostUrl = `http://${ip}:${PORT}/host?k=${HOST_KEY}`;
  console.log('\n🍻  YOPARDI listo\n');
  console.log(`📺  TV (esta compu):  ${tvUrl}`);
  console.log(`📱  Host (tu cel):    ${hostUrl}\n`);
  try {
    console.log(await QRCode.toString(hostUrl, { type: 'terminal', small: true }));
  } catch {}
  console.log('   Escaneá el QR con el cel (mismo WiFi que esta compu).\n');
  if (!process.env.NO_OPEN && process.platform === 'darwin') spawn('open', [tvUrl], { stdio: 'ignore', detached: true }).unref();
});

function shutdown() {
  clearTimeout(saveTimer);
  try {
    writeJSONAtomic(STATE_FILE, { state, history: history.slice(-30) });
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
