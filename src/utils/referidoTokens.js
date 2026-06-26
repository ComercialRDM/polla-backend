const crypto = require('crypto');

// Secreto para firmar los tokens de atribución de clics de influencers.
// A diferencia de ADMIN_JWT_SECRET, si este rota en cada reinicio el único
// efecto es que se pierde la atribución de clics ya emitidos (no es una
// sesión de acceso), pero igual conviene fijarlo en Render para no perder
// atribuciones en curso en cada deploy.
if (!process.env.REFERIDO_HMAC_SECRET) {
    console.warn('ADVERTENCIA: REFERIDO_HMAC_SECRET no está configurado. Los tokens de atribución de clics se invalidarán en cada reinicio.');
}
const SECRET = process.env.REFERIDO_HMAC_SECRET || crypto.randomBytes(32).toString('hex');

// Ventana de atribución: un clic atribuye la venta si la compra ocurre dentro
// de este plazo desde el clic (estándar de la industria: 30 días, "last click").
const VIGENCIA_SEG = 30 * 24 * 60 * 60;

function base64url(input) {
    return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function firmar(data) {
    return base64url(crypto.createHmac('sha256', SECRET).update(data).digest());
}

/**
 * Firma un token de atribución de clic. No es una credencial de sesión: solo
 * declara "este clic, de este influencer, ocurrió en este momento", para que
 * el backend pueda verificar su autenticidad al momento de la compra sin
 * confiar en un valor arbitrario enviado por el cliente.
 * @param {{ clicId: number, influencerId: number }} datos
 */
function firmarTokenAtribucion({ clicId, influencerId }) {
    const payload = JSON.stringify({ clicId, influencerId, exp: Math.floor(Date.now() / 1000) + VIGENCIA_SEG });
    const payloadB64 = base64url(payload);
    return `${payloadB64}.${firmar(payloadB64)}`;
}

/**
 * Verifica un token de atribución y devuelve su payload si es válido y no ha
 * expirado. Devuelve null ante cualquier token ausente, malformado, con
 * firma inválida o vencido (nunca lanza).
 * @returns {{ clicId: number, influencerId: number } | null}
 */
function verificarTokenAtribucion(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;

    const [payloadB64, firma] = token.split('.');
    const firmaEsperada = firmar(payloadB64);

    const bufFirma = Buffer.from(firma);
    const bufEsperada = Buffer.from(firmaEsperada);
    if (bufFirma.length !== bufEsperada.length || !crypto.timingSafeEqual(bufFirma, bufEsperada)) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
        if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
        return { clicId: payload.clicId, influencerId: payload.influencerId };
    } catch {
        return null;
    }
}

// Hash de la IP para guardar en referido_clics: suficiente para agrupar y
// detectar abuso (misma IP repetida) sin almacenar la IP real en texto plano.
function hashIp(ip) {
    return crypto.createHmac('sha256', SECRET).update(String(ip || '')).digest('hex');
}

module.exports = { firmarTokenAtribucion, verificarTokenAtribucion, hashIp };
