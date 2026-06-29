// Script local para consultar la API de GA4 usando el refresh token guardado
// en .ga4-credentials.json (no se sube a git). Uso:
//   node scripts/ga4-report.js [tipo] [dias]
// tipo: paginas | adquisicion | eventos | resumen
//       revenue-canal | revenue-source-medium | revenue-campana | revenue-referral-group
// Ejemplos:
//   node scripts/ga4-report.js resumen 30
//   node scripts/ga4-report.js revenue-canal 30
//   node scripts/ga4-report.js revenue-referral-group 30   (requiere custom dimension, ver README_ATTRIBUTION_TRACKING.md)

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { OAuth2Client } = require('google-auth-library');

const credPath = path.join(__dirname, '..', '.ga4-credentials.json');
const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));

async function obtenerAccessToken() {
    const client = new OAuth2Client(creds.client_id, creds.client_secret);
    client.setCredentials({ refresh_token: creds.refresh_token });
    const { token } = await client.getAccessToken();
    return token;
}

async function runReport(body) {
    const accessToken = await obtenerAccessToken();
    const { data } = await axios.post(
        `https://analyticsdata.googleapis.com/v1beta/properties/${creds.property_id}:runReport`,
        body,
        { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return data;
}

function imprimir(data) {
    const headers = [
        ...(data.dimensionHeaders || []).map((h) => h.name),
        ...(data.metricHeaders || []).map((h) => h.name),
    ];
    console.log(headers.join(' | '));
    console.log('-'.repeat(60));
    for (const row of data.rows || []) {
        const valores = [
            ...(row.dimensionValues || []).map((v) => v.value),
            ...(row.metricValues || []).map((v) => v.value),
        ];
        console.log(valores.join(' | '));
    }
    if (!data.rows?.length) console.log('(sin datos en este rango)');
}

async function main() {
    const tipo = process.argv[2] || 'resumen';
    const dias = process.argv[3] || '30';
    const dateRanges = [{ startDate: `${dias}daysAgo`, endDate: 'today' }];

    let body;
    if (tipo === 'paginas') {
        body = {
            dateRanges,
            dimensions: [{ name: 'pagePath' }],
            metrics: [{ name: 'screenPageViews' }, { name: 'averageSessionDuration' }, { name: 'bounceRate' }],
            orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
            limit: 20,
        };
    } else if (tipo === 'adquisicion') {
        body = {
            dateRanges,
            dimensions: [{ name: 'sessionDefaultChannelGroup' }],
            metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'engagementRate' }],
            orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        };
    } else if (tipo === 'eventos') {
        body = {
            dateRanges,
            dimensions: [{ name: 'eventName' }],
            metrics: [{ name: 'eventCount' }],
            orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
            limit: 25,
        };
    } else if (tipo === 'revenue-canal') {
        // Usa el canal que GA4 calcula solo a partir de las UTMs estandar
        // (sessionDefaultChannelGroup) -- no requiere ninguna dimension custom
        // creada a mano en GA4, funciona apenas empiecen a llegar eventos purchase.
        body = {
            dateRanges,
            dimensions: [{ name: 'sessionDefaultChannelGroup' }],
            metrics: [{ name: 'transactions' }, { name: 'purchaseRevenue' }],
            orderBys: [{ metric: { metricName: 'purchaseRevenue' }, desc: true }],
        };
    } else if (tipo === 'revenue-source-medium') {
        body = {
            dateRanges,
            dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
            metrics: [{ name: 'transactions' }, { name: 'purchaseRevenue' }],
            orderBys: [{ metric: { metricName: 'purchaseRevenue' }, desc: true }],
            limit: 25,
        };
    } else if (tipo === 'revenue-campana') {
        body = {
            dateRanges,
            dimensions: [{ name: 'sessionCampaignName' }],
            metrics: [{ name: 'transactions' }, { name: 'purchaseRevenue' }],
            orderBys: [{ metric: { metricName: 'purchaseRevenue' }, desc: true }],
            limit: 25,
        };
    } else if (tipo === 'revenue-referral-group') {
        // REQUIERE haber creado antes la Custom Dimension de evento
        // "referral_group" en GA4 (Admin > Custom definitions > Create custom
        // dimension, scope "Event", parametro "referral_group"). Sin ese paso
        // manual, esta consulta devuelve vacio o error de dimension invalida.
        // Ver README_ATTRIBUTION_TRACKING.md para el paso a paso.
        body = {
            dateRanges,
            dimensions: [{ name: 'customEvent:referral_group' }],
            metrics: [{ name: 'transactions' }, { name: 'purchaseRevenue' }],
            orderBys: [{ metric: { metricName: 'purchaseRevenue' }, desc: true }],
        };
    } else {
        body = {
            dateRanges,
            metrics: [
                { name: 'activeUsers' },
                { name: 'sessions' },
                { name: 'screenPageViews' },
                { name: 'averageSessionDuration' },
                { name: 'bounceRate' },
                { name: 'engagementRate' },
            ],
        };
    }

    const data = await runReport(body);
    imprimir(data);
}

main().catch((err) => {
    console.error('Error consultando GA4:', err.response?.data || err.message);
    process.exit(1);
});
