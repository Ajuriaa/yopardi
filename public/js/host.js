import { connect } from './net.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Botón que dispara una acción en el servidor.
const act = (action, payload = {}, { cls = '', label = '', disabled = false, confirm = '' } = {}) =>
  `<button class="btn ${cls}" data-act="${action}" data-p='${esc(JSON.stringify(payload))}'${confirm ? ` data-confirm="${esc(confirm)}"` : ''}${disabled ? ' disabled' : ''}>${label}</button>`;

let state = null;
let localView = null; // 'settings' muestra ajustes sin cambiar la TV

const TABS = [
  ['lobby', 'Inicio'],
  ['rules', 'Reglas'],
  ['feud', 'Feud'],
  ['jeopardy', 'Jeopardy'],
  ['final', 'Final'],
  ['scores', 'Marcador'],
  ['end', 'Fin 👑'],
];

// ---------- Utilidades de UI ----------

let toastTimer = null;
function toast(msg, error = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', !!error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// Hoja inferior genérica. Devuelve una promesa con el valor (o null si cancela).
function sheet({ title, body = '', okLabel = 'OK', read = () => true }) {
  return new Promise((resolve) => {
    $('#sheet-title').textContent = title;
    $('#sheet-body').innerHTML = body;
    $('#sheet-ok').textContent = okLabel;
    $('#sheet').classList.remove('hidden');
    const input = $('#sheet-body input');
    if (input) setTimeout(() => input.focus(), 50);
    const close = (value) => {
      $('#sheet').classList.add('hidden');
      $('#sheet-ok').onclick = $('#sheet-cancel').onclick = null;
      $('#sheet-body').onclick = null;
      resolve(value);
    };
    $('#sheet-ok').onclick = () => close(read());
    $('#sheet-cancel').onclick = () => close(null);
    $('#sheet-body').onclick = (e) => {
      const chip = e.target.closest('[data-chip]');
      if (chip && input) input.value = chip.dataset.chip;
    };
    if (input) input.onkeydown = (e) => e.key === 'Enter' && close(read());
  });
}

function askNumber(title, { value = '', max = null, chips = [] } = {}) {
  const chipHtml = chips.length ? `<div class="chips">${chips.map(([l, v]) => `<button class="btn" data-chip="${v}">${esc(l)}</button>`).join('')}</div>` : '';
  return sheet({
    title,
    body: `<input type="number" inputmode="numeric" pattern="[0-9]*" value="${esc(value)}" ${max !== null ? `max="${max}"` : ''} min="0">${chipHtml}${max !== null ? `<p class="hint">Máximo: ${max}</p>` : ''}`,
    read: () => {
      const v = Number($('#sheet-body input').value);
      return Number.isFinite(v) && $('#sheet-body input').value !== '' ? v : null;
    },
  });
}

function askText(title, value = '') {
  return sheet({
    title,
    body: `<input type="text" maxlength="24" value="${esc(value)}" autocapitalize="words">`,
    read: () => $('#sheet-body input').value.trim() || null,
  });
}

function askConfirm(title, okLabel = 'Sí') {
  return sheet({ title, okLabel });
}

// ---------- Envío de acciones ----------

let net = null;
function send(action, payload) {
  if (!net.send(action, payload)) {
    toast('Sin conexión con la compu', true);
    return;
  }
  navigator.vibrate?.(12);
}

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    const t = tab.dataset.tab;
    if (t === 'settings') localView = 'settings';
    else {
      localView = null;
      if (state.scene !== t) send('setScene', { scene: t });
    }
    render();
    window.scrollTo({ top: 0 });
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (btn && !btn.disabled) {
    if (btn.dataset.confirm && !(await askConfirm(btn.dataset.confirm))) return;
    let payload = {};
    try {
      payload = JSON.parse(btn.dataset.p || '{}');
    } catch {}
    send(btn.dataset.act, payload);
    return;
  }

  const ui = e.target.closest('[data-ui]');
  if (ui) await handleUi(ui.dataset.ui, JSON.parse(ui.dataset.p || '{}'));
});

