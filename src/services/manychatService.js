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
async function manychatRequest(path, body, method = 'POST') {
    const config = {
        headers: {
            Authorization: `Bearer ${MANYCHAT_API_KEY}`,
            'Content-Type': 'application/json',
        },
        timeout: 10000,
        validateStatus: () => true,
    };
    const { data } = method === 'GET'
        ? await axios.get(`${MANYCHAT_API_URL}${path}`, config)
        : await axios.post(`${MANYCHAT_API_URL}${path}`, body, config);
    return data;
}

/**
 * Obtiene el subscriber_id de ManyChat para el celular dado.
 * Intenta crear el suscriptor; si ya existe, lo busca por WhatsApp phone.
 */
async function crearSubscriberId(celular) {
    const whatsappPhone = `+${formatearCelularWhatsApp(celular)}`;
    const waId = formatearCelularWhatsApp(celular); // sin '+'

    // Intento 1: crear suscriptor
    const respuesta = await manychatRequest('/fb/subscriber/createSubscriber', {
        whatsapp_phone: whatsappPhone,
        consent_phrase: 'Acepto recibir mensajes de La Retoucherie por WhatsApp',
    });

    if (respuesta?.data?.id) {
        return respuesta.data.id;
    }

    // Intento 2: si ya existe ("This WhatsApp ID already exists"), buscarlo
    if (respuesta?.status === 'error') {
        const findResp = await manychatRequest(
            `/fb/subscriber/findBySystemField?system_field=whatsapp_phone&value=${waId}`,
            null,
            'GET'
        );
        if (findResp?.data?.id) {
            return findResp.data.id;
        }
        console.error('No se pudo encontrar el suscriptor de ManyChat para', celular,
            '| create:', JSON.stringify(respuesta),
            '| find:', JSON.stringify(findResp));
    }

    return null;
}

/**
 * Envía un bloque de mensajes (texto y/o imagen) por WhatsApp a través de ManyChat.
 * Si no se pasa `subscriberId`, intenta crear el suscriptor (solo funciona para
 * contactos nuevos en ManyChat).
 * @param {{ celular: string, messages: Array, subscriberId?: string|number }} datos
 * @returns {Promise<{ subscriberId: string|number|null }>}
 */
async function enviarContenidoManyChat({ celular, messages, subscriberId }) {
    if (!MANYCHAT_API_KEY) {
        console.warn('MANYCHAT_API_KEY no configurada, no se envía notificación a', celular);
        return { subscriberId: subscriberId || null };
    }

    let id = subscriberId;
    if (!id) {
        id = await crearSubscriberId(celular);
    }

    if (!id) {
        throw new Error(`No se encontró/creó el suscriptor de ManyChat para ${celular}`);
    }

    const resultado = await manychatRequest('/fb/sending/sendContent', {
        subscriber_id: id,
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

    return { subscriberId: id };
}

/**
 * Envía un mensaje de texto simple por WhatsApp/Messenger.
 * @param {{ celular: string, mensaje: string, subscriberId?: string|number }} datos
 */
async function enviarMensajeManyChat({ celular, mensaje, subscriberId }) {
    return enviarContenidoManyChat({ celular, messages: [{ type: 'text', text: mensaje }], subscriberId });
}

/**
 * Envía la imagen del bono junto con un mensaje de texto con los detalles de la compra.
 * @param {{ celular: string, mensaje: string, imagenUrl: string, subscriberId?: string|number }} datos
 */
async function enviarBonoManyChat({ celular, mensaje, imagenUrl, subscriberId }) {
    return enviarContenidoManyChat({
        celular,
        messages: [
            { type: 'image', url: imagenUrl },
            { type: 'text', text: mensaje },
        ],
        subscriberId,
    });
}

module.exports = { enviarMensajeManyChat, enviarBonoManyChat, formatearCelularWhatsApp };
