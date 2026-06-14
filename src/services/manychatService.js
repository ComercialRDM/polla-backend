const axios = require('axios');

const MANYCHAT_API_URL = process.env.MANYCHAT_API_URL || 'https://api.manychat.com';
const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY;

/**
 * Normaliza el celular al formato internacional que espera ManyChat para WhatsApp.
 * Si llega con 10 dígitos (formato local colombiano) le antepone el código de país 57.
 * @param {string} celular
 */
function formatearCelularWhatsApp(celular) {
    const limpio = String(celular || '').replace(/\D/g, '');
    if (limpio.length === 10 && !limpio.startsWith('57')) {
        return `57${limpio}`;
    }
    return limpio;
}

/**
 * Envía un bloque de mensajes (texto y/o imagen) a través de ManyChat al celular indicado.
 * Requiere MANYCHAT_API_KEY (token del bot en ManyChat).
 * @param {{ celular: string, messages: Array }} datos
 */
async function enviarContenidoManyChat({ celular, messages }) {
    if (!MANYCHAT_API_KEY) {
        console.warn('MANYCHAT_API_KEY no configurada, no se envía notificación a', celular);
        return;
    }

    await axios.post(
        `${MANYCHAT_API_URL}/v1/content/sendContent`,
        {
            phone: formatearCelularWhatsApp(celular),
            data: {
                version: 'v2',
                content: { messages },
            },
        },
        {
            headers: {
                Authorization: `Bearer ${MANYCHAT_API_KEY}`,
                'Content-Type': 'application/json',
            },
        }
    );
}

/**
 * Envía un mensaje de texto simple por WhatsApp/Messenger.
 * @param {{ celular: string, mensaje: string }} datos
 */
async function enviarMensajeManyChat({ celular, mensaje }) {
    return enviarContenidoManyChat({ celular, messages: [{ type: 'text', text: mensaje }] });
}

/**
 * Envía la imagen del bono junto con un mensaje de texto con los detalles de la compra.
 * @param {{ celular: string, mensaje: string, imagenUrl: string }} datos
 */
async function enviarBonoManyChat({ celular, mensaje, imagenUrl }) {
    return enviarContenidoManyChat({
        celular,
        messages: [
            { type: 'image', url: imagenUrl },
            { type: 'text', text: mensaje },
        ],
    });
}

module.exports = { enviarMensajeManyChat, enviarBonoManyChat, formatearCelularWhatsApp };
