(function(){
  "use strict";
  window.ARFLOW = window.ARFLOW || {};

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

  // fire-and-forget a Make.com. hookUrl viene de la config de campaña (no
  // más una constante fija por deploy), porque un mismo deploy sirve a
  // todos los clientes y cada uno tiene su propio webhook.
  function postToCRM(hookUrl, payload){
    if (!hookUrl){
      console.warn('[CRM] hook de Make no configurado en esta campaña, se omite el registro.');
      return;
    }
    // Content-Type text/plain evita el preflight CORS (OPTIONS) que muchos
    // webhooks de Make no responden bien — Make igual parsea el body como JSON.
    // keepalive asegura el envío aunque la página navegue (ej: al abrir WhatsApp).
    fetch(hookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(function(err){
      console.warn('[CRM] No se pudo registrar la acción:', err);
    });
  }

  window.ARFLOW.crm = {
    nowDDMMYYYYHHmm: nowDDMMYYYYHHmm,
    formatWhatsapp: formatWhatsapp,
    postToCRM: postToCRM
  };
})();
