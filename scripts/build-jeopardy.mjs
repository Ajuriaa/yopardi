// Arma data/jeopardy.json a partir de las pistas aprobadas.
// Uso: node scripts/build-jeopardy.mjs
//
// Lee todas las candidatas de private/jeopardy-candidates*.json y la selección del host en
// private/picks.json:
// {
//   "categories": [ { "name": "¿Quién dijo?", "ids": ["c1-1", "c1-2", ...] } ],
//   "overrides": { "c2-9": { "q": "texto nuevo", "tier": 5 } },
//   "dd": ["c5-6", "c8-8"],
//   "final": "f-4"
// }
// Cada categoría se ordena por dificultad (tier) y se acomoda en las filas de 20 a 100.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE = path.join(root, 'private');
const OUT = path.join(root, 'data', 'jeopardy.json');
const VALUES = [20, 40, 60, 80, 100];

const clues = new Map();
const finals = new Map();
for (const file of fs.readdirSync(PRIVATE).filter((f) => /^jeopardy-candidates.*\.json$/.test(f))) {
  const data = JSON.parse(fs.readFileSync(path.join(PRIVATE, file), 'utf8'));
  for (const c of data.categories || []) for (const cl of c.clues || []) clues.set(cl.id, cl);
  for (const f of data.final || []) finals.set(f.id, f);
}

const picks = JSON.parse(fs.readFileSync(path.join(PRIVATE, 'picks.json'), 'utf8'));
const overrides = picks.overrides || {};
const dd = new Set(picks.dd || []);
let problems = 0;
const warn = (msg) => {
  problems++;
  console.warn(`⚠️  ${msg}`);
};

const categories = (picks.categories || []).map((cat) => {
  const picked = cat.ids
    .map((id) => {
      const base = clues.get(id);
      if (!base) {
        warn(`"${cat.name}": no existe la pista ${id}`);
        return null;
      }
      return { id, ...base, ...overrides[id] };
    })
    .filter(Boolean)
    .sort((a, b) => (a.tier ?? 3) - (b.tier ?? 3));
  if (picked.length !== VALUES.length) warn(`"${cat.name}" tiene ${picked.length} pistas (necesita ${VALUES.length})`);
  return {
    name: cat.name,
    clues: picked.slice(0, VALUES.length).map((cl) => ({ q: cl.q, a: cl.a, ...(dd.has(cl.id) ? { dd: true } : {}) })),
  };
});
if (categories.length !== 6) warn(`Hay ${categories.length} categorías (el tablero usa 6)`);
const pickedIds = new Set((picks.categories || []).flatMap((c) => c.ids));
for (const id of dd) if (!pickedIds.has(id)) warn(`Daily Double ${id} no está en el tablero`);

const f = finals.get(picks.final);
if (!f) warn(`Final ${picks.final ?? '(ninguna)'} no existe`);

fs.writeFileSync(
  OUT,
  JSON.stringify({ values: VALUES, categories, final: f ? { category: f.category, q: f.q, a: f.a } : null }, null, 2)
);
console.log(`${problems ? '🟡' : '✅'} ${OUT}: ${categories.length} categorías, ${dd.size} Daily Double, ${f ? 'con' : 'sin'} final.`);
console.log('   Con el juego corriendo: ⚙️ Ajustes → 🔄 Recargar preguntas.');
