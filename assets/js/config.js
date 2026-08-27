(function(){
  "use strict";
  window.ARFLOW = window.ARFLOW || {};

  const DEFAULT_COLORS = { bg: '#0A0A0A', p: '#00E5FF', a: '#F5A623' };

  const DEFAULT_CONFIG = {
    v: 1,
    biz: 'Tu Negocio',
    rubro: '',
    game: 'wheel',
    prizes: [
      { l: '25% de Descuento', w: 3 },
      { l: '50% de Descuento', w: 1 },
      { l: 'Gracias por participar', w: 6 }
    ],
    q: ['¿Qué te interesa?'],
    wa: '',
    hook: '',
    colors: DEFAULT_COLORS,
    logo: 'assets/logo.png'
  };

  // btoa/atob ingenuos rompen con tildes/ñ (fuera de Latin1). Se pasa por
  // TextEncoder/TextDecoder antes de base64 para soportar UTF-8 completo,
  // y se usa el alfabeto base64url (-_  sin padding) porque es más seguro
  // de meter en un query param sin escapes adicionales.
  function encodeConfig(obj){
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    bytes.forEach(function(b){ bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeConfig(str){
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // Completa campos faltantes con default y descarta tipos inesperados,
  // para que un cfg viejo o mal formado no rompa el motor de juego.
  function normalizeConfig(raw){
    const cfg = Object.assign({}, DEFAULT_CONFIG, raw || {});
    cfg.colors = Object.assign({}, DEFAULT_COLORS, raw && raw.colors);
    if (!Array.isArray(cfg.prizes) || cfg.prizes.length === 0){
      cfg.prizes = DEFAULT_CONFIG.prizes;
    } else {
      cfg.prizes = cfg.prizes
        .filter(function(p){ return p && typeof p.l === 'string' && p.l.trim() !== ''; })
        .map(function(p){ return { l: p.l, w: (typeof p.w === 'number' && p.w > 0) ? p.w : 1 }; });
      if (cfg.prizes.length === 0) cfg.prizes = DEFAULT_CONFIG.prizes;
    }
    if (cfg.game !== 'wheel' && cfg.game !== 'scratch') cfg.game = 'wheel';
    // Hasta 2 preguntas opcionales. Compatibilidad con links viejos donde
    // `q` era un string único en vez de array.
    if (typeof cfg.q === 'string'){
      cfg.q = cfg.q.trim() ? [cfg.q.trim()] : [];
    } else if (!Array.isArray(cfg.q)){
      cfg.q = [];
    } else {
      cfg.q = cfg.q
        .filter(function(q){ return typeof q === 'string' && q.trim() !== ''; })
        .map(function(q){ return q.trim(); })
        .slice(0, 2);
    }
    return cfg;
  }

  // Lee ?cfg=... de la URL actual y devuelve una config normalizada.
  // Si falta o es inválida, devuelve la config por defecto (nunca lanza).
  function readConfigFromLocation(){
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get('cfg');
      if (!raw) return normalizeConfig(null);
      return normalizeConfig(decodeConfig(raw));
    } catch (e) {
      console.warn('[ARFLOW.config] cfg inválido en la URL, se usan defaults:', e);
      return normalizeConfig(null);
    }
  }

  function readChannelFromLocation(){
    const params = new URLSearchParams(window.location.search);
    return params.get('canal') || '';
  }

  window.ARFLOW.config = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    encodeConfig: encodeConfig,
    decodeConfig: decodeConfig,
    normalizeConfig: normalizeConfig,
    readConfigFromLocation: readConfigFromLocation,
    readChannelFromLocation: readChannelFromLocation
  };
})();
