const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'assets', 'bono_template.jpg');

// Tamaño del template (placeholder generado si no existe el archivo)
const ANCHO = 1748;
const ALTO = 1240;

// --- Coordenadas fácilmente calibrables del overlay ---
// Calibradas para la plantilla "Bono Digital" (placeholders "$(VALOR)" y "(nombre)")
const COORD = {
    valor: { x: 890, y: 704, fontSize: 140, color: '#1a1a1a' },
    nombre: { x: 900, y: 1076, fontSize: 45, color: '#1a1a1a' },
};

// Rectángulos para tapar el texto placeholder de la plantilla antes de escribir el valor real
const COVER = {
    valor: { x: 480, y: 545, w: 820, h: 220, color: '#F3EAE1' },
    nombre: { x: 700, y: 1035, w: 400, h: 50, color: '#FEE580' },
};

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
 * Genera la imagen del bono (PNG) con el valor y el nombre del cliente incrustados.
 * @param {{ nombre: string, saldoBono: number }} datos
 * @returns {Promise<Buffer>}
 */
async function generarImagenBono({ nombre, saldoBono }) {
    await asegurarTemplate();

    // La plantilla ya imprime el símbolo "$" y los paréntesis "(VALOR)", solo se reemplaza el número
    const valorFormateado = saldoBono.toLocaleString('es-CO');

    // Reduce el tamaño de letra del nombre si es muy largo para que no se salga del recuadro
    const nombreFontSize = nombre.length > 22 ? 32 : COORD.nombre.fontSize;

    const overlaySvg = `
    <svg width="${ANCHO}" height="${ALTO}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${COVER.valor.x}" y="${COVER.valor.y}" width="${COVER.valor.w}" height="${COVER.valor.h}" fill="${COVER.valor.color}"/>
        <rect x="${COVER.nombre.x}" y="${COVER.nombre.y}" width="${COVER.nombre.w}" height="${COVER.nombre.h}" fill="${COVER.nombre.color}"/>
        <text x="${COORD.valor.x}" y="${COORD.valor.y}" font-family="Georgia, 'Times New Roman', serif" font-size="${COORD.valor.fontSize}" font-weight="bold" fill="${COORD.valor.color}" text-anchor="middle">${valorFormateado}</text>
        <text x="${COORD.nombre.x}" y="${COORD.nombre.y}" font-family="Arial" font-size="${nombreFontSize}" font-weight="bold" fill="${COORD.nombre.color}" text-anchor="middle">${escapeXml(nombre)}</text>
    </svg>`;

    const buffer = await sharp(TEMPLATE_PATH)
        .resize(ANCHO, ALTO)
        .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
        .png()
        .toBuffer();

    return buffer;
}

function escapeXml(text) {
    return String(text).replace(/[<>&'"]/g, (c) => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
    }[c]));
}

module.exports = { generarImagenBono };
