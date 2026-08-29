(function(){
  "use strict";
  window.ARFLOW = window.ARFLOW || {};

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // La ruleta de premios (radio WHEEL_R) queda igual que antes para no tocar
  // el ajuste fino del texto por gajo; el viewBox y el centro se agrandan
  // aparte para dejar lugar al aro de "bombitas" decorativo alrededor, sin
  // cambiar el tamaño visual del contenedor (#wheel-wrap) en la página.
  const WHEEL_CX = 175, WHEEL_CY = 175, WHEEL_R = 145;
  const RIM_R = 160;
  const BULB_COUNT = 16;
  const BULB_R = 5;

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

  // Elige el punto de corte que más pareja deja la longitud de las 2 líneas.
  function splitTwoLines(label){
    const words = label.trim().split(/\s+/);
    if (words.length < 2) return null;
    let bestI = 1, bestDiff = Infinity;
    for (let i = 1; i < words.length; i++){
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      const diff = Math.abs(a.length - b.length);
      if (diff < bestDiff){ bestDiff = diff; bestI = i; }
    }
    return [words.slice(0, bestI).join(' '), words.slice(bestI).join(' ')];
  }

  // Intenta 1 línea, después parte en 2 (tspans) antes de resignarse a
  // achicar al mínimo y truncar con "…" — antes solo achicaba/truncaba, lo
  // que dejaba premios largos amontonados e ilegibles en gajos angostos.
  // Requiere que `textEl` ya esté en el DOM (getComputedTextLength necesita layout real).
  function fitSectorText(textEl, label, maxWidth, maxFont, minFont){
    function measureSingle(str, fontSize){
      textEl.textContent = str;
      textEl.setAttribute('font-size', fontSize);
      return textEl.getComputedTextLength();
    }

    const singleLineFloor = Math.max(minFont, maxFont * 0.72);
    let fontSize = maxFont;
    let width = measureSingle(label, fontSize);
    let guard = 0;
    while (width > maxWidth && fontSize > singleLineFloor && guard < 6){
      fontSize = Math.max(singleLineFloor, fontSize * (maxWidth / width) * 0.95);
      width = measureSingle(label, fontSize);
      guard++;
    }
    if (width <= maxWidth) return; // entra en 1 línea, textContent ya quedó seteado

    const lines = splitTwoLines(label);
    if (lines){
      let lineFont = Math.max(minFont, maxFont * 0.8);
      let w1 = measureSingle(lines[0], lineFont);
      let w2 = measureSingle(lines[1], lineFont);
      guard = 0;
      while ((w1 > maxWidth || w2 > maxWidth) && lineFont > minFont && guard < 6){
        const ratio = maxWidth / Math.max(w1, w2);
        lineFont = Math.max(minFont, lineFont * ratio * 0.95);
        w1 = measureSingle(lines[0], lineFont);
        w2 = measureSingle(lines[1], lineFont);
        guard++;
      }
      if (w1 <= maxWidth && w2 <= maxWidth){
        const x = textEl.getAttribute('x');
        textEl.textContent = '';
        textEl.setAttribute('font-size', lineFont);
        const tspan1 = document.createElementNS(SVG_NS, 'tspan');
        tspan1.setAttribute('x', x);
        tspan1.setAttribute('dy', '-0.5em');
        tspan1.textContent = lines[0];
        const tspan2 = document.createElementNS(SVG_NS, 'tspan');
        tspan2.setAttribute('x', x);
        tspan2.setAttribute('dy', '1.1em');
        tspan2.textContent = lines[1];
        textEl.appendChild(tspan1);
        textEl.appendChild(tspan2);
        return;
      }
    }

    // último recurso: 1 línea truncada con "…" al piso mínimo
    fontSize = minFont;
    let truncated = label;
    let safety = 0;
    while (truncated.length > 2 && measureSingle(truncated.trim() + '…', fontSize) > maxWidth && safety < 40){
      truncated = truncated.slice(0, -1);
      safety++;
    }
  }

  function addGradientStop(gradient, offset, color, opacity){
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', color);
    if (opacity !== undefined) stop.setAttribute('stop-opacity', opacity);
    gradient.appendChild(stop);
  }

  // Gradiente radial con brillo hacia arriba-izquierda (look "domo" glossy)
  // en vez del relleno plano de antes.
  function buildSectorGradient(defs, id, baseColor){
    const shade = window.ARFLOW.colors.shade;
    const grad = document.createElementNS(SVG_NS, 'radialGradient');
    grad.setAttribute('id', id);
    grad.setAttribute('cx', '35%');
    grad.setAttribute('cy', '28%');
    grad.setAttribute('r', '75%');
    addGradientStop(grad, '0%', shade(baseColor, 0.45));
    addGradientStop(grad, '55%', baseColor);
    addGradientStop(grad, '100%', shade(baseColor, -0.25));
    defs.appendChild(grad);
  }

  // Sheen metálico diagonal para el aro/bezel que rodea la ruleta.
  function buildRimGradient(defs, id, accentColor){
    const shade = window.ARFLOW.colors.shade;
    const grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', id);
    grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%');
    grad.setAttribute('x2', '100%'); grad.setAttribute('y2', '100%');
    addGradientStop(grad, '0%', shade(accentColor, 0.55));
    addGradientStop(grad, '50%', shade(accentColor, -0.15));
    addGradientStop(grad, '100%', shade(accentColor, 0.55));
    defs.appendChild(grad);
  }

  function buildBulbGlowFilter(defs, id){
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('x', '-100%'); filter.setAttribute('y', '-100%');
    filter.setAttribute('width', '300%'); filter.setAttribute('height', '300%');
    const blur = document.createElementNS(SVG_NS, 'feGaussianBlur');
    blur.setAttribute('stdDeviation', '1.4');
    blur.setAttribute('result', 'blur');
    const merge = document.createElementNS(SVG_NS, 'feMerge');
    const node1 = document.createElementNS(SVG_NS, 'feMergeNode');
    node1.setAttribute('in', 'blur');
    const node2 = document.createElementNS(SVG_NS, 'feMergeNode');
    node2.setAttribute('in', 'SourceGraphic');
    merge.appendChild(node1);
    merge.appendChild(node2);
    filter.appendChild(blur);
    filter.appendChild(merge);
    defs.appendChild(filter);
  }

  // Aro decorativo con bombitas parpadeantes (chasing lights), estilo ruleta
  // de feria/carnaval — puramente visual, no afecta la mecánica del juego.
  function buildLightRim(svg, defs, config){
    const rimGradId = 'wheelRimGrad';
    buildRimGradient(defs, rimGradId, config.colors.a);
    const bulbGlowId = 'wheelBulbGlow';
    buildBulbGlowFilter(defs, bulbGlowId);

    const rim = document.createElementNS(SVG_NS, 'circle');
    rim.setAttribute('cx', WHEEL_CX);
    rim.setAttribute('cy', WHEEL_CY);
    rim.setAttribute('r', RIM_R);
    rim.setAttribute('fill', 'none');
    rim.setAttribute('stroke', 'url(#' + rimGradId + ')');
    rim.setAttribute('stroke-width', '10');
    rim.setAttribute('class', 'wheel-decor');
    svg.appendChild(rim);

    const bulbColor = window.ARFLOW.colors.shade(config.colors.a, 0.65);
    const bulbsGroup = document.createElementNS(SVG_NS, 'g');
    bulbsGroup.setAttribute('class', 'wheel-decor');
    bulbsGroup.setAttribute('filter', 'url(#' + bulbGlowId + ')');
    const cycle = 1.6; // segundos, debe matchear @keyframes bulb-twinkle en el CSS
    for (let i = 0; i < BULB_COUNT; i++){
      const angle = i * (360 / BULB_COUNT);
      const pos = polarToCartesian(WHEEL_CX, WHEEL_CY, RIM_R, angle);
      const bulb = document.createElementNS(SVG_NS, 'circle');
      bulb.setAttribute('cx', pos.x);
      bulb.setAttribute('cy', pos.y);
      bulb.setAttribute('r', BULB_R);
      bulb.setAttribute('fill', bulbColor);
      bulb.setAttribute('class', 'wheel-bulb');
      bulb.style.animationDelay = (i * (cycle / BULB_COUNT)).toFixed(2) + 's';
      bulbsGroup.appendChild(bulb);
    }
    svg.appendChild(bulbsGroup);
  }

  // refs: { wheelGroup: <svg g>, btnGirar: <button> }
  // config: config de campaña normalizada (config.prizes, config.colors)
  // callbacks: { unlockAudio(), playTick(), onComplete(winningPrizeIndex) }
  function mount(refs, config, callbacks){
    const wheelGroup = refs.wheelGroup;
    const svg = wheelGroup.ownerSVGElement || wheelGroup.closest('svg');
    const btnGirar = refs.btnGirar;
    // Sin colors.bg: ese color (casi negro por default) apagaba 1 de cada 3
    // gajos cuando se usaba como relleno. Solo alternamos entre los dos
    // colores de marca vivos.
    const sectorColors = [config.colors.p, config.colors.a];

    // El aro de luces vive en el <svg>, fuera del <g> que gira, para que no
    // rote junto con la ruleta.
    svg.querySelectorAll('.wheel-decor').forEach(function(el){ el.remove(); });
    const decorDefs = document.createElementNS(SVG_NS, 'defs');
    decorDefs.setAttribute('class', 'wheel-decor');
    svg.insertBefore(decorDefs, svg.firstChild);
    buildLightRim(svg, decorDefs, config);

    function buildWheel(){
      const sectorsPerPrize = sectorsPerPrizeFor(config.prizes.length);
      const rawTotalSectors = config.prizes.length * sectorsPerPrize;
      // Con 2 colores alternados, una cantidad impar de gajos SIEMPRE deja un
      // punto donde se tocan 2 del mismo color (un ciclo impar no admite
      // 2-coloreado propio) — se fuerza a par sumando 1 gajo (repite el
      // último premio una vez más; no cambia las probabilidades, que las
      // define pickWeightedIndex por peso, no por cantidad de gajos).
      const totalSectors = rawTotalSectors % 2 === 0 ? rawTotalSectors : rawTotalSectors + 1;
      const anglePerSector = 360 / totalSectors;
      const angleRad = anglePerSector * Math.PI / 180;
      const textRadius = WHEEL_R * 0.62;
      const maxTextWidth = 2 * textRadius * Math.sin(angleRad / 2) * 0.85;
      const baseFontSize = Math.max(7, Math.min(13, anglePerSector * 0.4));

      wheelGroup.innerHTML = '';
      wheelGroup.style.transformOrigin = WHEEL_CX + 'px ' + WHEEL_CY + 'px';
      wheelGroup.style.transform = 'rotate(0deg)';

      const defs = document.createElementNS(SVG_NS, 'defs');
      const gradIds = sectorColors.map(function(color, idx){
        const id = 'wheelSectorGrad' + idx;
        buildSectorGradient(defs, id, color);
        return id;
      });
      wheelGroup.appendChild(defs);

      for (let i = 0; i < totalSectors; i++){
        const startAngle = i * anglePerSector;
        const endAngle = startAngle + anglePerSector;
        const p1 = polarToCartesian(WHEEL_CX, WHEEL_CY, WHEEL_R, startAngle);
        const p2 = polarToCartesian(WHEEL_CX, WHEEL_CY, WHEEL_R, endAngle);
        const largeArc = anglePerSector > 180 ? 1 : 0;
        const colorIdx = i % sectorColors.length;
        const fill = sectorColors[colorIdx];

        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d',
          'M ' + WHEEL_CX + ',' + WHEEL_CY +
          ' L ' + p1.x + ',' + p1.y +
          ' A ' + WHEEL_R + ',' + WHEEL_R + ' 0 ' + largeArc + ' 1 ' + p2.x + ',' + p2.y +
          ' Z');
        path.setAttribute('fill', 'url(#' + gradIds[colorIdx] + ')');
        path.setAttribute('stroke', 'rgba(255,255,255,.4)');
        path.setAttribute('stroke-width', '1.5');
        wheelGroup.appendChild(path);

        const midAngle = startAngle + anglePerSector / 2;
        const textPos = polarToCartesian(WHEEL_CX, WHEEL_CY, WHEEL_R * 0.62, midAngle);
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('x', textPos.x);
        text.setAttribute('y', textPos.y);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'middle');
        text.setAttribute('transform', 'rotate(' + midAngle + ' ' + textPos.x + ' ' + textPos.y + ')');
        text.setAttribute('font-family', 'League Spartan, sans-serif');
        text.setAttribute('font-weight', '800');
        text.setAttribute('fill', window.ARFLOW.colors.contrastColor(fill));
        text.setAttribute('paint-order', 'stroke');
        text.setAttribute('stroke', 'rgba(0,0,0,.35)');
        text.setAttribute('stroke-width', '2.2');
        text.setAttribute('stroke-linejoin', 'round');
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

      // Chispa sutil al arrancar (además del confetti grande al terminar),
      // para que el momento de tocar "GIRAR" también se sienta festivo.
      if (window.confetti){
        window.confetti({
          particleCount: 16, spread: 45, startVelocity: 20, gravity: 0.7,
          scalar: 0.55, origin: { y: 0.44 },
          colors: [config.colors.p, config.colors.a, '#FFFFFF']
        });
      }

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
