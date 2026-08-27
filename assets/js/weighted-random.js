(function(){
  "use strict";
  window.ARFLOW = window.ARFLOW || {};

  // Elige el índice de premio ganador según su peso relativo. Si todos los
  // pesos son 0/inválidos, cae a sorteo uniforme para no romper el juego.
  window.ARFLOW.pickWeightedIndex = function(prizes){
    const total = prizes.reduce(function(sum, p){ return sum + (p.w > 0 ? p.w : 0); }, 0);
    if (total <= 0) return Math.floor(Math.random() * prizes.length);
    let r = Math.random() * total;
    for (let i = 0; i < prizes.length; i++){
      r -= (prizes[i].w > 0 ? prizes[i].w : 0);
      if (r <= 0) return i;
    }
    return prizes.length - 1;
  };
})();
