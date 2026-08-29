(function(){
  "use strict";
  window.ARFLOW = window.ARFLOW || {};

  const PENDING_KEY = 'arflow_pending_crm';
  const PENDING_MAX = 20;
  const RETRY_DELAYS_MS = [0, 1500, 4000]; // intento inmediato, +1.5s, +4s

  function nowDDMMYYYYHHmm(){
    const d = new Date();
    const pad = function(n){ return String(n).padStart(2, '0'); };
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function formatWhatsapp(raw){
    // Deja solo dígitos: quita espacios, guiones, paréntesis y el signo '+'.
    const digits = (raw || '').replace(/\D/g, '');

    // Ya viene completo con prefijo argentino (549 + 10 dígitos) -> se conserva tal cual.
    if (digits.length === 13 && digits.startsWith('549')) return digits;

    // Número local de 10 dígitos (código de área + número, ej. 3816334040) -> anteponer 549.
    if (digits.length === 10) return '549' + digits;

    return digits;
  }

  function sendOnce(hookUrl, payload){
    // Content-Type text/plain evita el preflight CORS (OPTIONS) que muchos
    // webhooks de Make no responden bien — Make igual parsea el body como JSON.
    // keepalive asegura el envío aunque la página navegue (ej: al abrir WhatsApp).
    return fetch(hookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload),
      keepalive: true
    });
  }

  function delay(ms){
    return new Promise(function(resolve){ setTimeout(resolve, ms); });
  }

  function readPendingQueue(){
    try {
      const raw = window.localStorage.getItem(PENDING_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function writePendingQueue(queue){
    try {
      window.localStorage.setItem(PENDING_KEY, JSON.stringify(queue.slice(-PENDING_MAX)));
    } catch (e) {
      // localStorage no disponible (modo privado, cuota llena, etc.) -> se pierde
      // el respaldo, pero no rompe el flujo del visitante.
    }
  }

  function queueFailed(hookUrl, payload){
    const queue = readPendingQueue();
    queue.push({ hookUrl: hookUrl, payload: payload, ts: Date.now() });
    writePendingQueue(queue);
  }

  // Reintenta lo que quedó pendiente de una visita anterior EN ESTE MISMO
  // navegador — ayuda sobre todo si el QR se escanea muchas veces seguidas
  // desde el mismo dispositivo (ej. una tablet en el mostrador) y Make estuvo
  // momentáneamente saturado. Esto reduce, no elimina, la pérdida de leads: si
  // el visitante cierra la pestaña y no vuelve a abrir el sitio, ese envío
  // pendiente nunca se reintenta — no existe una cola del lado del servidor.
  function flushPendingQueue(){
    const queue = readPendingQueue();
    if (queue.length === 0) return;
    writePendingQueue([]); // se repuebla con lo que vuelva a fallar
    queue.forEach(function(item){
      sendOnce(item.hookUrl, item.payload).catch(function(){
        queueFailed(item.hookUrl, item.payload);
      });
    });
  }

  // fire-and-forget a Make.com. hookUrl viene de la config de campaña (no
  // más una constante fija por deploy), porque un mismo deploy sirve a
  // todos los clientes y cada uno tiene su propio webhook.
  function postToCRM(hookUrl, payload){
    if (!hookUrl){
      console.warn('[CRM] hook de Make no configurado en esta campaña, se omite el registro.');
      return;
    }

    let attempt = 0;
    function tryOnce(){
      return sendOnce(hookUrl, payload).catch(function(err){
        attempt++;
        if (attempt < RETRY_DELAYS_MS.length){
          return delay(RETRY_DELAYS_MS[attempt]).then(tryOnce);
        }
        console.warn('[CRM] No se pudo registrar la acción tras reintentos, se guarda para reintentar más adelante:', err);
        queueFailed(hookUrl, payload);
      });
    }
    tryOnce();
  }

  // Contador liviano de rendimiento (jugado/ganado/reclamado) para el
  // dashboard interno — camino paralelo al envío a Make, no lo reemplaza ni
  // depende de él.
  function pingStats(cid, type){
    if (!cid) return;
    fetch('/api/log-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid: cid, type: type }),
      keepalive: true
    }).catch(function(){ /* solo estadística, no crítico para el visitante */ });
  }

  flushPendingQueue();
  window.addEventListener('online', flushPendingQueue);

  window.ARFLOW.crm = {
    nowDDMMYYYYHHmm: nowDDMMYYYYHHmm,
    formatWhatsapp: formatWhatsapp,
    postToCRM: postToCRM,
    pingStats: pingStats
  };
})();
