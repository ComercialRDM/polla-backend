const axios = require('axios');

const MANYCHAT_API_URL = process.env.MANYCHAT_API_URL || 'https://api.manychat.com';
const MANYCHAT_API_KEY = process.env.MANYCHAT_API_KEY;

// Copia de control de cada WhatsApp enviado a un cliente. Limitacion real y
// documentada de ManyChat: su API no tiene forma de buscar un suscriptor
// existente por su WhatsApp ID (ver https://community.manychat.com/general-q-a-43/how-to-search-a-user-via-whatsapp-id-9175),
// asi que en vez de depender de esa busqueda (que falla siempre para
// contactos que ya existian) se usa directamente el subscriber_id numerico,
// visible en ManyChat -> Contacts -> abrir el contacto -> icono de ID.
const NUMERO_COPIA_CONTROL = process.env.NUMERO_COPIA_CONTROL || '573012786234';
const SUBSCRIBER_ID_COPIA_CONTROL = process.env.SUBSCRIBER_ID_COPIA_CONTROL || '1486004520';

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
 * "wa_id" va primero porque es el nombre de campo real que usa ManyChat
 * internamente (lo confirma el propio mensaje de error de createSubscriber:
 * "This WhatsApp ID already exists: <wa_id>") — las demás variantes son
 * intentos de respaldo que en la práctica no han logrado recuperar el
 * suscriptor (devuelven "Validation error" o data vacía).
 * @param {string} waId celular sin '+' | @param {string} waIdConMas celular con '+'
 */
function variantesBusquedaSubscriber(waId, waIdConMas) {
    return [
        { nombre: 'param-directo:wa_id', url: `/fb/subscriber/findBySystemField?wa_id=${encodeURIComponent(waId)}` },
        { nombre: 'system_field:wa_id', url: `/fb/subscriber/findBySystemField?system_field=wa_id&value=${waId}` },
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
 * Envío "crudo" a un celular puntual, sin la copia de control (la usa tanto
 * el envío real como el envío de la copia, para no copiarse a sí misma).
 */
async function enviarContenidoManyChatBase({ celular, messages, subscriberId }) {
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
 * Manda una copia de control de cada WhatsApp real a NUMERO_COPIA_CONTROL,
 * para que el negocio pueda ver todo lo que se envía. Usa directamente
 * SUBSCRIBER_ID_COPIA_CONTROL (no busca por número: la búsqueda de ManyChat
 * por WhatsApp ID está rota para contactos preexistentes, ver comentario en
 * la constante). Nunca lanza: un fallo aquí no debe afectar el mensaje real
 * que ya se le mandó al cliente.
 */
async function enviarCopiaControl({ celular, messages }) {
    if (formatearCelularWhatsApp(celular) === formatearCelularWhatsApp(NUMERO_COPIA_CONTROL)) return;
    try {
        await enviarContenidoManyChatBase({
            celular: NUMERO_COPIA_CONTROL,
            subscriberId: SUBSCRIBER_ID_COPIA_CONTROL,
            messages: [{ type: 'text', text: `📋 Copia de control — enviado a ${celular}` }, ...messages],
        });
    } catch (err) {
        console.warn('No se pudo enviar la copia de control de WhatsApp:', err.message);
    }
}

/**
 * Envía un bloque de mensajes (texto y/o imagen) por WhatsApp a través de ManyChat.
 * Si no se pasa `subscriberId`, intenta crear el suscriptor (solo funciona para
 * contactos nuevos en ManyChat). Además manda una copia de control (ver
 * enviarCopiaControl) sin que un fallo ahí afecte el envío real.
 * @param {{ celular: string, messages: Array, subscriberId?: string|number }} datos
 * @returns {Promise<{ subscriberId: string|number|null }>}
 */
async function enviarContenidoManyChat({ celular, messages, subscriberId }) {
    if (!MANYCHAT_API_KEY) {
        console.warn('MANYCHAT_API_KEY no configurada, no se envía notificación a', celular);
        return { subscriberId: subscriberId || null };
    }

    const resultado = await enviarContenidoManyChatBase({ celular, messages, subscriberId });

    enviarCopiaControl({ celular, messages }).catch(() => {});

    return resultado;
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
