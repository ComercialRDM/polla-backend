// Ejecuta `tarea` sobre cada elemento de `items` con un máximo de `concurrencia`
// en simultáneo (en vez de await secuencial uno por uno, o Promise.all sin
// límite que podría saturar la API externa de golpe).
async function ejecutarConConcurrencia(items, tarea, concurrencia = 20) {
    let indice = 0;

    async function trabajador() {
        while (indice < items.length) {
            const i = indice++;
            await tarea(items[i], i);
        }
    }

    const trabajadores = Array.from({ length: Math.min(concurrencia, items.length) }, trabajador);
    await Promise.all(trabajadores);
}

module.exports = { ejecutarConConcurrencia };
