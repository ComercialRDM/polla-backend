const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const QRCode = require('qrcode');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'assets', 'Bono_template.png');

// Tamaño real de la plantilla (1191×896 px)
const ANCHO = 1191;
const ALTO  = 896;

// --- Coordenadas calibradas para la plantilla "Bono Digital" negra/amarilla ---
// Valor numérico: va dentro del espacio "VÁLIDO POR $(  )" de la plantilla
const COORD = {
    valor:  { x: 650, y: 452, fontSize: 88, color: '#ffffff' },
    // Nombre: alineado a la izquierda (anchor=start) justo después del "PARA:" impreso
    nombre: { x: 395, y: 830, fontSize: 38, color: '#1a1a1a' },
    // Valor pagado: debajo del valor recibido (mismo x, centrado), por debajo del
    // texto fijo "en servicios" que ya imprime la plantilla, en letra pequeña
    // (similar al nombre) para que el cliente note el extra que recibe.
    valorPagadoNumeros: { x: 650, y: 590, fontSize: 32, color: '#ffffff' },
    valorPagadoLetras:  { x: 650, y: 624, fontSize: 22, color: '#ffffff' },
};

// Código QR: centrado dentro del recuadro blanco vacío impreso en la plantilla
// (medido con sharp: x 928-1118, y 290-485)
const QR = { x: 936, y: 298, size: 174, padding: 8 };

// La plantilla trae impreso de fábrica "...nuestras sedes en Barranquilla y
// Cartagena" en el cartel amarillo (ya no abrimos en Cartagena). Como es arte
// fijo del PNG, se tapa solo la segunda línea ("Barranquilla y Cartagena",
// medida con sharp: banda de texto y 775-792 dentro del cartel x 269-942) con
// un rectángulo del mismo amarillo y se reescribe solo "Barranquilla".
const SEDES_COBERTURA = { x: 269, y: 772, width: 674, height: 26, fill: '#F5BB00' };
const SEDES_TEXTO = { x: 606, y: 791, fontSize: 26, color: '#1a1a1a' };

// Lo mismo pasa con el pie de página inferior ("*Válido hasta... / sedes en
// barranquilla y cartagena"): se tapa la línea completa y se reescribe sin
// Cartagena (medida con sharp: banda x 190-1015, y 867-890).
const FOOTER_COBERTURA = { x: 190, y: 867, width: 825, height: 23, fill: '#F5BB00' };
const FOOTER_TEXTO = { x: 602, y: 884, fontSize: 17, color: '#1a1a1a' };

// Franja legal extra al final del bono (condiciones de canje). La plantilla
// no trae espacio para esto, así que se alarga el lienzo hacia abajo
// continuando el mismo amarillo del pie de página, en vez de apretar el
// texto existente.
const LEGAL_EXTRA_ALTO = 56;
const LEGAL_FONDO = { r: 244, g: 188, b: 3, alpha: 1 };
const LEGAL_LINEA_1 = { y: 22, fontSize: 16, texto: 'Bono no canjeable por efectivo · No transferible · Canje único.' };
const LEGAL_LINEA_2 = { y: 42, fontSize: 16, texto: 'Vencido el plazo o redimido el saldo, el restante se pierde sin derecho a reclamo ni reactivación.' };

/**
 * Genera (si no existe) un template placeholder para el bono.
 */
async function asegurarTemplate() {
    if (fs.existsSync(TEMPLATE_PATH)) return;

    const placeholderSvg = `
    <svg width="${ANCHO}" height="${ALTO}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#fde047"/>
        <rect x="20" y="20" width="${ANCHO - 40}" height="${ALTO - 40}" fill="none" stroke="#18181b" stroke-width="8"/>
        <text x="${ANCHO / 2}" y="120" font-family="Arial" font-size="60" font-weight="bold" fill="#18181b" text-anchor="middle">LA RETOUCHERIE DE MANUELA</text>
        <text x="${ANCHO / 2}" y="190" font-family="Arial" font-size="36" fill="#18181b" text-anchor="middle">BONO DIGITAL - POLLA MUNDIALISTA</text>
    </svg>`;

    await sharp(Buffer.from(placeholderSvg)).jpeg({ quality: 90 }).toFile(TEMPLATE_PATH);
}

/**
 * Genera la imagen del bono (PNG) con el valor, el nombre del cliente y un código QR
 * (token de acceso) incrustados. El QR lo escanea el local para marcar el bono como usado.
 * @param {{ nombre: string, saldoBono: number, valorPagado?: number, tokenAcceso: string, esTest?: boolean, esEspecial?: boolean }} datos
 * @returns {Promise<Buffer>}
 */
