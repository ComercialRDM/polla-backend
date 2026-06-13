// Planes de bonos disponibles: valor pagado (COP) -> { saldoBono, intentos }
const PLANES = {
    50000: { saldoBono: 70000, intentos: 1 },
    100000: { saldoBono: 130000, intentos: 2 },
    200000: { saldoBono: 250000, intentos: 4 },
};

function obtenerPlan(valor) {
    return PLANES[valor] || null;
}

function valorACentavos(valorPesos) {
    return valorPesos * 100;
}

module.exports = { PLANES, obtenerPlan, valorACentavos };
