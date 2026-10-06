// Conexión al servidor con reconexión automática.
// El servidor manda el estado completo en cada cambio, así que reconectar nunca pierde nada.

export function connect(role, { onState, onEvent, onToast, onStatus, onError }) {
  let key = null;
  if (role === 'host') {
    const params = new URLSearchParams(location.search);
    key = params.get('k');
    try {
      if (key) localStorage.setItem('yopardi-host-key', key);
      else key = localStorage.getItem('yopardi-host-key');
    } catch {}
  }

  let ws = null;
  let retry = 0;
  let offset = 0;
  let rev = undefined;

  function open() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      ws.send(JSON.stringify({ type: 'hello', role, key }));
      onStatus?.(true);
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.serverNow) offset = m.serverNow - Date.now();
      if (m.type === 'state') {
        rev = m.state.rev;
        onState?.(m.state);
      } else if (m.type === 'event') onEvent?.(m.name, m.data || {});
      else if (m.type === 'toast') onToast?.(m.msg, m.error);
      else if (m.type === 'error') onError?.(m);
    };
    ws.onclose = () => {
      onStatus?.(false);
      setTimeout(open, Math.min(4000, 250 * 2 ** retry++));
    };
    ws.onerror = () => ws.close();
  }

  // Al volver a la pestaña (cel desbloqueado), reconectar de una si hace falta.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ws && ws.readyState > 1) {
      retry = 0;
      open();
    }
  });

  open();

  return {
    send(action, payload) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify({ type: 'action', action, payload, rev }));
      return true;
    },
    now: () => Date.now() + offset,
  };
}
