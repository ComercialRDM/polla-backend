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
 * Variantes de la llamada a findBySystemField que se intentan, en orden, para
 * recuperar un suscriptor existente cuando createSubscriber falla con
 * "already exists". El formato "system_field=X&value=Y" devuelve
 * "Only phone or email can be specified" sin importar el valor de X (probado
 * con whatsapp_phone y phone), así que también se intenta el formato con el
 * nombre del campo como parámetro directo (?phone=... / ?whatsapp_phone=...).
 * @param {string} waId celular sin '+' | @param {string} waIdConMas celular con '+'
 */
function variantesBusquedaSubscriber(waId, waIdConMas) {
    return [
        { nombre: 'param-directo:whatsapp_phone', url: `/fb/subscriber/findBySystemField?whatsapp_phone=${encodeURIComponent(waIdConMas)}` },
        { nombre: 'param-directo:phone', url: `/fb/subscriber/findBySystemField?phone=${encodeURIComponent(waIdConMas)}` },
        { nombre: 'system_field:whatsapp_phone', url: `/fb/subscriber/findBySystemField?system_field=whatsapp_phone&value=${waId}` },
        { nombre: 'system_field:phone', url: `/fb/subscriber/findBySystemField?system_field=phone&value=${waId}` },
    ];
}

/**
 * Obtiene el subscriber_id de ManyChat para el celular dado: intenta crear el
 * suscriptor y, si ya existe, lo busca probando varias variantes de
 * findBySystemField. Devuelve también el diagnóstico completo (payloads y
 * respuestas de ManyChat) para poder mostrarlo en herramientas de prueba sin
 * tener que duplicar esta lógica en otro archivo.
 * @param {string} celular
 * @returns {Promise<{ subscriberId: string|number|null, metodo: string|null, diagnostico: object }>}
 */
async function obtenerSubscriberId(celular) {
    const whatsappPhone = `+${formatearCelularWhatsApp(celular)}`;
    const waId = formatearCelularWhatsApp(celular); // sin '+'

    const payloadCrear = {
        whatsapp_phone: whatsappPhone,
        consent_phrase: 'Acepto recibir mensajes de La Retoucherie por WhatsApp',
    };
    const crear = await manychatRequest('/fb/subscriber/createSubscriber', payloadCrear);
    console.log('[ManyChat] createSubscriber', { celular: waId, payload: payloadCrear, respuesta: crear });

    if (crear?.data?.id) {
        return { subscriberId: crear.data.id, metodo: 'createSubscriber', diagnostico: { crear } };
    }

    if (crear?.status !== 'error') {
        return { subscriberId: null, metodo: null, diagnostico: { crear } };
    }

    // El suscriptor ya existe en ManyChat: se intenta recuperar su ID probando
    // varias variantes de la búsqueda, una por una.
    const busquedas = {};
    for (const { nombre, url } of variantesBusquedaSubscriber(waId, whatsappPhone)) {
        const busqueda = await manychatRequest(url, null, 'GET');
        console.log(`[ManyChat] findBySystemField (${nombre})`, { celular: waId, url, respuesta: busqueda });
        busquedas[nombre] = busqueda;
        if (busqueda?.data?.id) {
            return { subscriberId: busqueda.data.id, metodo: `findBySystemField:${nombre}`, diagnostico: { crear, busquedas } };
        }
    }

    console.error('No se pudo encontrar el suscriptor de ManyChat para', celular, JSON.stringify({ crear, busquedas }));
    return { subscriberId: null, metodo: null, diagnostico: { crear, busquedas } };
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
        ({ subscriberId: id } = await obtenerSubscriberId(celular));
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

module.exports = { enviarMensajeManyChat, enviarBonoManyChat, formatearCelularWhatsApp, obtenerSubscriberId };
