const crypto = require('crypto');

const WOMPI_EVENTS_SECRET = process.env.WOMPI_EVENTS_SECRET;
const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY;
const WOMPI_INTEGRITY_SECRET = process.env.WOMPI_INTEGRITY_SECRET;

/**
 * Firma de integridad para el Widget Checkout de Wompi.
 * checksum = SHA256( reference + amountInCents + currency + WOMPI_INTEGRITY_SECRET )
 * El Widget Checkout (a diferencia de los Payment Links) sí soporta pre-llenar
 * nombre/correo/celular del comprador vía customerData, por eso se usa aquí.
 */
function generarFirmaIntegridad({ reference, amountInCents, currency = 'COP' }) {
    const cadena = `${reference}${amountInCents}${currency}${WOMPI_INTEGRITY_SECRET}`;
    return crypto.createHash('sha256').update(cadena).digest('hex');
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

module.exports = { generarFirmaIntegridad, validarFirmaWebhook, WOMPI_PUBLIC_KEY };
