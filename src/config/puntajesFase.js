// Puntos por fase: "exacto" = marcador exacto, "tendencia" = acierta quién
// gana/empata sin el marcador exacto. Única fuente de verdad — si se ajustan
// estos valores, también hay que actualizar Terminos.jsx, Anexo.jsx y
// comoFuncionaData.js en polla-frontend (no hay forma de compartir esta
// constante entre los dos repos).
const PUNTAJES_FASE = {
    grupos: { exacto: 100, tendencia: 50 },
    dieciseisavos: { exacto: 200, tendencia: 100 },
    octavos: { exacto: 200, tendencia: 100 },
    cuartos: { exacto: 600, tendencia: 300 },
    semifinal: { exacto: 600, tendencia: 300 },
    final: { exacto: 1000, tendencia: 500 },
};

function puntajeExacto(fase) {
    return PUNTAJES_FASE[fase]?.exacto ?? PUNTAJES_FASE.grupos.exacto;
}

function puntajeTendencia(fase) {
    return PUNTAJES_FASE[fase]?.tendencia ?? PUNTAJES_FASE.grupos.tendencia;
}

module.exports = { PUNTAJES_FASE, puntajeExacto, puntajeTendencia };
