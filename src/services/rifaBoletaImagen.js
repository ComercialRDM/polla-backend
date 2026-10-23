const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

// Generador de la boleta de la rifa iPhone 18 Pro. Es el mismo diseño y las
// mismas coordenadas del generador original (rifa-iphone/generar_boletas.py),
// sobre la plantilla de 1536x1024.

const ASSETS = path.join(__dirname, '..', '..', 'assets', 'rifa');
GlobalFonts.registerFromPath(path.join(ASSETS, 'BebasNeue-Regular.ttf'), 'RifaBebas');
GlobalFonts.registerFromPath(path.join(ASSETS, 'Oswald-SemiBold.ttf'), 'RifaOswald');

const TINTA = 'rgb(24,24,27)';
const ROJO = 'rgb(220,20,30)';

const CAMPOS = {
    factura: [1001, 117, 1498, 161],
    nombre: [1001, 212, 1498, 261],
    cedula: [1001, 314, 1480, 361],
    celular: [1001, 545, 1484, 591],
};
const SEDES = {
    buenavista: [1002, 424, 1049, 474],
    viva: [1187, 424, 1234, 474],
    aranjuez: [1328, 425, 1375, 474],
};
const NUMEROS = [[1363, 47, 1498, 96], [1363, 678, 1491, 725]];

let plantilla = null;

function textoEnCaja(ctx, caja, texto, tamMax = 32, padding = 16) {
    const [x0, y0, x1, y1] = caja;
    const ancho = x1 - x0 - 2 * padding;
    let tam = tamMax;
    for (; tam > 14; tam -= 1) {
        ctx.font = `${tam}px RifaOswald`;
        if (ctx.measureText(texto).width <= ancho) break;
    }
    ctx.fillStyle = TINTA;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(texto, x0 + padding, (y0 + y1) / 2);
}

function marcarSede(ctx, caja) {
    const [x0, y0, x1, y1] = caja;
    const m = 11;
    ctx.strokeStyle = ROJO;
    ctx.lineWidth = 7;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(x0 + m, y0 + m); ctx.lineTo(x1 - m, y1 - m);
    ctx.moveTo(x0 + m, y1 - m); ctx.lineTo(x1 - m, y0 + m);
    ctx.stroke();
}

function numeroEnCaja(ctx, caja, numero) {
    const [x0, y0, x1, y1] = caja;
    // Tapa el número impreso en la plantilla.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(x0 + 3, y0 + 3, x1 - x0 - 6, y1 - y0 - 6, 6);
    ctx.fill();
    ctx.font = `${Math.round((y1 - y0) * 0.95)}px RifaBebas`;
    const pre = 'Nº ';
    const num = String(numero).padStart(3, '0');
    const w = ctx.measureText(pre).width + ctx.measureText(num).width;
    const x = (x0 + x1) / 2 - w / 2;
    const cy = (y0 + y1) / 2 + 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = TINTA;
    ctx.fillText(pre, x, cy);
    ctx.fillStyle = ROJO;
    ctx.fillText(num, x + ctx.measureText(pre).width, cy);
}

/**
 * @param {{ numero:number, factura:string, nombre:string, cedula:string, celular?:string, sede:string }} b
 * @returns {Promise<Buffer>} JPEG
 */
async function generarBoleta(b) {
    if (!plantilla) plantilla = await loadImage(path.join(ASSETS, 'boleta_plantilla.png'));
    const canvas = createCanvas(plantilla.width, plantilla.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(plantilla, 0, 0);
    for (const caja of NUMEROS) numeroEnCaja(ctx, caja, b.numero);
    textoEnCaja(ctx, CAMPOS.factura, String(b.factura));
    textoEnCaja(ctx, CAMPOS.nombre, String(b.nombre).toUpperCase());
    textoEnCaja(ctx, CAMPOS.cedula, String(b.cedula));
    textoEnCaja(ctx, CAMPOS.celular, String(b.celular || ''));
    const sede = SEDES[String(b.sede || '').trim().toLowerCase()];
    if (sede) marcarSede(ctx, sede);
    return canvas.encode('jpeg', 90);
}

module.exports = { generarBoleta };
