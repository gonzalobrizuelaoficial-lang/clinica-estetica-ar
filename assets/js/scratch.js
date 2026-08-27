(function(){
  "use strict";
  window.ARFLOW = window.ARFLOW || {};

  const SCRATCH_THRESHOLD = 0.6;   // % de área raspada para dar por revelado el premio
  const BRUSH_RADIUS = 22;
  const CHECK_THROTTLE_MS = 150;   // no medir progreso en cada pointermove: getImageData es costoso
  const SAMPLE_STRIDE = 20;        // muestrea 1 de cada N píxeles al medir progreso, no todos
  const LABEL_MAX_FONT = 20, LABEL_MIN_FONT = 12;

  // Achica el font-size del label (hasta LABEL_MIN_FONT) para que el premio
  // entre en el ancho disponible, en vez de quedar cortado por el
  // overflow:hidden del contenedor con premios de texto largo.
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  function fitLabelFont(el){
    const maxWidth = el.clientWidth - 32; // descuenta el padding:0 16px del CSS
    if (maxWidth <= 0) return;
    let fontSize = LABEL_MAX_FONT;
    measureCtx.font = '800 ' + fontSize + 'px "League Spartan", sans-serif';
    let width = measureCtx.measureText(el.textContent).width;
    while (width > maxWidth && fontSize > LABEL_MIN_FONT){
      fontSize -= 1;
      measureCtx.font = '800 ' + fontSize + 'px "League Spartan", sans-serif';
      width = measureCtx.measureText(el.textContent).width;
    }
    el.style.fontSize = fontSize + 'px';
  }

  // refs: { canvas: <canvas>, prizeLabel: <div>, btnReveal: <button> opcional }
  // config: config de campaña normalizada (config.prizes, config.colors)
  // callbacks: { unlockAudio(), onComplete(winningPrizeIndex) }
  function mount(refs, config, callbacks){
    const canvas = refs.canvas;
    const prizeLabel = refs.prizeLabel;
    const btnReveal = refs.btnReveal;
    const ctx = canvas.getContext('2d');

    const winningPrizeIndex = window.ARFLOW.pickWeightedIndex(config.prizes);
    prizeLabel.textContent = config.prizes[winningPrizeIndex].l;
    // Antes era siempre var(--cyan) fijo, sin garantía de contraste; ahora
    // preferimos el color de marca principal, pero solo si se lee bien
    // contra el fondo — si no, caemos a blanco/negro de contraste seguro.
    prizeLabel.style.color = window.ARFLOW.colors.pickReadableColor(config.colors.bg, config.colors.p);
    fitLabelFont(prizeLabel);

    function drawCover(){
      const rect = canvas.getBoundingClientRect();
      ctx.globalCompositeOperation = 'source-over';
      const grad = ctx.createLinearGradient(0, 0, rect.width, rect.height);
      grad.addColorStop(0, '#C7CCD1');
      grad.addColorStop(1, '#8B9196');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.font = '700 18px "League Spartan", sans-serif';
      ctx.fillStyle = config.colors.bg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('RASPÁ AQUÍ', rect.width / 2, rect.height / 2);
      // A partir de acá, todo lo que se pinte "borra" en vez de dibujar encima.
      ctx.globalCompositeOperation = 'destination-out';
    }

    function resizeCanvas(){
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawCover();
      fitLabelFont(prizeLabel);
    }

    canvas.style.touchAction = 'none'; // evita scroll/drag del navegador durante el raspado

    let scratching = false;
    let done = false;
    let lastCheck = 0;
    let audioUnlocked = false;

    function pointFromEvent(ev){
      const rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    function erase(x, y){
      ctx.beginPath();
      ctx.arc(x, y, BRUSH_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }

    function checkProgress(now){
      if (now - lastCheck < CHECK_THROTTLE_MS) return;
      lastCheck = now;
      const w = canvas.width, h = canvas.height;
      if (w === 0 || h === 0) return;
      const data = ctx.getImageData(0, 0, w, h).data;
      let transparent = 0;
      let sampled = 0;
      for (let i = 3; i < data.length; i += 4 * SAMPLE_STRIDE){
        sampled++;
        if (data[i] === 0) transparent++;
      }
      const pct = sampled ? transparent / sampled : 0;
      if (pct > SCRATCH_THRESHOLD) finish();
    }

    function finish(){
      if (done) return;
      done = true;
      ctx.clearRect(0, 0, canvas.width, canvas.height); // revela el resto de golpe
      callbacks.onComplete(winningPrizeIndex);
    }

    function ensureAudioUnlocked(){
      if (audioUnlocked) return;
      audioUnlocked = true;
      callbacks.unlockAudio();
    }

    function onPointerDown(ev){
      if (done) return;
      scratching = true;
      ensureAudioUnlocked();
      const p = pointFromEvent(ev);
      erase(p.x, p.y);
    }
    function onPointerMove(ev){
      if (!scratching || done) return;
      const p = pointFromEvent(ev);
      erase(p.x, p.y);
      checkProgress(performance.now());
    }
    function onPointerUp(){ scratching = false; }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    if (btnReveal){
      btnReveal.addEventListener('click', function(){
        ensureAudioUnlocked();
        finish();
      });
    }

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
  }

  window.ARFLOW.scratch = { mount: mount };
})();
