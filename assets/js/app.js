(function(){
  "use strict";

  const config = window.ARFLOW.config.readConfigFromLocation();

  // Identifica la sesión de este visitante en los 3 envíos a Make, para que
  // el escenario pueda buscar/actualizar la misma fila del Sheet aunque el
  // primer envío todavía no tenga whatsapp (buscar por whatsapp fallaba ahí).
  function generateSessionId(){
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'sid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  const state = {
    canal: window.ARFLOW.config.readChannelFromLocation(),
    sessionId: generateSessionId(),
    nombre: '',
    whatsapp: '',
    answeredPairs: [],
    preguntaCampo: '',
    respuestaCampo: '',
    winningPrizeIndex: 0
  };

  // ---- Audio: ticks de giro + jingle de victoria (Web Audio API, sin archivos externos) ----
  let audioCtx = null;
  let audioBufferUnlocked = false;
  function getAudioCtx(){
    if (!window.AudioContext && !window.webkitAudioContext) return null;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }
  // Los navegadores móviles crean el AudioContext en estado 'suspended' hasta que
  // un gesto real del usuario lo desbloquea; hay que esperar el resume() (no solo
  // dispararlo) para garantizar que los tonos programados justo después sí suenen.
  // En Safari/iOS el resume() a veces reporta 'running' sin despertar realmente
  // el hardware de audio: el desbloqueo real llega recién cuando se dispara un
  // sonido de verdad en ese mismo gesto (equivalente, en Web Audio API, al viejo
  // truco de play()+pause()+currentTime=0 con <audio>). Por eso reforzamos con
  // un buffer silencioso de 1 sample, una sola vez.
  async function unlockAudio(){
    const ctx = getAudioCtx();
    if (!ctx) return ctx;
    if (ctx.state === 'suspended'){
      try { await ctx.resume(); } catch (e) {}
    }
    if (!audioBufferUnlocked){
      try {
        const silentBuffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = silentBuffer;
        source.connect(ctx.destination);
        source.start(0);
        audioBufferUnlocked = true;
      } catch (e) {}
      // Arranca el <audio> silencioso en loop: pone la sesión de audio de iOS en
      // categoría "playback", que suena aunque el switch físico esté en silencio.
      const silentTag = document.getElementById('silent-unlock');
      if (silentTag){
        silentTag.play().catch(function(){});
      }
    }
    return ctx;
  }
  function playTone(freq, startOffset, duration, type, peakGain){
    const ctx = getAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t0 = ctx.currentTime + startOffset;
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peakGain || 0.18, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }
  function playTick(){
    playTone(1200, 0, 0.06, 'square', 0.15);
  }
  function playWinJingle(){
    [523, 659, 784, 1047].forEach(function(freq, i){
      playTone(freq, i * 0.12, 0.22, 'triangle', 0.2);
    });
  }

  // ---- Referencias DOM ----
  const cameraBg        = document.getElementById('camera-bg');
  const fallbackBg      = document.getElementById('fallback-bg');
  const phaseClaimForm   = document.getElementById('phase-claim-form');
  const phaseModal       = document.getElementById('phase-modal');
  const logoImg          = document.getElementById('logo-img');
  const logoFallback     = document.getElementById('logo-fallback');
  const bizTitle         = document.getElementById('biz-title');
  const gameWheelContainer   = document.getElementById('game-wheel-container');
  const gameScratchContainer = document.getElementById('game-scratch-container');
  const wheelGroup        = document.getElementById('wheel-group');
  const btnGirar           = document.getElementById('btn-girar');
  const scratchCanvas      = document.getElementById('scratch-canvas');
  const scratchPrizeLabel  = document.getElementById('scratch-prize-label');
  const btnReveal          = document.getElementById('btn-reveal');
  const claimForm          = document.getElementById('claim-form');
  const claimNombre        = document.getElementById('claim-nombre');
  const claimPreguntasContainer = document.getElementById('claim-preguntas-container');
  const claimWhatsapp      = document.getElementById('claim-whatsapp');
  const btnClaimSubmit     = document.getElementById('btn-claim-submit');
  const premioGanadoTexto  = document.getElementById('premio-ganado-texto');
  const premioTexto        = document.getElementById('premio-texto');
  const btnReclamar        = document.getElementById('btn-reclamar');
  const phaseDuplicate     = document.getElementById('phase-duplicate');

  // ---- Aplicar config de campaña a la UI ----
  document.title = config.biz + ' — Ruleta de Premios';
  bizTitle.textContent = '¡Jugá y Ganá en ' + config.biz + '!';
  document.documentElement.style.setProperty('--bg', config.colors.bg);
  document.documentElement.style.setProperty('--cyan', config.colors.p);
  document.documentElement.style.setProperty('--amber', config.colors.a);

  // Hasta 2 preguntas opcionales (config.q, 0 a 2 elementos) — se renderiza
  // un campo por cada una, ninguno obligatorio.
  function renderPreguntasFields(){
    config.q.forEach(function(q, idx){
      const field = document.createElement('div');
      field.className = 'field';

      const label = document.createElement('label');
      label.setAttribute('for', 'claim-pregunta-' + idx);
      label.textContent = q;

      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'claim-pregunta-' + idx;
      input.dataset.index = String(idx);
      input.dataset.pregunta = q;

      field.appendChild(label);
      field.appendChild(input);
      claimPreguntasContainer.appendChild(field);
    });
  }
  renderPreguntasFields();

  // Junta las preguntas que el visitante efectivamente respondió (deja en
  // blanco las que no contestó, no son obligatorias), conservando el número
  // de pregunta original (P1/P2) según el orden configurado, no el orden
  // de respuesta.
  function collectAnsweredPairs(){
    const inputs = claimPreguntasContainer.querySelectorAll('input[data-pregunta]');
    const pairs = [];
    inputs.forEach(function(input){
      const respuesta = input.value.trim();
      if (respuesta) pairs.push({ index: parseInt(input.dataset.index, 10), pregunta: input.dataset.pregunta, respuesta: respuesta });
    });
    return pairs;
  }

  function buildPreguntaRespuestaPayload(pairs){
    return {
      pregunta: pairs.map(function(p){ return 'P' + (p.index + 1) + ': ' + p.pregunta; }).join(' | '),
      respuesta: pairs.map(function(p){ return 'R' + (p.index + 1) + ': ' + p.respuesta; }).join(' | ')
    };
  }

  logoImg.addEventListener('error', function(){
    logoImg.style.display = 'none';
    logoFallback.style.display = 'block';
  });
  logoImg.src = config.logo;

  // ---- Fase 1: cámara de fondo ----
  function initCamera(){
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      showFallbackBg();
      return;
    }
    // getUserMedia requiere contexto seguro (https o localhost); en file://
    // o http:// plano el navegador rechaza la promesa por política de seguridad.
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function(stream){
        cameraBg.srcObject = stream;
        const p = cameraBg.play();
        if (p && p.catch) p.catch(function(){});
      })
      .catch(function(err){
        console.warn('[Camara] No se pudo acceder:', err && err.name);
        showFallbackBg();
      });
  }

  function showFallbackBg(){
    cameraBg.style.display = 'none';
    fallbackBg.style.display = 'block';
  }

  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState !== 'visible') return;
    if (cameraBg.srcObject && cameraBg.paused){
      const p = cameraBg.play();
      if (p && p.catch) p.catch(function(){});
    }
  });

  // ---- State machine de fases ----
  function goToPhase(nextEl){
    const current = document.querySelector('.phase:not(.phase-hidden)');
    if (current === nextEl) return;

    if (current){
      current.classList.add('fade-out');
      setTimeout(function(){
        current.classList.add('phase-hidden');
        current.classList.remove('fade-out');
      }, 350);
    }

    nextEl.classList.remove('phase-hidden');
    nextEl.style.opacity = '0';
    requestAnimationFrame(function(){
      requestAnimationFrame(function(){
        nextEl.style.opacity = '1';
      });
    });
  }

  // ---- Resultado visual ----
  function fireConfetti(){
    if (!window.confetti) return;
    window.confetti({ particleCount: 150, spread: 90, origin: { y: 0.5 }, colors: [config.colors.p, config.colors.a, '#FFFFFF'] });
    setTimeout(function(){
      window.confetti({ particleCount: 100, spread: 120, origin: { y: 0.4 }, colors: [config.colors.p, config.colors.a, '#FFFFFF'] });
    }, 300);
  }

  // ---- Juego (ruleta o raspadita, según config.game) → captura preventiva ----
  function onGameComplete(prizeIndex){
    state.winningPrizeIndex = prizeIndex;
    const premio = config.prizes[prizeIndex].l;
    premioGanadoTexto.textContent = 'Ganaste: ' + premio;

    goToPhase(phaseClaimForm);
    fireConfetti();
    playWinJingle();

    // Candado 1: captura preventiva — el premio ya se sabe, nombre/whatsapp todavía no.
    window.ARFLOW.crm.postToCRM(config.hook, {
      fecha: window.ARFLOW.crm.nowDDMMYYYYHHmm(),
      canal: state.canal,
      nombre: '',
      whatsapp: '',
      premio: premio,
      pregunta: config.q.map(function(q, i){ return 'P' + (i + 1) + ': ' + q; }).join(' | '),
      respuesta: '',
      session_id: state.sessionId,
      observaciones: 'Jugó - Pendiente de datos'
    });
    window.ARFLOW.crm.pingStats(config.cid, 'jugado');
  }

  function mountGame(){
    if (config.game === 'scratch'){
      gameWheelContainer.style.display = 'none';
      gameScratchContainer.style.display = '';
      window.ARFLOW.scratch.mount(
        { canvas: scratchCanvas, prizeLabel: scratchPrizeLabel, btnReveal: btnReveal },
        config,
        { unlockAudio: unlockAudio, onComplete: onGameComplete }
      );
    } else {
      gameScratchContainer.style.display = 'none';
      gameWheelContainer.style.display = '';
      window.ARFLOW.wheel.mount(
        { wheelGroup: wheelGroup, btnGirar: btnGirar },
        config,
        { unlockAudio: unlockAudio, playTick: playTick, onComplete: onGameComplete }
      );
    }
  }

  // ---- Fase 2: formulario final (nombre + pregunta clave + whatsapp) ----
  claimForm.addEventListener('submit', function(e){
    e.preventDefault();

    btnClaimSubmit.disabled = true;
    btnClaimSubmit.textContent = 'Enviando...';

    // Desbloquea el AudioContext en este gesto también, por si el navegador
    // lo suspendió entre el fin del juego y este submit.
    unlockAudio();

    state.nombre = claimNombre.value.trim();
    state.answeredPairs = collectAnsweredPairs();
    state.whatsapp = window.ARFLOW.crm.formatWhatsapp(claimWhatsapp.value.trim());

    const pr = buildPreguntaRespuestaPayload(state.answeredPairs);
    state.preguntaCampo = pr.pregunta;
    state.respuestaCampo = pr.respuesta;

    premioTexto.textContent = 'Ganaste: ' + config.prizes[state.winningPrizeIndex].l;

    // Anti-duplicados: un WhatsApp no puede reclamar dos veces en la misma
    // campaña dentro de la ventana de días configurada (cfg.cd). Se escopea
    // por campaña (cfg.cid); si el link es viejo y no trae cid, se escopea
    // por negocio (cfg.hook) para no quedar sin protección.
    fetch('/api/check-play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scopeKey: config.cid || config.hook,
        whatsapp: state.whatsapp,
        cooldownDays: config.cd
      })
    })
      .then(function(r){ return r.json(); })
      .catch(function(){ return { duplicate: false }; }) // fail-open: no bloquear por un error de red
      .then(function(data){
        if (data && data.duplicate){
          window.ARFLOW.crm.postToCRM(config.hook, {
            fecha: window.ARFLOW.crm.nowDDMMYYYYHHmm(),
            canal: state.canal,
            nombre: state.nombre,
            whatsapp: state.whatsapp,
            premio: config.prizes[state.winningPrizeIndex].l,
            pregunta: state.preguntaCampo,
            respuesta: state.respuestaCampo,
            session_id: state.sessionId,
            observaciones: 'Intento Duplicado Bloqueado'
          });
          goToPhase(phaseDuplicate);
          return;
        }

        // Candado 2: ahora sí van nombre/whatsapp/respuesta completos.
        window.ARFLOW.crm.postToCRM(config.hook, {
          fecha: window.ARFLOW.crm.nowDDMMYYYYHHmm(),
          canal: state.canal,
          nombre: state.nombre,
          whatsapp: state.whatsapp,
          premio: config.prizes[state.winningPrizeIndex].l,
          pregunta: state.preguntaCampo,
          respuesta: state.respuestaCampo,
          session_id: state.sessionId,
          observaciones: 'Premio Ganado'
        });
        window.ARFLOW.crm.pingStats(config.cid, 'ganado');

        goToPhase(phaseModal);
      });
  });

  // ---- Fase 3: reclamo por WhatsApp ----
  btnReclamar.addEventListener('click', function(){
    const premio = config.prizes[state.winningPrizeIndex].l;

    window.ARFLOW.crm.postToCRM(config.hook, {
      fecha: window.ARFLOW.crm.nowDDMMYYYYHHmm(),
      canal: state.canal,
      nombre: state.nombre,
      whatsapp: state.whatsapp,
      premio: premio,
      pregunta: state.preguntaCampo,
      respuesta: state.respuestaCampo,
      session_id: state.sessionId,
      observaciones: 'Premio Reclamado'
    });
    window.ARFLOW.crm.pingStats(config.cid, 'reclamado');

    // Mensaje prolijo y personalizado: un bloque 💬/➡️ por cada pregunta que
    // el visitante efectivamente respondió (las que dejó en blanco no
    // aparecen), en vez de la respuesta pegada entre paréntesis.
    let msg = '¡Hola! 👋 Soy ' + state.nombre + ', jugué en ' + config.biz + ' y gané *' + premio + '* 🎉';
    state.answeredPairs.forEach(function(p){
      msg += '\n\n💬 ' + p.pregunta + '\n➡️ ' + p.respuesta;
    });
    msg += '\n\nQuiero validar mi premio, ¿me ayudás? 😊';

    const url = 'https://wa.me/' + config.wa + '?text=' + encodeURIComponent(msg);
    window.open(url, '_blank');
  });

  // ---- Bootstrap ----
  initCamera();
  mountGame();

})();