// Acciones que primero piden datos al host.
async function handleUi(kind, p) {
  if (kind === 'rename') {
    const name = await askText(`Nombre del equipo ${p.team + 1}`, state.teams[p.team].name);
    if (name) send('setTeamName', { team: p.team, name });
  } else if (kind === 'addScore' || kind === 'subScore') {
    const v = await askNumber(kind === 'addScore' ? `Sumar puntos a ${state.teams[p.team].name}` : `Restar puntos a ${state.teams[p.team].name}`);
    if (v) send('adjustScore', { team: p.team, delta: kind === 'addScore' ? v : -v });
  } else if (kind === 'ddWager') {
    const score = state.teams[p.team].score;
    const max = Math.max(score, Math.max(...state.jeop.values));
    const v = await askNumber(`Apuesta de ${state.teams[p.team].name} (Daily Double)`, {
      max,
      chips: [['Mitad', Math.floor(max / 2)], ['¡Todo!', max]],
    });
    if (v !== null) send('jeopWager', { team: p.team, amount: Math.min(v, max) });
  } else if (kind === 'finalWager') {
    const max = Math.max(state.teams[p.team].score, 0);
    const v = await askNumber(`Apuesta final de ${state.teams[p.team].name}`, {
      value: state.final.wagers?.[p.team] || '',
      max,
      chips: [['0', 0], ['Mitad', Math.floor(max / 2)], ['¡Todo!', max]],
    });
    if (v !== null) send('finalWager', { team: p.team, amount: Math.min(v, max) });
  } else if (kind === 'feudChange') {
    const f = state.feud;
    if (f.bank > 0 && f.awarded === null && !(await askConfirm('El banco no se ha dado. ¿Cambiar de pregunta igual?', 'Cambiar'))) return;
    send('feudClear');
  }
}

$('#undo').addEventListener('click', () => send('undo'));

// ---------- Render ----------

function renderTop() {
  $('#mini-scores').innerHTML = state.teams
    .map((t, i) => `<div class="mini team-${i}"><span class="nm">${esc(t.name)}</span><span class="sc">${t.score}</span></div>`)
    .join('');
  $('#undo').disabled = !state.canUndo;
  const current = localView || state.scene;
  $('#tabs').innerHTML =
    TABS.map(([id, label]) => `<button class="tab ${current === id ? 'on' : ''}" data-tab="${id}">${label}</button>`).join('') +
    `<button class="tab local ${current === 'settings' ? 'on' : ''}" data-tab="settings">⚙️ Ajustes</button>`;
  $('#drinkbar').innerHTML = [
    act('drink', { team: 0, reason: 'Orden del host' }, { cls: 'team team-0', label: `🍺 ${esc(state.teams[0].name)}` }),
    act('drink', { team: null, reason: '¡Todos toman!' }, { cls: 'all', label: '🍻 Todos' }),
    act('drink', { team: 1, reason: 'Orden del host' }, { cls: 'team team-1', label: `🍺 ${esc(state.teams[1].name)}` }),
  ].join('');
}

function panelInfo(title, text, extra = '') {
  return `<div class="card"><h2>La TV muestra</h2><div class="q">${title}</div><p>${text}</p>${extra}</div>`;
}

