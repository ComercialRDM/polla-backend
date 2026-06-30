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

// Nombre del campo de usuario (ver automatización en ManyChat: "Nuevo
// contacto" -> "Establecer whatsapp_id_sync para {WhatsApp ID}") que guarda
// una copia del WhatsApp ID de cada contacto, porque findBySystemField busca
// suscriptores de SMS, no de WhatsApp (limitación documentada de ManyChat:
// https://community.manychat.com/general-q-a-43/how-to-search-a-user-via-whatsapp-id-9175)
// y por eso nunca podía recuperar un contacto de WhatsApp ya existente.
const CAMPO_WHATSAPP_ID_SYNC = 'whatsapp_id_sync';

let camposCache = null; // array de todos los custom fields, cargado una sola vez

async function cargarCamposCache() {
    if (!camposCache) {
        const r = await manychatRequest('/fb/page/getCustomFields', null, 'GET');
        camposCache = r?.data || [];
    }
    return camposCache;
}

/**
 * Obtiene el field_id numérico de un campo de usuario por su nombre
 * (findByCustomField lo exige por ID, no por nombre). Usa el caché global de
 * todos los campos para no llamar a getCustomFields más de una vez por proceso.
 */
async function obtenerFieldId(nombreCampo) {
    const campos = await cargarCamposCache();
    const campo = campos.find((f) => f.name === nombreCampo);
    if (!campo) {
        console.error(`No se encontró el campo de usuario "${nombreCampo}" en ManyChat (getCustomFields)`);
        return null;
    }
    return campo.id;
}

/**
 * Variantes de búsqueda que se intentan, en orden, para recuperar un
 * suscriptor existente cuando createSubscriber falla con "already exists".
 * "custom-field" va primero porque es el único método que en la práctica
 * encuentra contactos de WhatsApp (ver CAMPO_WHATSAPP_ID_SYNC) — las
 * variantes de findBySystemField quedan de respaldo, pero están confirmadas
 * en producción como no funcionales para WhatsApp (esa búsqueda es para
 * suscriptores de SMS).
 * @param {string} waId celular sin '+' | @param {string} waIdConMas celular con '+'
 */
async function variantesBusquedaSubscriber(waId, waIdConMas) {
    const variantes = [];

    const fieldId = await obtenerFieldId(CAMPO_WHATSAPP_ID_SYNC);
    if (fieldId) {
        variantes.push({
            nombre: 'custom-field:whatsapp_id_sync',
            url: `/fb/subscriber/findByCustomField?field_id=${fieldId}&field_value=${encodeURIComponent(waId)}`,
        });
    }

    variantes.push(
        { nombre: 'param-directo:wa_id', url: `/fb/subscriber/findBySystemField?wa_id=${encodeURIComponent(waId)}` },
        { nombre: 'system_field:wa_id', url: `/fb/subscriber/findBySystemField?system_field=wa_id&value=${waId}` },
        { nombre: 'param-directo:whatsapp_phone', url: `/fb/subscriber/findBySystemField?whatsapp_phone=${encodeURIComponent(waIdConMas)}` },
        { nombre: 'param-directo:phone', url: `/fb/subscriber/findBySystemField?phone=${encodeURIComponent(waIdConMas)}` },
        { nombre: 'system_field:whatsapp_phone', url: `/fb/subscriber/findBySystemField?system_field=whatsapp_phone&value=${waId}` },
        { nombre: 'system_field:phone', url: `/fb/subscriber/findBySystemField?system_field=phone&value=${waId}` },
    );

    return variantes;
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
    // varias variantes de la búsqueda, una por una (la de custom-field va
    // primero y es la que en la práctica funciona para WhatsApp).
    const busquedas = {};
    for (const { nombre, url } of await variantesBusquedaSubscriber(waId, whatsappPhone)) {
        const busqueda = await manychatRequest(url, null, 'GET');
        console.log(`[ManyChat] busqueda (${nombre})`, { celular: waId, url, respuesta: busqueda });
        busquedas[nombre] = busqueda;
        // findByCustomField devuelve un array en data; findBySystemField devuelve un objeto con id.
        const encontrado = Array.isArray(busqueda?.data) ? busqueda.data[0]?.id : busqueda?.data?.id;
        if (encontrado) {
            return { subscriberId: encontrado, metodo: nombre, diagnostico: { crear, busquedas } };
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

// flow_ns de la automatización "Sin título / Enviar Bono Plantilla" en ManyChat
// (visible en la URL al editar el flow: /cms/files/<flow_ns>/edit)
const FLOW_NS_BONO_PLANTILLA = 'content20260629223945_206218';

/**
 * Envía la confirmación de compra de bono por WhatsApp usando la plantilla
 * aprobada por Meta (purchase_voucher_confirmed), que funciona fuera de la
 * ventana de sesión de 24 horas porque es un mensaje de plantilla de utilidad.
 * Puebla las 6 variables del template vía setCustomField y luego dispara el
 * flow con sendFlow.
 */
async function enviarBonoPorPlantilla({ celular, subscriberId, nombre, monto, codigo, partido, intentos, link }) {
    if (!MANYCHAT_API_KEY) {
        console.warn('MANYCHAT_API_KEY no configurada, no se envía plantilla a', celular);
        return { subscriberId: subscriberId || null };
    }

    let id = subscriberId;
    if (!id) {
        ({ subscriberId: id } = await obtenerSubscriberId(celular));
    }
    if (!id) throw new Error(`No se encontró el suscriptor de ManyChat para ${celular}`);

    const campos = await cargarCamposCache();

    const camposBono = [
        { nombre: 'bono_nombre',    valor: nombre },
        { nombre: 'bono_monto',     valor: monto },
        { nombre: 'bono_codigo',    valor: codigo },
        { nombre: 'bono_partido',   valor: partido },
        { nombre: 'bono_intentos',  valor: String(intentos) },
        { nombre: 'bono_link',      valor: link },
    ];

    for (const { nombre: nombreCampo, valor } of camposBono) {
        const campo = campos.find((f) => f.name === nombreCampo);
        if (!campo) {
            console.warn(`[ManyChat] campo "${nombreCampo}" no encontrado en getCustomFields, se omite`);
            continue;
        }
        const r = await manychatRequest('/fb/subscriber/setCustomField', {
            subscriber_id: id,
            field_id: campo.id,
            field_value: valor,
        });
        if (r?.status !== 'success') {
            console.warn(`[ManyChat] setCustomField ${nombreCampo}:`, JSON.stringify(r));
        }
    }

    const resultado = await manychatRequest('/fb/sending/sendFlow', {
        subscriber_id: id,
        flow_ns: FLOW_NS_BONO_PLANTILLA,
    });

    if (resultado?.status !== 'success') {
        throw new Error(`ManyChat sendFlow error: ${JSON.stringify(resultado)}`);
    }

    return { subscriberId: id };
}

module.exports = { enviarMensajeManyChat, enviarBonoManyChat, enviarBonoPorPlantilla, formatearCelularWhatsApp, obtenerSubscriberId };
