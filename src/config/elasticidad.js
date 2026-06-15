// Modelo de elasticidad precio-demanda para el simulador de ingresos del
// panel admin. Es un modelo simplificado/ajustable: a mayor precio del bono,
// menor tasa de conversión estimada de los clics de ManyChat, pero mayor
// margen por transacción.

// Meta de ingresos y fecha límite del objetivo del Mundial
const META_INGRESOS = 50000000; // $50.000.000 COP
const FECHA_META = '2026-07-19';

// Precio de referencia (plan más vendido hoy) y su tasa de conversión observada
const PRECIO_REFERENCIA = 50000;
const TASA_CONVERSION_REFERENCIA = 0.08; // 8% de los clics de ManyChat se convierten en compra

// Exponente de elasticidad: >1 = la conversión cae más que proporcionalmente al subir el precio
const ELASTICIDAD = 1.2;

// Rango y paso del slider del simulador (múltiplos estrictos de $5.000, desde $10.000)
const PRECIO_SIMULADOR_MIN = 10000;
const PRECIO_SIMULADOR_MAX = 200000;
const PRECIO_SIMULADOR_PASO = 5000;

// Tasa de conversión estimada para un precio dado, según el modelo de elasticidad
function tasaConversion(precio) {
    if (!precio || precio <= 0) return 0;
    const tasa = TASA_CONVERSION_REFERENCIA * Math.pow(PRECIO_REFERENCIA / precio, ELASTICIDAD);
    return Math.min(Math.max(tasa, 0), 1);
}

// Días restantes (>= 0) entre hoy y la fecha meta
function diasRestantesHasta(fechaMeta = FECHA_META) {
    const ahora = new Date();
    const meta = new Date(`${fechaMeta}T23:59:59`);
    const ms = meta.getTime() - ahora.getTime();
    return Math.max(Math.ceil(ms / (24 * 60 * 60 * 1000)), 0);
}

// Proyección de ingresos al ritmo actual de clics de ManyChat, para un precio dado
function calcularProyeccion({ precio, clicsDiariosPromedio, ingresosActuales, diasRestantes }) {
    const tasa = tasaConversion(precio);
    const conversionesDiarias = clicsDiariosPromedio * tasa;
    const ingresoDiarioEstimado = conversionesDiarias * precio;
    const ingresoAdicionalProyectado = ingresoDiarioEstimado * diasRestantes;
    const ingresoProyectadoTotal = ingresosActuales + ingresoAdicionalProyectado;
    const faltante = Math.max(META_INGRESOS - ingresoProyectadoTotal, 0);

    return {
        tasaConversion: tasa,
        conversionesDiarias,
        ingresoDiarioEstimado,
        ingresoProyectadoTotal,
        cumpleMeta: ingresoProyectadoTotal >= META_INGRESOS,
        faltante,
    };
}

module.exports = {
    META_INGRESOS,
    FECHA_META,
    PRECIO_REFERENCIA,
    TASA_CONVERSION_REFERENCIA,
    ELASTICIDAD,
    PRECIO_SIMULADOR_MIN,
    PRECIO_SIMULADOR_MAX,
    PRECIO_SIMULADOR_PASO,
    tasaConversion,
    diasRestantesHasta,
    calcularProyeccion,
};
