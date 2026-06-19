const twilio = require('twilio');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;

const client = ACCOUNT_SID && AUTH_TOKEN ? twilio(ACCOUNT_SID, AUTH_TOKEN) : null;

// Twilio exige formato E.164 (+57XXXXXXXXXX). Si llega como número local de
// 10 dígitos, le antepone el indicativo de Colombia.
function formatearE164(celular) {
    const digitos = String(celular || '').replace(/\D/g, '');
    const conIndicativo = (digitos.length === 10 && !digitos.startsWith('57')) ? `57${digitos}` : digitos;
    return `+${conIndicativo}`;
}

/**
 * Genera y envía el código de verificación por SMS. Twilio Verify administra
 * el código, su vencimiento y el límite de intentos — no se guarda nada en
 * nuestra base de datos.
 */
async function enviarCodigoTwilio(celular) {
    if (!client || !VERIFY_SERVICE_SID) {
        throw new Error('Twilio Verify no configurado (faltan TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_VERIFY_SERVICE_SID)');
    }
    await client.verify.v2.services(VERIFY_SERVICE_SID).verifications.create({
        to: formatearE164(celular),
        channel: 'sms',
    });
}

/**
 * Verifica el código contra Twilio. Devuelve true si es válido (status "approved").
 */
async function verificarCodigoTwilio(celular, codigo) {
    if (!client || !VERIFY_SERVICE_SID) {
        throw new Error('Twilio Verify no configurado (faltan TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_VERIFY_SERVICE_SID)');
    }
    const check = await client.verify.v2.services(VERIFY_SERVICE_SID).verificationChecks.create({
        to: formatearE164(celular),
        code: String(codigo).trim(),
    });
    return check.status === 'approved';
}

module.exports = { enviarCodigoTwilio, verificarCodigoTwilio };
