(function(){
  "use strict";
  window.ARFLOW = window.ARFLOW || {};

  const WHEEL_CX = 150, WHEEL_CY = 150, WHEEL_R = 145;

  // Más premios → menos repeticiones de cada uno, para no triplicar la
  // densidad angular (y volver el texto ilegible) cuando hay muchos premios.
  function sectorsPerPrizeFor(prizeCount){
    if (prizeCount <= 3) return 3;
    if (prizeCount <= 5) return 2;
    return 1;
  }

  function polarToCartesian(cx, cy, r, angleDeg){
    const rad = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  // Achica el font-size (hasta minFont) para que el texto entre en maxWidth;
  // si ni así entra, trunca con "…". Requiere que `text` ya esté en el DOM
  // (getComputedTextLength necesita layout real).
  function fitSectorText(text, label, maxWidth, maxFont, minFont){
    text.textContent = label;
    let fontSize = maxFont;
    text.setAttribute('font-size', fontSize);
    let width = text.getComputedTextLength();
    let guard = 0;
    while (width > maxWidth && fontSize > minFont && guard < 6){
      fontSize = Math.max(minFont, fontSize * (maxWidth / width) * 0.95);
      text.setAttribute('font-size', fontSize);
      width = text.getComputedTextLength();
      guard++;
    }
    if (width > maxWidth){
      let truncated = label;
      let safety = 0;
      while (truncated.length > 2 && text.getComputedTextLength() > maxWidth && safety < 40){
        truncated = truncated.slice(0, -1);
        text.textContent = truncated.trim() + '…';
        safety++;
      }
    }
  }

  // refs: { wheelGroup: <svg g>, btnGirar: <button> }
  // config: config de campaña normalizada (config.prizes, config.colors)
  // callbacks: { unlockAudio(), playTick(), onComplete(winningPrizeIndex) }
  function mount(refs, config, callbacks){
    const wheelGroup = refs.wheelGroup;
    const btnGirar = refs.btnGirar;
    // Sin colors.bg: ese color (casi negro por default) apagaba 1 de cada 3
    // gajos cuando se usaba como relleno. Solo alternamos entre los dos
    // colores de marca vivos.
    const sectorColors = [config.colors.p, config.colors.a];

    function buildWheel(){
      const sectorsPerPrize = sectorsPerPrizeFor(config.prizes.length);
      const totalSectors = config.prizes.length * sectorsPerPrize;
      const anglePerSector = 360 / totalSectors;
      const angleRad = anglePerSector * Math.PI / 180;
      const textRadius = WHEEL_R * 0.62;
      const maxTextWidth = 2 * textRadius * Math.sin(angleRad / 2) * 0.85;
      const baseFontSize = Math.max(7, Math.min(13, anglePerSector * 0.4));

      wheelGroup.innerHTML = '';
      wheelGroup.style.transformOrigin = WHEEL_CX + 'px ' + WHEEL_CY + 'px';
      wheelGroup.style.transform = 'rotate(0deg)';

      for (let i = 0; i < totalSectors; i++){
        const startAngle = i * anglePerSector;
        const endAngle = startAngle + anglePerSector;
        const p1 = polarToCartesian(WHEEL_CX, WHEEL_CY, WHEEL_R, startAngle);
        const p2 = polarToCartesian(WHEEL_CX, WHEEL_CY, WHEEL_R, endAngle);
        const largeArc = anglePerSector > 180 ? 1 : 0;
        const fill = sectorColors[i % sectorColors.length];

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d',
          'M ' + WHEEL_CX + ',' + WHEEL_CY +
          ' L ' + p1.x + ',' + p1.y +
          ' A ' + WHEEL_R + ',' + WHEEL_R + ' 0 ' + largeArc + ' 1 ' + p2.x + ',' + p2.y +
          ' Z');
        path.setAttribute('fill', fill);
        path.setAttribute('stroke', '#000');
        path.setAttribute('stroke-width', '1.5');
        wheelGroup.appendChild(path);

        const midAngle = startAngle + anglePerSector / 2;
        const textPos = polarToCartesian(WHEEL_CX, WHEEL_CY, WHEEL_R * 0.62, midAngle);
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', textPos.x);
        text.setAttribute('y', textPos.y);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'middle');
        text.setAttribute('transform', 'rotate(' + midAngle + ' ' + textPos.x + ' ' + textPos.y + ')');
        text.setAttribute('font-family', 'League Spartan, sans-serif');
        text.setAttribute('font-weight', '800');
        text.setAttribute('fill', window.ARFLOW.colors.contrastColor(fill));
        wheelGroup.appendChild(text);

        fitSectorText(text, config.prizes[i % config.prizes.length].l, maxTextWidth, baseFontSize, 7);
      }

      return { totalSectors: totalSectors, anglePerSector: anglePerSector };
    }

    const wheelLayout = buildWheel();
    let spinning = false;

    btnGirar.addEventListener('click', async function(){
      if (spinning) return;
      spinning = true;
      btnGirar.disabled = true;

      // Re-asegura el desbloqueo del AudioContext en este gesto: si el
      // navegador lo suspendió entre fases, los tonos se quedarían mudos
      // sin este resume() explícito en el mismo click.
      await callbacks.unlockAudio();

      const winningPrizeIndex = window.ARFLOW.pickWeightedIndex(config.prizes);

      const candidateSectors = [];
      for (let i = 0; i < wheelLayout.totalSectors; i++){
        if (i % config.prizes.length === winningPrizeIndex) candidateSectors.push(i);
      }
      const landingSector = candidateSectors[Math.floor(Math.random() * candidateSectors.length)];
      const targetMidAngle = landingSector * wheelLayout.anglePerSector + wheelLayout.anglePerSector / 2;

      const extraSpins = 5 + Math.floor(Math.random() * 3); // 5, 6 o 7 vueltas
      const finalRotation = extraSpins * 360 + (360 - targetMidAngle);
      const duration = (4 + Math.random() * 2).toFixed(2); // 4.00–6.00s

      wheelGroup.style.transitionDuration = duration + 's';
      wheelGroup.style.transitionTimingFunction = 'cubic-bezier(0.17, 0.67, 0.12, 0.99)';

      requestAnimationFrame(function(){
        requestAnimationFrame(function(){
          wheelGroup.style.transform = 'rotate(' + finalRotation + 'deg)';
        });
      });

      let done = false;

      // Ticks de audio sincronizados con el ángulo real renderizado por el navegador.
      let lastSectorIndex = null;
      function trackSpinAudio(){
        const style = getComputedStyle(wheelGroup).transform;
        if (style && style !== 'none'){
          const matrix = style.match(/matrix\(([^)]+)\)/);
          if (matrix){
            const parts = matrix[1].split(',').map(parseFloat);
            let angle = Math.atan2(parts[1], parts[0]) * 180 / Math.PI;
            if (angle < 0) angle += 360;
            const sectorIndex = Math.floor(angle / wheelLayout.anglePerSector);
            if (sectorIndex !== lastSectorIndex){
              lastSectorIndex = sectorIndex;
              callbacks.playTick();
            }
          }
        }
        if (!done) requestAnimationFrame(trackSpinAudio);
      }
      requestAnimationFrame(trackSpinAudio);

      function finish(){
        if (done) return;
        done = true;
        callbacks.onComplete(winningPrizeIndex);
      }
      wheelGroup.addEventListener('transitionend', function handler(ev){
        if (ev.propertyName !== 'transform') return;
        wheelGroup.removeEventListener('transitionend', handler);
        finish();
      });
      setTimeout(finish, parseFloat(duration) * 1000 + 300);
    });
  }

  window.ARFLOW.wheel = { mount: mount };
})();