async function generarImagenBono({ nombre, saldoBono, valorPagado, tokenAcceso, esTest, esEspecial, esRegalo, nombreDonante }) {
    await asegurarTemplate();

    // La plantilla ya imprime el símbolo "$" y los paréntesis "(VALOR)", solo se reemplaza el número
    const valorFormateado = saldoBono.toLocaleString('es-CO');

    // Para bonos regalados el nombre va más pequeño (comparte espacio con la línea del donante)
    const nombreFontSize = esRegalo
        ? (nombre.length > 28 ? 24 : 30)
        : (nombre.length > 30 ? 28 : nombre.length > 22 ? 34 : COORD.nombre.fontSize);

    // "Valor pagado" debajo del valor recibido, en números y en letras, para que el
    // cliente note el extra que le estamos dando sobre lo que pagó. Solo se imprime
    // si se conoce el valor pagado (siempre debería conocerse, pero por seguridad
    // se omite si no llega).
    const valorPagadoSvg = (valorPagado != null) ? `
        <text x="${COORD.valorPagadoNumeros.x}" y="${COORD.valorPagadoNumeros.y}" font-family="Arial" font-size="${COORD.valorPagadoNumeros.fontSize}" font-weight="bold" fill="${COORD.valorPagadoNumeros.color}" text-anchor="middle">Valor pagado: $${valorPagado.toLocaleString('es-CO')}</text>
        <text x="${COORD.valorPagadoLetras.x}" y="${COORD.valorPagadoLetras.y}" font-family="Arial" font-size="${COORD.valorPagadoLetras.fontSize}" fill="${COORD.valorPagadoLetras.color}" text-anchor="middle">(${capitalizar(numeroATexto(valorPagado))} pesos)</text>
    ` : '';

    const overlaySvg = `
    <svg width="${ANCHO}" height="${ALTO}" xmlns="http://www.w3.org/2000/svg">
        <text x="${COORD.valor.x}" y="${COORD.valor.y}" font-family="Georgia, 'Times New Roman', serif" font-size="${COORD.valor.fontSize}" font-weight="bold" fill="${COORD.valor.color}" text-anchor="middle">${valorFormateado}</text>
        ${valorPagadoSvg}
        <rect x="${SEDES_COBERTURA.x}" y="${SEDES_COBERTURA.y}" width="${SEDES_COBERTURA.width}" height="${SEDES_COBERTURA.height}" fill="${SEDES_COBERTURA.fill}"/>
        <text x="${SEDES_TEXTO.x}" y="${SEDES_TEXTO.y}" font-family="Arial" font-size="${SEDES_TEXTO.fontSize}" font-weight="bold" fill="${SEDES_TEXTO.color}" text-anchor="middle">Barranquilla</text>
        <rect x="${FOOTER_COBERTURA.x}" y="${FOOTER_COBERTURA.y}" width="${FOOTER_COBERTURA.width}" height="${FOOTER_COBERTURA.height}" fill="${FOOTER_COBERTURA.fill}"/>
        <text x="${FOOTER_TEXTO.x}" y="${FOOTER_TEXTO.y}" font-family="Arial" font-size="${FOOTER_TEXTO.fontSize}" fill="${FOOTER_TEXTO.color}" text-anchor="middle">*Válido hasta el 1 de Marzo de 2027 / sedes en barranquilla</text>
        ${esRegalo && nombreDonante ? `<text x="${COORD.nombre.x}" y="${COORD.nombre.y - 40}" font-family="Arial" font-size="19" fill="#666666" text-anchor="start">Regalado por: ${escapeXml(nombreDonante)}</text>` : ''}
        <text x="${COORD.nombre.x}" y="${COORD.nombre.y}" font-family="Arial" font-size="${nombreFontSize}" font-weight="bold" fill="${COORD.nombre.color}" text-anchor="start">${escapeXml(nombre)}</text>
        ${esTest ? `
        <g transform="rotate(-25 ${ANCHO / 2} ${ALTO / 2})">
            <rect x="${ANCHO / 2 - 520}" y="${ALTO / 2 - 70}" width="1040" height="140" fill="#dc2626" opacity="0.85"/>
            <text x="${ANCHO / 2}" y="${ALTO / 2 + 30}" font-family="Arial" font-size="90" font-weight="bold" fill="#ffffff" text-anchor="middle">PRUEBA - NO VÁLIDO</text>
        </g>` : ''}
        ${esEspecial ? `
        <g transform="rotate(-8 250 90)">
            <rect x="40" y="50" width="420" height="80" rx="14" fill="#FCD116" stroke="#1a1a1a" stroke-width="3"/>
            <text x="250" y="102" font-family="Arial" font-size="40" font-weight="bold" fill="#1a1a1a" text-anchor="middle">🎖️ BONO ESPECIAL</text>
        </g>` : ''}
    </svg>`;

    const composite = [{ input: Buffer.from(overlaySvg), top: 0, left: 0 }];

    if (tokenAcceso) {
        const qrContenido = process.env.FRONTEND_URL
            ? `${process.env.FRONTEND_URL}/adminqr?token=${tokenAcceso}`
            : tokenAcceso;
        const qrBuffer = await QRCode.toBuffer(qrContenido, {
            type: 'png',
            width: QR.size - QR.padding * 2,
            margin: 0,
            color: { dark: '#1a1a1a', light: '#ffffff' },
        });

        // Fondo blanco con borde para que el QR resalte sobre la plantilla
        const fondoQrSvg = `
        <svg width="${QR.size}" height="${QR.size}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" rx="12" fill="#ffffff" stroke="#1a1a1a" stroke-width="2"/>
        </svg>`;

        composite.push({ input: Buffer.from(fondoQrSvg), top: QR.y, left: QR.x });
        composite.push({ input: qrBuffer, top: QR.y + QR.padding, left: QR.x + QR.padding });
    }

    const baseBuffer = await sharp(TEMPLATE_PATH)
        .resize(ANCHO, ALTO)
        .composite(composite)
        .png()
        .toBuffer();

    // Franja legal final: continúa el amarillo del pie de página hacia abajo
    // para no apretar el texto existente ni tapar nada de la plantilla.
    const legalSvg = `
    <svg width="${ANCHO}" height="${LEGAL_EXTRA_ALTO}" xmlns="http://www.w3.org/2000/svg">
        <text x="${ANCHO / 2}" y="${LEGAL_LINEA_1.y}" font-family="Arial" font-size="${LEGAL_LINEA_1.fontSize}" fill="#1a1a1a" text-anchor="middle">${LEGAL_LINEA_1.texto}</text>
        <text x="${ANCHO / 2}" y="${LEGAL_LINEA_2.y}" font-family="Arial" font-size="${LEGAL_LINEA_2.fontSize}" fill="#1a1a1a" text-anchor="middle">${LEGAL_LINEA_2.texto}</text>
    </svg>`;

    const buffer = await sharp(baseBuffer)
        .extend({ bottom: LEGAL_EXTRA_ALTO, background: LEGAL_FONDO })
        .composite([{ input: Buffer.from(legalSvg), top: ALTO, left: 0 }])
        .png()
        .toBuffer();

    return buffer;
}

