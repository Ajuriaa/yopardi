// Conexión al servidor con reconexión automática.
// El servidor manda el estado completo en cada cambio, así que reconectar nunca pierde nada.

const KEY_STORAGE = 'yopardi-host-key';

export function connect(role, { onState, onEvent, onToast, onStatus, onError }) {
  // La llave del link solo se guarda cuando el servidor la acepta, así un link malo no borra la buena.
  let urlKey = null;
  let key = null;
  if (role === 'host') {
    urlKey = new URLSearchParams(location.search).get('k');
    try {
      key = urlKey || localStorage.getItem(KEY_STORAGE);
    } catch {
      key = urlKey;
    }
  }

  let ws = null;
  let retry = 0;
  let retryTimer = null;
  let offset = 0;
  let rev = undefined;

  function scheduleReconnect() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, Math.min(4000, 250 * 2 ** retry++));
  }

  function open() {
    // Nunca más de una conexión viva a la vez.
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(retryTimer);
    retryTimer = null;
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      sock.send(JSON.stringify({ type: 'hello', role, key }));
      onStatus?.(true);
    };
    sock.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.serverNow) offset = m.serverNow - Date.now();
      if (m.type === 'state') {
        if (role === 'host' && urlKey) {
          try {
            localStorage.setItem(KEY_STORAGE, urlKey);
          } catch {}
        }
        rev = m.state.rev;
        onState?.(m.state);
      } else if (m.type === 'event') onEvent?.(m.name, m.data || {});
      else if (m.type === 'toast') onToast?.(m.msg, m.error);
      else if (m.type === 'error') onError?.(m);
    };
    sock.onclose = () => {
      if (ws !== sock) return; // conexión vieja: ignorar
      onStatus?.(false);
      scheduleReconnect();
    };
    sock.onerror = () => sock.close();
  }

  // Al volver a la pestaña (cel desbloqueado), reconectar de una si hace falta.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
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
    connected: () => !!ws && ws.readyState === WebSocket.OPEN,
    now: () => Date.now() + offset,
  };
}
