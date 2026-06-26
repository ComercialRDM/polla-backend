const pool = require('../db');
const { firmarTokenAtribucion, verificarTokenAtribucion, hashIp } = require('../utils/referidoTokens');

const PORCENTAJE_COMISION_DEFAULT = 10.00;

const RANGO_DIACRITICOS = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');

function normalizarBase(nombre) {
    return String(nombre || '')
        .normalize('NFD').replace(RANGO_DIACRITICOS, '') // quita tildes
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 14) || 'creador';
}

/**
 * Genera un código de afiliado corto y único a partir del nombre (ej. "Juliana
 * Pérez" → "julianaperez482"). Reintenta con otro sufijo aleatorio si choca
 * con uno existente (muy improbable, pero la tabla tiene UNIQUE de respaldo).
 */
async function generarCodigoAfiliado(nombre) {
    const base = normalizarBase(nombre);
    for (let intento = 0; intento < 10; intento++) {
        const sufijo = Math.floor(100 + Math.random() * 900); // 3 dígitos
        const candidato = `${base}${sufijo}`;
        const { rows } = await pool.query('SELECT 1 FROM influencers WHERE codigo_afiliado = $1', [candidato]);
        if (rows.length === 0) return candidato;
    }
    throw new Error('No se pudo generar un código de afiliado único');
}

/**
 * Garantiza que un usuario (ya creado, ej. al recibir su Bono Especial) tenga
 * una fila en `influencers` con su código de afiliado. Idempotente: si ya
 * existe, la devuelve sin modificarla.
 */
async function obtenerOcrearInfluencer(usuarioId, nombre) {
    const { rows: existentes } = await pool.query('SELECT * FROM influencers WHERE usuario_id = $1', [usuarioId]);
    if (existentes.length > 0) return existentes[0];

    const codigo = await generarCodigoAfiliado(nombre);
    const { rows } = await pool.query(
        'INSERT INTO influencers (usuario_id, codigo_afiliado, porcentaje_comision) VALUES ($1, $2, $3) RETURNING *',
        [usuarioId, codigo, PORCENTAJE_COMISION_DEFAULT]
    );
    return rows[0];
}

/**
 * Registra un clic de atribución y devuelve el token firmado que el frontend
 * debe guardar y reenviar al momento de la compra. Devuelve null si el
 * código de afiliado no existe o está inactivo (no se registra el clic).
 */
async function registrarClic({ codigoAfiliado, ip, userAgent, utmSource, utmMedium, utmCampaign }) {
    const { rows } = await pool.query(
        'SELECT id FROM influencers WHERE codigo_afiliado = $1 AND activo = TRUE',
        [String(codigoAfiliado || '').trim()]
    );
    if (rows.length === 0) return null;

    const influencerId = rows[0].id;
    const { rows: clicRows } = await pool.query(
        `INSERT INTO referido_clics (influencer_id, ip_hash, user_agent, utm_source, utm_medium, utm_campaign)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [influencerId, hashIp(ip), userAgent || null, utmSource || null, utmMedium || null, utmCampaign || null]
    );

    const clicId = clicRows[0].id;
    return { token: firmarTokenAtribucion({ clicId, influencerId }), clicId, influencerId };
}

/**
 * Verifica un token de atribución recibido al momento de la compra y
 * confirma que el clic referenciado exista y siga siendo válido (no
 * marcado como fraude) antes de atribuir la venta. Nunca lanza: devuelve
 * null ante cualquier problema, dejando la compra sin atribuir.
 */
async function resolverAtribucion(token) {
    const payload = verificarTokenAtribucion(token);
    if (!payload) return null;

    const { rows } = await pool.query(
        `SELECT c.id AS clic_id, c.influencer_id
         FROM referido_clics c
         JOIN influencers i ON i.id = c.influencer_id
         WHERE c.id = $1 AND c.influencer_id = $2 AND c.valido = TRUE AND i.activo = TRUE`,
        [payload.clicId, payload.influencerId]
    );
    if (rows.length === 0) return null;

    return { clicId: rows[0].clic_id, influencerId: rows[0].influencer_id };
}

module.exports = { generarCodigoAfiliado, obtenerOcrearInfluencer, registrarClic, resolverAtribucion };
