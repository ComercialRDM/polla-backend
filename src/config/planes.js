// Planes de bonos disponibles: valor pagado (COP) -> { saldoBono, intentos }
const PLANES = {
    10000: { saldoBono: 15000, intentos: 1 },
    25000: { saldoBono: 40000, intentos: 2 },
    50000: { saldoBono: 80000, intentos: 5 },
};

// Usado solo para el monedero (dinero disponible informativo, ver walletService.js).
// Los cupos reales que otorga cada compra se guardan en intentos_totales al crear
// la transacción, no se recalculan dividiendo valor_pagado entre esta constante.
const CUPO_VALOR = 25000;

// Para montos personalizados ("Otro monto"): 1 intento por cada $10.000, igual
// proporción que el plan más económico ($10.000 = 1 intento).
const CUPO_VALOR_PERSONALIZADO = 10000;

// Rango permitido para montos personalizados ("Otro monto"). Deben ser
// múltiplos exactos de $1.000.
const MONTO_PERSONALIZADO_MIN = 50000;
const MONTO_PERSONALIZADO_MAX = 1000000;
const MULTIPLO_PERSONALIZADO = 1000;

// Bonificación del bono de servicio para montos personalizados (60% extra)
const BONIFICACION_PERSONALIZADA = 1.6;

// Devuelve { saldoBono, intentos (cupos) } para cualquier valor recargado.
// Si coincide con uno de los planes fijos, conserva su bonificación propia.
// Para montos libres, exige ser múltiplo de $1.000 y estar entre
// MONTO_PERSONALIZADO_MIN y MONTO_PERSONALIZADO_MAX.
function obtenerPlan(valor) {
    if (PLANES[valor]) return PLANES[valor];

    if (
        Number.isInteger(valor) &&
        valor % MULTIPLO_PERSONALIZADO === 0 &&
        valor >= MONTO_PERSONALIZADO_MIN &&
        valor <= MONTO_PERSONALIZADO_MAX
    ) {
        return {
            saldoBono: Math.round(valor * BONIFICACION_PERSONALIZADA),
            intentos: Math.floor(valor / CUPO_VALOR_PERSONALIZADO),
        };
    }

    return null;
}

function valorACentavos(valorPesos) {
    return valorPesos * 100;
}

module.exports = { PLANES, CUPO_VALOR, MONTO_PERSONALIZADO_MIN, MONTO_PERSONALIZADO_MAX, obtenerPlan, valorACentavos };
