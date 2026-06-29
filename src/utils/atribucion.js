// Clasificacion de canal de marketing para reportes de atribucion (GA4 +
// Postgres). Unica fuente de verdad: si se ajustan estas reglas, tambien hay
// que actualizar README_ATTRIBUTION_TRACKING.md (la documentacion describe
// la misma tabla de reglas en prosa para quien no lea codigo).
//
// Prioridad de clasificacion: primero se confia en lo que el backend ya
// verifico (codigo de afiliado con firma HMAC valida, o token de "invita
// amigos") por encima de cualquier UTM declarada por el cliente, porque las
// UTMs son texto libre sin verificar y un link mal copiado no debe hacer que
// una venta de influencer se reporte como "email" o viceversa.

const LONGITUD_MAXIMA_CAMPO = 255;

const DOMINIOS_SOCIALES = ['facebook.com', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com', 'threads.net'];
const DOMINIOS_BUSCADORES = ['google.', 'bing.com', 'yahoo.', 'duckduckgo.com'];

// Quita caracteres de control (whitespace exotico, bytes nulos, etc.) y
// recorta la longitud. Nunca lanza: devuelve null ante cualquier valor que
// no sea un string usable.
function sanear(valor) {
    if (typeof valor !== 'string') return null;
    let limpio = '';
    for (let i = 0; i < valor.length; i++) {
        const codigo = valor.charCodeAt(i);
        const esControl = codigo < 32 || codigo === 127;
        if (!esControl) limpio += valor[i];
    }
    limpio = limpio.trim();
    if (!limpio) return null;
    return limpio.slice(0, LONGITUD_MAXIMA_CAMPO);
}

/**
 * Extrae y sanea los campos de atribucion de un body de request. No valida
 * que el origen sea legitimo (son datos declarativos del cliente, no
 * verificados) -- para eso existe clasificarCanal, que prioriza senales ya
 * verificadas por el backend (aff_token/ref) sobre estos campos libres.
 */
function extraerAtribucion(body) {
    const datos = body || {};
    return {
        utmSource: sanear(datos.utm_source),
        utmMedium: sanear(datos.utm_medium),
        utmCampaign: sanear(datos.utm_campaign),
        utmContent: sanear(datos.utm_content),
        utmTerm: sanear(datos.utm_term),
        referrer: sanear(datos.referrer),
        landingPage: sanear(datos.landing_page),
        firstTouchAt: sanear(datos.first_touch_at),
    };
}

function dominioCoincide(referrer, dominios) {
    if (!referrer) return false;
    const referrerNorm = referrer.toLowerCase();
    for (let i = 0; i < dominios.length; i++) {
        if (referrerNorm.indexOf(dominios[i]) !== -1) return true;
    }
    return false;
}

/**
 * Clasifica una venta/visita en un grupo de canal para reportes. Recibe la
 * atribucion ya saneada (de extraerAtribucion) mas las senales verificadas
 * por el backend (si hubo afiliado/influencer o token de amigo resuelto).
 * @param {{ utmSource?: string, utmMedium?: string, referrer?: string }} atribucion
 * @param {{ esInfluencer?: boolean, esAmigo?: boolean }} senalesVerificadas
 * @returns {string} uno de: influencer, friend, email, sms, whatsapp, paid_ads, organic_social, organic_search, direct, referral
 */
function clasificarCanal(atribucion, senalesVerificadas) {
    const atrib = atribucion || {};
    const senales = senalesVerificadas || {};
    const utmSource = atrib.utmSource;
    const medium = (atrib.utmMedium || '').toLowerCase();
    const source = (utmSource || '').toLowerCase();
    const referrer = atrib.referrer;

    // 1. Senales ya verificadas por el backend ganan sobre cualquier UTM libre.
    if (senales.esInfluencer) return 'influencer';
    if (senales.esAmigo) return 'friend';

    // 2. UTMs explicitas (cuando no hubo verificacion de afiliado/amigo, ej.
    // un link de influencer compartido sin pasar por el flujo de aff_token).
    if (medium === 'email') return 'email';
    if (medium === 'sms') return 'sms';
    if (medium === 'whatsapp' || source === 'whatsapp' || source === 'manychat') return 'whatsapp';
    if (medium === 'influencer') return 'influencer';
    if (medium === 'friend') return 'friend';
    if (medium === 'paid_social' || medium === 'cpc') return 'paid_ads';

    // 3. Sin UTM: inferir de referrer.
    if (!utmSource) {
        if (dominioCoincide(referrer, DOMINIOS_SOCIALES)) return 'organic_social';
        if (dominioCoincide(referrer, DOMINIOS_BUSCADORES)) return 'organic_search';
        if (!referrer) return 'direct';
    }

    return 'referral';
}

module.exports = { extraerAtribucion, clasificarCanal, sanear };
