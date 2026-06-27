const axios = require('axios');
const { generarFirmaIntegridad, WOMPI_PUBLIC_KEY } = require('./wompiService');

const WOMPI_API_URL = process.env.WOMPI_API_URL;
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY;

/**
 * Trae los Acceptance Tokens (política de privacidad + autorización de datos
 * personales) que Wompi exige en toda transacción creada vía API directa
 * (PSE, Botón Bancolombia). A diferencia del Widget, que los maneja solo,
 * aquí hay que pedirlos nosotros antes de crear la transacción.
 */
async function obtenerAcceptanceTokens() {
    const { data } = await axios.get(`${WOMPI_API_URL}/merchants/${WOMPI_PUBLIC_KEY}`, {
        headers: { Authorization: `Bearer ${WOMPI_PUBLIC_KEY}` },
        timeout: 10000,
    });
    return {
        acceptanceToken: data.data.presigned_acceptance.acceptance_token,
        acceptPersonalAuth: data.data.presigned_personal_data_auth.acceptance_token,
    };
}

/**
 * Lista de bancos disponibles para PSE (financial_institution_code), que el
 * frontend debe mostrar como selector — no es un valor libre.
 * @returns {Promise<Array<{ codigo: string, nombre: string }>>}
 */
async function obtenerBancosPSE() {
    const { data } = await axios.get(`${WOMPI_API_URL}/pse/financial_institutions`, {
        headers: { Authorization: `Bearer ${WOMPI_PUBLIC_KEY}` },
        timeout: 10000,
    });
    return data.data.map((banco) => ({ codigo: banco.financial_institution_code, nombre: banco.financial_institution_name }));
}

/**
 * PSE y Botón Bancolombia son métodos "asíncronos": al crear la transacción,
 * Wompi todavía no tiene el link al banco/app — hay que volver a consultar la
 * transacción (long polling) hasta que aparezca `payment_method.extra.async_payment_url`.
 * Documentado así por Wompi para ambos métodos.
 */
async function esperarUrlAsincrona(transaccionId, { intentos = 15, intervaloMs = 500 } = {}) {
    for (let i = 0; i < intentos; i++) {
        const { data } = await axios.get(`${WOMPI_API_URL}/transactions/${transaccionId}`, {
            headers: { Authorization: `Bearer ${WOMPI_PRIVATE_KEY}` },
            timeout: 10000,
        });
        const url = data.data?.payment_method?.extra?.async_payment_url;
        if (url) return url;
        await new Promise((resolve) => setTimeout(resolve, intervaloMs));
    }
    throw new Error('Wompi no devolvió el link de pago a tiempo (async_payment_url). Intenta de nuevo.');
}

/**
 * Crea la transacción en Wompi vía API directa (no Widget) con el
 * payment_method que se le pase. Requiere WOMPI_PRIVATE_KEY (a diferencia del
 * Widget/firma de integridad, que solo necesitan la llave pública/el secreto
 * de integridad) porque esto mueve dinero del lado del servidor.
 * @returns {Promise<{ pasarelaTransaccionId: string, asyncPaymentUrl: string }>}
 */
async function crearTransaccionDirecta({ reference, amountInCents, customerEmail, redirectUrl, paymentMethod }) {
    const { acceptanceToken, acceptPersonalAuth } = await obtenerAcceptanceTokens();
    const signature = generarFirmaIntegridad({ reference, amountInCents, currency: 'COP' });

    const { data } = await axios.post(
        `${WOMPI_API_URL}/transactions`,
        {
            acceptance_token: acceptanceToken,
            accept_personal_auth: acceptPersonalAuth,
            amount_in_cents: amountInCents,
            currency: 'COP',
            customer_email: customerEmail,
            reference,
            redirect_url: redirectUrl,
            signature,
            payment_method: paymentMethod,
        },
        {
            headers: { Authorization: `Bearer ${WOMPI_PRIVATE_KEY}` },
            timeout: 15000,
        }
    );

    const pasarelaTransaccionId = data.data.id;
    const asyncPaymentUrl = await esperarUrlAsincrona(pasarelaTransaccionId);
    return { pasarelaTransaccionId, asyncPaymentUrl };
}

/**
 * @param {{ userLegalIdType: 'CC'|'CE'|'NIT', userLegalId: string, financialInstitutionCode: string, paymentDescription: string }} datosPse
 */
function crearTransaccionPSE({ reference, amountInCents, customerEmail, redirectUrl, userLegalIdType, userLegalId, financialInstitutionCode, paymentDescription }) {
    return crearTransaccionDirecta({
        reference,
        amountInCents,
        customerEmail,
        redirectUrl,
        paymentMethod: {
            type: 'PSE',
            user_type: 0,
            user_legal_id_type: userLegalIdType,
            user_legal_id: userLegalId,
            financial_institution_code: financialInstitutionCode,
            payment_description: paymentDescription.slice(0, 64),
        },
    });
}

function crearTransaccionBancolombiaTransfer({ reference, amountInCents, customerEmail, redirectUrl, paymentDescription }) {
    return crearTransaccionDirecta({
        reference,
        amountInCents,
        customerEmail,
        redirectUrl,
        paymentMethod: {
            type: 'BANCOLOMBIA_TRANSFER',
            user_type: 'PERSON',
            payment_description: paymentDescription.slice(0, 64),
            ecommerce_url: redirectUrl,
        },
    });
}

module.exports = { obtenerBancosPSE, crearTransaccionPSE, crearTransaccionBancolombiaTransfer };
