const axios = require('axios');

const CLIENTES_URL = process.env.SHEETS_CLIENTES_URL;
const INFLUENCERS_URL = process.env.SHEETS_INFLUENCERS_URL;
const SECRET = process.env.SHEETS_SECRET;

async function _post(url, data) {
    await axios.post(
        url,
        { ...data, token: SECRET },
        { timeout: 8000, headers: { 'Content-Type': 'application/json' } }
    );
}

/**
 * Registra una compra aprobada en el Sheet de clientes.
 * Solo se llama para transacciones reales (no es_test, no es_especial).
 */
async function registrarBonoEnSheets({ transaccion, usuario, influencerNombre }) {
    if (!CLIENTES_URL || !SECRET) return;
    try {
        await _post(CLIENTES_URL, {
            nombre: usuario.nombre,
            celular: usuario.celular,
            correo: usuario.correo || '',
            valor_pagado: transaccion.valor_pagado,
            saldo_bono: transaccion.saldo_bono,
            cupos: transaccion.intentos_totales,
            metodo_pago: transaccion.metodo_pago || '',
            referido: transaccion.referido_por_token ? 'Sí' : 'No',
            influencer: influencerNombre || '',
            transaccion_id: transaccion.id,
            token_acceso: transaccion.token_acceso,
        });
    } catch (err) {
        console.error('[Sheets clientes] error:', err.message);
    }
}

/**
 * Registra un Bono Especial (regalado a influencer para marketing) en el Sheet
 * de influencers. Se llama desde especialesService al crear cada bono.
 */
async function registrarBonoEspecialEnSheets({ transaccion, usuario, codigoAfiliado }) {
    if (!INFLUENCERS_URL || !SECRET) return;
    try {
        await _post(INFLUENCERS_URL, {
            nombre: usuario.nombre,
            celular: usuario.celular,
            correo: usuario.correo || '',
            codigo_afiliado: codigoAfiliado || '',
            saldo_bono: transaccion.saldo_bono,
            cupos: transaccion.intentos_totales,
            transaccion_id: transaccion.id,
            token_acceso: transaccion.token_acceso,
        });
    } catch (err) {
        console.error('[Sheets influencers] error:', err.message);
    }
}

module.exports = { registrarBonoEnSheets, registrarBonoEspecialEnSheets };
