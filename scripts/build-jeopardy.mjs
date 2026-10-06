// Arma data/jeopardy.json a partir de las pistas aprobadas.
// Uso: node scripts/build-jeopardy.mjs c1-1 c1-4 c2-3 ... f-2 [--dd c3-4]
// Toma private/jeopardy-candidates.json, ordena cada categoría por dificultad (tier)
// y la acomoda en las filas de 20 a 100.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATES = path.join(root, 'private', 'jeopardy-candidates.json');
const OUT = path.join(root, 'data', 'jeopardy.json');
const VALUES = [20, 40, 60, 80, 100];

const args = process.argv.slice(2);
const ddIds = new Set();
const ids = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dd') ddIds.add(args[++i]);
  else ids.push(...args[i].split(',').map((s) => s.trim()).filter(Boolean));
}
const approved = new Set(ids);

const cand = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8'));
const known = new Set([...cand.categories.flatMap((c) => c.clues.map((cl) => cl.id)), ...(cand.final || []).map((f) => f.id)]);
const unknown = ids.filter((id) => !known.has(id));
if (unknown.length) console.warn(`⚠️  IDs que no existen: ${unknown.join(', ')}`);

const categories = [];
for (const c of cand.categories) {
  const picked = c.clues.filter((cl) => approved.has(cl.id)).sort((a, b) => (a.tier ?? 3) - (b.tier ?? 3));
  if (!picked.length) continue;
  if (picked.length !== VALUES.length) {
    console.warn(`⚠️  "${c.name}" tiene ${picked.length} aprobadas (necesita ${VALUES.length}). ${picked.length > VALUES.length ? 'Se usan las primeras 5.' : 'Faltan, se rellenan con (pendiente).'}`);
  }
  categories.push({
    name: c.name,
    clues: picked.slice(0, VALUES.length).map((cl) => ({ q: cl.q, a: cl.a, ...(ddIds.has(cl.id) ? { dd: true } : {}) })),
  });
}
if (categories.length > 6) console.warn(`⚠️  ${categories.length} categorías aprobadas: el tablero muestra solo las primeras 6.`);

const finals = (cand.final || []).filter((f) => approved.has(f.id));
if (finals.length !== 1) console.warn(`⚠️  ${finals.length} finales aprobadas (debería ser 1). Se usa ${finals.length ? 'la primera' : 'ninguna'}.`);
const final = finals[0] ? { category: finals[0].category, q: finals[0].q, a: finals[0].a } : null;

fs.writeFileSync(OUT, JSON.stringify({ values: VALUES, categories: categories.slice(0, 6), final }, null, 2));
console.log(`✅ ${OUT}: ${Math.min(categories.length, 6)} categorías, ${final ? 'con' : 'sin'} final. Recargá preguntas desde ⚙️ Ajustes en el cel.`);