// --- Conversor de números a letras en español (para "Valor pagado" en el bono) ---
const UNIDADES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'];
const DIECIS = ['diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve'];
const VEINTIS = ['veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

// Convierte 0-99 a texto. `apocope` cambia "uno"→"un" y "veintiuno"→"veintiún"
// (se usa cuando el número antecede a "mil" o "millones").
function decenasATexto(n, apocope) {
    if (n < 10) return apocope && n === 1 ? 'un' : UNIDADES[n];
    if (n < 20) return DIECIS[n - 10];
    if (n < 30) return apocope && n === 21 ? 'veintiún' : VEINTIS[n - 20];
    const d = Math.floor(n / 10);
    const u = n % 10;
    if (u === 0) return DECENAS[d];
    return `${DECENAS[d]} y ${apocope && u === 1 ? 'un' : UNIDADES[u]}`;
}

// Convierte 0-999 a texto.
function centenasATexto(n, apocope) {
    if (n === 0) return '';
    if (n === 100) return 'cien';
    const c = Math.floor(n / 100);
    const resto = n % 100;
    const textoCentena = c > 0 ? CENTENAS[c] : '';
    const textoResto = resto > 0 ? decenasATexto(resto, apocope) : '';
    return [textoCentena, textoResto].filter(Boolean).join(' ');
}

// Convierte un entero no negativo (0 a 999.999.999) a su escritura en palabras.
function numeroATexto(numero) {
    const n = Math.round(Number(numero) || 0);
    if (n === 0) return 'cero';

    const millones = Math.floor(n / 1000000);
    const miles = Math.floor((n % 1000000) / 1000);
    const resto = n % 1000;

    const partes = [];
    if (millones > 0) {
        partes.push(millones === 1 ? 'un millón' : `${centenasATexto(millones, true)} millones`);
    }
    if (miles > 0) {
        partes.push(miles === 1 ? 'mil' : `${centenasATexto(miles, true)} mil`);
    }
    if (resto > 0) {
        partes.push(centenasATexto(resto, false));
    }
    return partes.join(' ');
}

function capitalizar(texto) {
    return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function escapeXml(text) {
    return String(text).replace(/[<>&'"]/g, (c) => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
    }[c]));
}

module.exports = { generarImagenBono };
