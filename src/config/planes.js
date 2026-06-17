// Planes de bonos disponibles: valor pagado (COP) -> { saldoBono, intentos }
const PLANES = {
    25000:   { saldoBono: 30000,   intentos: 1  },
    50000:   { saldoBono: 70000,   intentos: 2  },
    100000:  { saldoBono: 130000,  intentos: 4  },
    200000:  { saldoBono: 250000,  intentos: 8  },
    500000:  { saldoBono: 650000,  intentos: 20 },
    1000000: { saldoBono: 1500000, intentos: 40 },
};

// 1 cupo de pronóstico = $25.000 de recarga
const CUPO_VALOR = 25000;

// Rango permitido para montos personalizados ("Otro monto")
const MONTO_PERSONALIZADO_MIN = 25000;
const MONTO_PERSONALIZADO_MAX = 2000000;

// Bonificación del bono de servicio para montos personalizados (~30% extra)
const BONIFICACION_PERSONALIZADA = 1.3;

// Devuelve { saldoBono, intentos (cupos) } para cualquier valor recargado.
// Si coincide con uno de los planes fijos, conserva su bonificación propia.
// Para montos libres, exige estar entre MONTO_PERSONALIZADO_MIN y MONTO_PERSONALIZADO_MAX.
function obtenerPlan(valor) {
    if (PLANES[valor]) return PLANES[valor];

    if (
        Number.isInteger(valor) &&
        valor >= MONTO_PERSONALIZADO_MIN &&
        valor <= MONTO_PERSONALIZADO_MAX
    ) {
        return {
            saldoBono: Math.round(valor * BONIFICACION_PERSONALIZADA),
            intentos: Math.floor(valor / CUPO_VALOR),
        };
    }

    return null;
}

function valorACentavos(valorPesos) {
    return valorPesos * 100;
}

module.exports = { PLANES, CUPO_VALOR, MONTO_PERSONALIZADO_MIN, MONTO_PERSONALIZADO_MAX, obtenerPlan, valorACentavos };
