const axios = require('axios');
const crypto = require('crypto');

const WOMPI_API_URL = process.env.WOMPI_API_URL || 'https://production.wompi.co/v1';
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY;
const WOMPI_EVENTS_SECRET = process.env.WOMPI_EVENTS_SECRET;

/**
 * Crea un Payment Link dinámico de un solo uso en Wompi.
 * El amount_in_cents queda fijo, así el cliente no puede alterar el valor.
 */
async function crearPaymentLink({ name, description, amountInCents, reference, redirectUrl, expiresAt }) {
    const body = {
        name,
        description,
        single_use: true,
        collect_shipping: false,
        currency: 'COP',
        amount_in_cents: amountInCents,
        sku: reference,
        redirect_url: redirectUrl,
    };

    if (expiresAt) {
        body.expires_at = expiresAt;
    }

    const response = await axios.post(`${WOMPI_API_URL}/payment_links`, body, {
        headers: {
            Authorization: `Bearer ${WOMPI_PRIVATE_KEY}`,
            'Content-Type': 'application/json',
        },
    });

    const linkId = response.data?.data?.id;
    if (!linkId) {
        throw new Error('Wompi no devolvió un id de payment link');
    }

    return {
        paymentLinkId: linkId,
        checkoutUrl: `https://checkout.wompi.co/l/${linkId}`,
    };
}

/**
 * Extrae un valor anidado de un objeto a partir de un path tipo "transaction.id"
 */
function obtenerValorPorPath(objeto, path) {
    return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), objeto);
}

/**
 * Valida la firma de un evento webhook de Wompi.
 * La firma viene en evento.signature: { properties: [...], checksum }
 * checksum = SHA256( valoresConcatenados + timestamp + WOMPI_EVENTS_SECRET )
 */
function validarFirmaWebhook(evento) {
    try {
        const { signature, timestamp, data } = evento;
        if (!signature || !signature.properties || !signature.checksum || !timestamp) {
            return false;
        }

        let cadena = '';
        for (const propertyPath of signature.properties) {
            const valor = obtenerValorPorPath(data, propertyPath);
            cadena += String(valor);
        }
        cadena += String(timestamp);
        cadena += WOMPI_EVENTS_SECRET;

        const checksumCalculado = crypto.createHash('sha256').update(cadena).digest('hex');

        const bufferCalculado = Buffer.from(checksumCalculado, 'hex');
        const bufferRecibido = Buffer.from(signature.checksum, 'hex');

        if (bufferCalculado.length !== bufferRecibido.length) {
            return false;
        }

        return crypto.timingSafeEqual(bufferCalculado, bufferRecibido);
    } catch (err) {
        return false;
    }
}

module.exports = { crearPaymentLink, validarFirmaWebhook };
