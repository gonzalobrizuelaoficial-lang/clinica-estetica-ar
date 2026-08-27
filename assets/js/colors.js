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

  window.ARFLOW.colors = {
    hexToRgb: hexToRgb,
    relativeLuminance: relativeLuminance,
    contrastRatio: contrastRatio,
    contrastColor: contrastColor,
    pickReadableColor: pickReadableColor
  };
})();
