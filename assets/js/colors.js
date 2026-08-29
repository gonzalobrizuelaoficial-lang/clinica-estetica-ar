(function(){
  "use strict";
  window.ARFLOW = window.ARFLOW || {};

  function hexToRgb(hex){
    const clean = (hex || '').replace('#', '');
    const full = clean.length === 3 ? clean.split('').map(function(c){ return c + c; }).join('') : clean;
    const num = parseInt(full, 16) || 0;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  // Luminancia relativa (WCAG 2.0) — base para decidir qué texto se lee mejor sobre un fondo.
  function relativeLuminance(hex){
    const rgb = hexToRgb(hex);
    const channels = [rgb.r, rgb.g, rgb.b].map(function(v){
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function contrastRatio(hexA, hexB){
    const lA = relativeLuminance(hexA), lB = relativeLuminance(hexB);
    const lighter = Math.max(lA, lB), darker = Math.min(lA, lB);
    return (lighter + 0.05) / (darker + 0.05);
  }

  // Blanco o negro, el que se lea mejor contra ese fondo.
  function contrastColor(bgHex){
    return relativeLuminance(bgHex) > 0.45 ? '#0A0A0A' : '#FFFFFF';
  }

  // Preferí un color de marca (preferredHex) si se lee bien contra el fondo;
  // si no, caé al blanco/negro de contraste garantizado.
  function pickReadableColor(bgHex, preferredHex){
    if (preferredHex && contrastRatio(bgHex, preferredHex) >= 3) return preferredHex;
    return contrastColor(bgHex);
  }

  function clamp255(v){ return Math.max(0, Math.min(255, Math.round(v))); }

  // Aclara (percent > 0) u oscurece (percent < 0) un color de marca para armar
  // gradientes/glow "glossy" sin depender de un color fijo — así el efecto se
  // adapta al color de cada negocio en vez de quedar hardcodeado a uno solo.
  // percent en [-1, 1]: 0.35 = 35% más cerca del blanco, -0.35 = 35% más cerca del negro.
  function shade(hex, percent){
    const rgb = hexToRgb(hex);
    const target = percent >= 0 ? 255 : 0;
    const p = Math.abs(percent);
    const mix = function(channel){ return clamp255(channel + (target - channel) * p); };
    const r = mix(rgb.r), g = mix(rgb.g), b = mix(rgb.b);
    const toHex = function(v){ return v.toString(16).padStart(2, '0'); };
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }

  // Color de marca con transparencia, para glows/sombras suaves (box-shadow,
  // fondos radiales) sin necesitar color-mix() del CSS (soporte más parejo
  // entre navegadores/WebViews).
  function toRgba(hex, alpha){
    const rgb = hexToRgb(hex);
    return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
  }

  window.ARFLOW.colors = {
    hexToRgb: hexToRgb,
    relativeLuminance: relativeLuminance,
    contrastRatio: contrastRatio,
    contrastColor: contrastColor,
    pickReadableColor: pickReadableColor,
    shade: shade,
    toRgba: toRgba
  };
})();