function panelFeud() {
  const f = state.feud;
  if (!f.question) {
    const items = state.feudList
      .map(
        (q) => `<button class="btn qitem ${q.used ? 'used' : ''}" data-act="feudLoad" data-p='${esc(JSON.stringify({ qid: q.id }))}'>
          <span class="t">${esc(q.text)}</span><span class="badge">${q.used ? 'usada' : q.count + ' resp'}</span></button>`
      )
      .join('');
    return `<div class="card"><h2>Escogé una pregunta</h2>${
      state.feudList.length ? `<div class="qlist">${items}</div>` : '<p>No hay preguntas. Revisá data/family-feud.json</p>'
    }</div>`;
  }

  const t = state.teams;
  const awarded = f.awarded !== null;
  const answers = f.question.answers
    .map(
      (a, i) => `<button class="ans ${a.revealed ? 'done' : ''}" data-act="feudReveal" data-p='{"idx":${i}}' ${a.revealed ? 'disabled' : ''}>
        <span class="n">${i + 1}</span><span class="t">${esc(a.text)}</span><span class="p">${a.points * f.mult}</span></button>`
    )
    .join('');

  let strikeLabel = `❌ STRIKE`;
  let strikeHint = '';
  if (f.control === null) {
    strikeLabel = '❌ X (face-off)';
    strikeHint = 'Face-off: la X suena pero no cuenta. Escogé quién tiene el control.';
  } else if (f.steal) {
    strikeLabel = '❌ Falló el robo';
    strikeHint = '';
  }

  const stealing = f.steal && f.control !== null ? 1 - f.control : null;
  let bankCard;
  if (awarded) {
    bankCard = `<div class="card"><div class="bank"><span>Puntos dados a <b style="font-size:18px;color:var(--text);font-family:var(--body)">${esc(t[f.awarded].name)}</b></span><b>${f.bank}</b></div>
      <div class="row">${act('feudRevealRest', {}, { label: 'Revelar las demás' })}<button class="btn primary" data-ui="feudChange">Siguiente pregunta →</button></div></div>`;
  } else {
    bankCard = `<div class="card"><div class="bank"><span>Banco</span><b>${f.bank}</b></div>
      ${stealing !== null ? `<div class="steal-banner">¡ROBO! ${esc(t[stealing].name)} tiene 1 intento</div><p class="hint">Si acierta: revelá la respuesta y dale el banco a ${esc(t[stealing].name)}. Si falla: tocá STRIKE y dale el banco a ${esc(t[f.control].name)}.</p>` : ''}
      <div class="row" style="margin-top:8px">
        ${act('feudAward', { team: 0 }, { cls: 'team team-0', label: `+${f.bank} → ${esc(t[0].name)}`, confirm: `¿Dar ${f.bank} puntos a ${t[0].name}?` })}
        ${act('feudAward', { team: 1 }, { cls: 'team team-1', label: `+${f.bank} → ${esc(t[1].name)}`, confirm: `¿Dar ${f.bank} puntos a ${t[1].name}?` })}
      </div></div>`;
  }

  return `
    <div class="card">
      <h2>Pregunta ${f.mult > 1 ? `<span class="dd-flag">${f.mult}X</span>` : ''}</h2>
      <div class="q">${esc(f.question.text)}</div>
      <div class="row" style="margin-top:12px">
        <span class="label">Puntos</span>
        ${[1, 2, 3].map((m) => act('feudMult', { mult: m }, { cls: f.mult === m ? 'on' : '', label: `${m}x` })).join('')}
      </div>
      <div class="row">
        <span class="label">Control</span>
        ${act('feudControl', { team: 0 }, { cls: f.control === 0 ? 'team team-0' : '', label: esc(t[0].name), disabled: awarded })}
        ${act('feudControl', { team: 1 }, { cls: f.control === 1 ? 'team team-1' : '', label: esc(t[1].name), disabled: awarded })}
      </div>
    </div>
    <div class="answers">${answers}</div>
    ${awarded ? '' : `<div class="strike-wrap">${act('feudStrike', {}, { cls: 'strike', label: strikeLabel })}
      <div class="strikes-dots">${[1, 2, 3].map((n) => `<span class="${f.strikes >= n ? 'on' : ''}">X</span>`).join('')}</div>
      ${strikeHint ? `<p class="hint" style="text-align:center">${strikeHint}</p>` : ''}</div>`}
    ${bankCard}
    ${awarded ? '' : `<button class="btn ghost" data-ui="feudChange">Cambiar pregunta</button>`}`;
}

