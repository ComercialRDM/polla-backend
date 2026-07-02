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
    final: { exacto: 2000, tendencia: 1000 },
};

function puntajeExacto(fase) {
    return PUNTAJES_FASE[fase]?.exacto ?? PUNTAJES_FASE.grupos.exacto;
}

function puntajeTendencia(fase) {
    return PUNTAJES_FASE[fase]?.tendencia ?? PUNTAJES_FASE.grupos.tendencia;
}

// Genera el fragmento SQL `CASE ... END` para calcular puntos a partir de los
// valores definidos en PUNTAJES_FASE — única fuente de verdad para queries SQL.
// Parámetros: alias de columna fase, condición SQL de exacto, condición de tendencia.
function casePuntajeSQL(faseCol, exactoCond, tendenciaCond) {
    const exactoCases = Object.entries(PUNTAJES_FASE)
        .map(([f, pts]) => `WHEN '${f}' THEN ${pts.exacto}`)
        .join(' ');
    const tendenciaCases = Object.entries(PUNTAJES_FASE)
        .map(([f, pts]) => `WHEN '${f}' THEN ${pts.tendencia}`)
        .join(' ');
    const defE = PUNTAJES_FASE.grupos.exacto;
    const defT = PUNTAJES_FASE.grupos.tendencia;
    return `CASE
                WHEN ${exactoCond}
                    THEN CASE ${faseCol} ${exactoCases} ELSE ${defE} END
                WHEN ${tendenciaCond}
                    THEN CASE ${faseCol} ${tendenciaCases} ELSE ${defT} END
                ELSE 0
            END`;
}

module.exports = { PUNTAJES_FASE, puntajeExacto, puntajeTendencia, casePuntajeSQL };
