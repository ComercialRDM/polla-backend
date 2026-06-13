const axios = require('axios');

const MANYCHAT_API_URL = process.env.MANYCHAT_API_URL || 'https://api.manychat.com';
const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY;

/**
 * Envía un mensaje de WhatsApp/Messenger a través de ManyChat al celular indicado.
 * Requiere MANYCHAT_API_KEY (token del bot en ManyChat).
 * @param {{ celular: string, mensaje: string }} datos
 */
async function enviarMensajeManyChat({ celular, mensaje }) {
    if (!MANYCHAT_API_KEY) {
        console.warn('MANYCHAT_API_KEY no configurada, no se envía notificación a', celular);
        return;
    }

    await axios.post(
        `${MANYCHAT_API_URL}/v1/content/sendContent`,
        {
            phone: celular,
            data: {
                version: 'v2',
                content: {
                    messages: [{ type: 'text', text: mensaje }],
                },
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

module.exports = { enviarMensajeManyChat };