function panelJeop() {
  const j = state.jeop;
  const t = state.teams;
  if (!j.categories.length) {
    return `<div class="card"><h2>Jeopardy</h2><p>Todavía no hay categorías. Se llenan en data/jeopardy.json</p></div>`;
  }
  if (!j.cell) {
    let grid = j.categories.map((c) => `<div class="jcat">${esc(c)}</div>`).join('');
    j.values.forEach((v, r) => {
      j.categories.forEach((_, c) => {
        const k = `${c}-${r}`;
        const used = !!j.used[k];
        grid += `<button class="jcell" data-act="jeopOpen" data-p='{"c":${c},"r":${r}}' ${used ? 'disabled' : ''}>${v}${
          state.dd.includes(k) && !used ? '<span class="star">★</span>' : ''
        }</button>`;
      });
    });
    const left = j.categories.length * j.values.length - Object.keys(j.used).length;
    return `<div class="card"><h2>Tablero · quedan ${left}</h2><div class="jgrid" style="--cols:${j.categories.length}">${grid}</div>
      <p class="hint">★ = Daily Double (solo vos lo ves)</p></div>`;
  }

  const full = state.jeopFull[j.cell.c].clues[j.cell.r];
  const head = `<h2>${esc(j.categories[j.cell.c])} · ${j.isDD ? `<span class="dd-flag">DAILY DOUBLE</span>` : j.values[j.cell.r]}</h2>`;
  if (j.stage === 'dd') {
    return `<div class="card">${head}<div class="q">¿Qué equipo apuesta y cuánto?</div>
      <p>La TV está mostrando el Daily Double. La pregunta aparece cuando ponés la apuesta.</p>
      <div class="row" style="margin-top:10px">
        <button class="btn team team-0" data-ui="ddWager" data-p='{"team":0}'>${esc(t[0].name)}</button>
        <button class="btn team team-1" data-ui="ddWager" data-p='{"team":1}'>${esc(t[1].name)}</button>
      </div></div>
      <div class="card"><div class="clue">${esc(full.q)}</div><div class="answer"><small>Respuesta</small>${esc(full.a)}</div></div>
      ${act('jeopClose', {}, { cls: 'ghost', label: 'Cancelar y volver al tablero', confirm: '¿Cerrar sin jugar? Se marca como usada.' })}`;
  }

  const judgeRow = (i) => {
    const r = j.judged[i];
    const blocked = (j.isDD && j.ddTeam !== i) || r !== null;
    return `<div class="judge team-${i}"><span class="tn">${esc(t[i].name)}${r === true ? ' ✅' : r === false ? ' ❌' : ''}</span>
      ${act('jeopJudge', { team: i, correct: true }, { cls: 'good', label: '✅ Bien', disabled: blocked })}
      ${act('jeopJudge', { team: i, correct: false }, { cls: 'bad', label: '❌ Mal', disabled: blocked })}</div>`;
  };

  return `<div class="card">${head}
      ${j.isDD ? `<p>${esc(t[j.ddTeam]?.name ?? '')} apostó <b style="color:var(--gold)">${j.ddWager}</b></p>` : ''}
      <div class="clue">${esc(full.q)}</div>
      <div class="answer"><small>Respuesta</small>${esc(full.a)}</div></div>
    <div class="card"><h2>¿Quién respondió?</h2>${judgeRow(0)}${judgeRow(1)}
      <p class="hint">Fallar resta puntos y manda a tomar.</p></div>
    <div class="row">
      ${act('jeopReveal', {}, { label: 'Mostrar respuesta', disabled: j.stage === 'answer' })}
      ${act('jeopClose', {}, { cls: 'primary', label: 'Volver al tablero →' })}
    </div>`;
}

function panelFinal() {
  const fin = state.final;
  const t = state.teams;
  const stages = [
    ['category', 'Categoría'],
    ['clue', 'Pregunta'],
    ['answer', 'Respuesta'],
    ['results', 'Resultados'],
  ];
  const judgeRow = (i) => {
    const r = fin.results[i];
    return `<div class="judge team-${i}"><span class="tn">${esc(t[i].name)}${r === true ? ' ✅' : r === false ? ' ❌' : ''}</span>
      ${act('finalJudge', { team: i, correct: true }, { cls: r === true ? 'good' : '', label: '✅ Bien' })}
      ${act('finalJudge', { team: i, correct: false }, { cls: r === false ? 'bad' : '', label: '❌ Mal' })}</div>`;
  };
  return `
    <div class="card"><h2>Paso en la TV</h2>
      <div class="row">${stages.map(([id, l]) => act('finalStage', { stage: id }, { cls: fin.stage === id ? 'on' : '', label: l })).join('')}</div>
    </div>
    <div class="card"><h2>${esc(fin.category ?? 'Sin final configurada')}</h2>
      ${fin.clue ? `<div class="clue">${esc(fin.clue)}</div><div class="answer"><small>Respuesta</small>${esc(fin.answer)}</div>` : '<p>Agregá "final" en data/jeopardy.json</p>'}
    </div>
    <div class="card"><h2>1 · Apuestas (antes de mostrar la pregunta)</h2>
      ${t
        .map(
          (team, i) => `<div class="row team-${i}"><span class="label" style="color:var(--team);font-weight:800">${esc(team.name)}</span>
          <span style="font-family:var(--display);font-size:22px;color:var(--gold)">${fin.wagers[i]}</span>
          <button class="btn" data-ui="finalWager" data-p='{"team":${i}}'>Apuesta…</button></div>`
        )
        .join('')}
    </div>
    <div class="card"><h2>2 · Tiempo</h2>
      <div class="row">${act('timerStart', { seconds: 30 }, { label: '▶ 30 s' })}${act('timerStart', { seconds: 60 }, { label: '▶ 60 s' })}${act('timerStop', {}, { label: '■ Parar', disabled: !state.timer })}</div>
    </div>
    <div class="card"><h2>3 · Calificar</h2>${judgeRow(0)}${judgeRow(1)}
      <p class="hint">Podés corregir: tocar el otro botón revierte y aplica de nuevo.</p></div>`;
}

