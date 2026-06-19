const axios = require('axios');

const GRAPH_API_VERSION = 'v22.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const TEMPLATE_NAME = process.env.WHATSAPP_OTP_TEMPLATE || 'codigo_verificacion_polla';

function formatearCelularE164(celular) {
    const limpio = String(celular || '').replace(/\D/g, '');
    if (limpio.length === 10 && !limpio.startsWith('57')) {
        return `57${limpio}`;
    }
    return limpio;
}

/**
 * Envía el código de verificación por WhatsApp usando la plantilla de
 * autenticación aprobada por Meta (categoría Authentication), vía la Cloud
 * API directamente — no por ManyChat, porque Meta exige esa categoría
 * exclusivamente para mensajes con código OTP y ManyChat no la ofrece.
 * Al ser una plantilla aprobada, funciona aunque el celular nunca haya
 * escrito antes al número de WhatsApp (a diferencia de los mensajes libres).
 */
async function enviarCodigoWhatsApp({ celular, codigo }) {
    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
        throw new Error('WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_ACCESS_TOKEN no configurados');
    }

    const { data } = await axios.post(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: 'whatsapp',
            to: formatearCelularE164(celular),
            type: 'template',
            template: {
                name: TEMPLATE_NAME,
                language: { code: 'es' },
                components: [
                    { type: 'body', parameters: [{ type: 'text', text: codigo }] },
                    { type: 'button', sub_type: 'copy_code', index: 0, parameters: [{ type: 'text', text: codigo }] },
                ],
            },
        },
        {
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
            timeout: 10000,
        }
    );

    return data;
}

module.exports = { enviarCodigoWhatsApp };
