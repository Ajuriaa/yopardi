# 🍻 Yopardi: Family Feud × Jeopardy

Juego local para la noche con los cuates. Corre en tu laptop y no necesita internet, solo el WiFi de la casa.

## Arrancar

```bash
npm install     # solo la primera vez
npm start
```

- **TV:** se abre sola en la laptop (`http://localhost:3000/tv`). Conectá la laptop a la TV por HDMI, dale click a **"Click para empezar"** (activa el sonido y la pantalla completa) y listo. La tecla `F` también activa la pantalla completa.
- **Host (tu cel):** escaneá el QR que sale en la terminal. El cel tiene que estar en el mismo WiFi que la laptop.

> Si el WiFi de la casa da problemas, prendé el hotspot del cel y conectá la laptop a ese.

## Si algo sale mal

| Problema | Solución |
|---|---|
| Me equivoqué de botón | **↩︎ Deshacer**, arriba a la derecha (guarda hasta 100 pasos) |
| Se bloqueó el cel | Desbloquealo: se reconecta solo |
| Se cerró la terminal o se colgó la compu | `npm start` otra vez: el juego sigue donde iba |
| La TV no suena | Hacé click en cualquier lado de la TV |
| Puntaje mal | ⚙️ Ajustes → sumar o restar |
| "Puerto en uso" | Ya está corriendo en otra terminal, o usá `PORT=3001 npm start` |

## Preguntas

- `data/family-feud.json`: preguntas reales del show, con sus encuestas y puntajes.
- `data/jeopardy.json`: categorías del grupo. `"dd": true` marca un Daily Double. Este archivo es **privado** y no se sube al repo. Si no existe, se usa `data/jeopardy.example.json`.
- Si editás las preguntas con el juego corriendo: ⚙️ Ajustes → 🔄 Recargar preguntas.

## Reiniciar desde cero

En el cel: ⚙️ Ajustes → Reiniciar juego. También podés borrar `data/state.json` con el servidor apagado.