function panelSettings() {
  const t = state.teams;
  const teamCard = (i) => `<div class="card team-${i}">
    <div class="team-title">${esc(t[i].name)} <span>${t[i].score}</span></div>
    <div class="score-adj">
      ${act('adjustScore', { team: i, delta: -50 }, { label: '−50' })}
      ${act('adjustScore', { team: i, delta: -10 }, { label: '−10' })}
      ${act('adjustScore', { team: i, delta: 10 }, { label: '+10' })}
      ${act('adjustScore', { team: i, delta: 50 }, { label: '+50' })}
    </div>
    <div class="row" style="margin-top:8px">
      <button class="btn" data-ui="subScore" data-p='{"team":${i}}'>− Restar…</button>
      <button class="btn" data-ui="addScore" data-p='{"team":${i}}'>+ Sumar…</button>
      <button class="btn" data-ui="rename" data-p='{"team":${i}}'>✏️ Nombre</button>
    </div></div>`;
  return `${teamCard(0)}${teamCard(1)}
    <div class="card"><h2>Cronómetro en la TV</h2>
      <div class="row">${act('timerStart', { seconds: 15 }, { label: '15 s' })}${act('timerStart', { seconds: 30 }, { label: '30 s' })}${act('timerStop', {}, { label: '■', disabled: !state.timer })}</div>
    </div>
    <div class="card"><h2>Mantenimiento</h2>
      <div class="row">${act('reloadContent', {}, { label: '🔄 Recargar preguntas' })}</div>
      <div class="row">${act('reset', {}, { cls: 'danger', label: '🗑 Reiniciar juego (puntos a 0)', confirm: '¿Reiniciar todo? Los puntos vuelven a 0. (Se puede deshacer)' })}</div>
      <p class="hint">Tip: poné el cel para que no se bloquee mientras jugás. Si se bloquea, al volver se reconecta solo.</p>
    </div>`;
}

function render() {
  if (!state) return;
  renderTop();
  const view = localView || state.scene;
  let html = '';
  switch (view) {
    case 'lobby':
      html = panelInfo('Pantalla de inicio', 'Logo y equipos. Cuando estén listos pasá a Reglas o directo a Feud.');
      break;
    case 'rules':
      html = panelInfo('Reglas de tomar', 'Leelas en voz alta para que nadie se haga el loco después.');
      break;
    case 'scores':
      html = panelInfo('Marcador grande', `${esc(state.teams[0].name)} ${state.teams[0].score} — ${state.teams[1].score} ${esc(state.teams[1].name)}`);
      break;
    case 'end': {
      const [a, b] = state.teams;
      const msg = a.score === b.score ? '¡Empate! Shot para todos.' : `Gana ${esc(a.score > b.score ? a.name : b.name)}. ${esc(a.score > b.score ? b.name : a.name)} se toma el shot grupal.`;
      html = panelInfo('🏆 Ganador', msg);
      break;
    }
    case 'feud':
      html = panelFeud();
      break;
    case 'jeopardy':
      html = panelJeop();
      break;
    case 'final':
      html = panelFinal();
      break;
    case 'settings':
      html = panelSettings();
      break;
  }
  $('#panel').innerHTML = html;
}

net = connect('host', {
  onState: (s) => {
    state = s;
    $('#badkey').classList.add('hidden');
    render();
  },
  onEvent: (name) => {
    if (name === 'undo') toast('Deshecho ↩︎');
  },
  onToast: toast,
  onStatus: (ok) => $('#dot').classList.toggle('ok', ok),
  onError: (m) => {
    if (m.code === 'bad-key') $('#badkey').classList.remove('hidden');
  },
});
