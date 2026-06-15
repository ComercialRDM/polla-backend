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
 * Llama a la API de ManyChat. No usa los códigos de estado HTTP para detectar errores
 * porque ManyChat devuelve detalles del error en el body (status: "error").
 */
async function manychatRequest(path, body) {
    const { data } = await axios.post(`${MANYCHAT_API_URL}${path}`, body, {
        headers: {
            Authorization: `Bearer ${MANYCHAT_API_KEY}`,
            'Content-Type': 'application/json',
        },
        timeout: 10000,
        validateStatus: () => true,
    });
    return data;
}

async function manychatGet(path, params) {
    const { data } = await axios.get(`${MANYCHAT_API_URL}${path}`, {
        headers: { Authorization: `Bearer ${MANYCHAT_API_KEY}` },
        params,
        timeout: 10000,
        validateStatus: () => true,
    });
    return data;
}

/**
 * Indica si la respuesta de createSubscriber indica que el suscriptor ya existe.
 */
function suscriptorYaExiste(respuesta) {
    const mensajes = respuesta?.details?.messages?.wa_id?.message;
    return Array.isArray(mensajes) && mensajes.some((m) => /already exists/i.test(m));
}

/**
 * Obtiene el subscriber_id de ManyChat asociado a un celular, creándolo si no existe.
 * Si ya existe un suscriptor con ese número de WhatsApp, lo busca por teléfono.
 * @param {string} celular
 * @returns {Promise<number|null>}
 */
async function obtenerSubscriberId(celular) {
    const whatsappPhone = `+${formatearCelularWhatsApp(celular)}`;

    const respuesta = await manychatRequest('/fb/subscriber/createSubscriber', {
        whatsapp_phone: whatsappPhone,
        consent_phrase: 'Acepto recibir mensajes de La Retoucherie por WhatsApp',
    });

    let subscriberId = respuesta?.data?.id || respuesta?.details?.[0]?.extra?.id;

    if (!subscriberId && suscriptorYaExiste(respuesta)) {
        const busqueda = await manychatGet('/fb/subscriber/findBySystemField', {
            system_field_name: 'phone',
            system_field_value: whatsappPhone,
        });
        subscriberId = busqueda?.data?.id;

        if (!subscriberId) {
            console.error('No se pudo encontrar el suscriptor existente de ManyChat para', celular, JSON.stringify(busqueda));
        }
    }

    if (!subscriberId) {
        console.error('No se pudo obtener subscriber_id de ManyChat para', celular, JSON.stringify(respuesta));
        return null;
    }

    return subscriberId;
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

    const subscriberId = await obtenerSubscriberId(celular);
    if (!subscriberId) {
        throw new Error(`No se encontró/creó el suscriptor de ManyChat para ${celular}`);
    }

    const resultado = await manychatRequest('/fb/sending/sendContent', {
        subscriber_id: subscriberId,
        data: {
            version: 'v2',
            content: {
                type: 'whatsapp',
                messages,
            },
        },
    });

    if (resultado?.status !== 'success') {
        throw new Error(`ManyChat sendContent error: ${JSON.stringify(resultado)}`);
    }
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
