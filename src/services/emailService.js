const nodemailer = require('nodemailer');

// Copia de control: el negocio quiere ver cada correo que sale a un cliente.
// Deliberadamente NO se aplica a los de recuperacion de contraseña (llevan un
// codigo/clave sensible) ni a los que ya van dirigidos al propio correo admin
// (notificacion de voto, backup) -- ahi copiarse a si mismo no aporta nada.
const BCC_COMERCIAL = process.env.BCC_COMERCIAL || 'comercial@retoucherie.com.co';

function crearTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
}

/**
 * Envía el correo con el bono adjunto, intentos disponibles y link de acceso a la polla.
 * @param {{ destinatario: string, nombre: string, saldoBono: number, intentos: number, tokenAcceso: string, bonoBuffer: Buffer, esTest?: boolean, esEspecial?: boolean }} datos
 */
async function enviarCorreoBono({ destinatario, nombre, saldoBono, intentos, tokenAcceso, bonoBuffer, esTest, esEspecial }) {
    const transporter = crearTransporter();
    const linkPolla = `${process.env.FRONTEND_URL}/polla?token=${tokenAcceso}`;

    const bannerTest = esTest
        ? `<div style="background: #fee2e2; color: #991b1b; font-weight: bold; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; text-align: center;">
               🧪 ESTE ES UN BONO DE PRUEBA — No representa dinero real y no es válido para redimir en tienda.
           </div>`
        : esEspecial
        ? `<div style="background: #fef3c7; color: #92400e; font-weight: bold; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; text-align: center;">
               🎖️ BONO ESPECIAL — Gracias por ser creador de contenido de La Retoucherie. Este bono SÍ es válido para redimir en tienda.
           </div>`
        : '';

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        ${bannerTest}
        <h1 style="color: #f59e0b;">¡Gracias por tu compra, ${nombre}!</h1>
        <p>Has recibido tu <strong>Bono Digital</strong> de <strong>$${saldoBono.toLocaleString('es-CO')}</strong> para servicios de La Retoucherie de Manuela.</p>
        <p>Además, ya quedaste inscrita en la <strong>Polla Mundialista</strong> con <strong>${intentos}</strong> intento(s) para predecir el marcador.</p>
        <p style="text-align: center; margin: 30px 0;">
            <a href="${linkPolla}" style="background: linear-gradient(90deg, #f59e0b, #f97316); color: #18181b; font-weight: bold; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block;">
                Ir a la Polla
            </a>
        </p>
        <p style="font-size: 12px; color: #71717a;">Si el botón no funciona, copia y pega este link en tu navegador: ${linkPolla}</p>
        <p>¡Mucha suerte! 🇨🇴</p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        bcc: BCC_COMERCIAL,
        subject: esTest
            ? '🧪 [PRUEBA] Tu Bono Digital y acceso a la Polla Mundialista'
            : esEspecial
            ? '🎖️ Tu Bono Especial de Creador de Contenido'
            : '¡Tu Bono Digital y acceso a la Polla Mundialista! 🇨🇴',
        html,
        attachments: [
            {
                filename: 'bono-retoucherie.png',
                content: bonoBuffer,
                contentType: 'image/png',
            },
        ],
    });
}

/**
 * Notifica al administrador el pronóstico que un usuario acaba de registrar.
 * @param {{ nombre: string, correo: string, equipoLocal: string, equipoVisitante: string, local: number, visitante: number, fecha: Date }} datos
 */
async function enviarCorreoNotificacionVoto({ nombre, correo, equipoLocal, equipoVisitante, local, visitante, fecha }) {
    const transporter = crearTransporter();
    const destinatario = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
    const fechaTexto = fecha.toLocaleString('es-CO', { timeZone: 'America/Bogota' });

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h2 style="color: #f59e0b;">Nuevo pronóstico registrado</h2>
        <p><strong>${nombre}</strong> (${correo}) registró el siguiente pronóstico para <strong>${equipoLocal} vs ${equipoVisitante}</strong>:</p>
        <ul><li>${equipoLocal} ${local} - ${visitante} ${equipoVisitante}</li></ul>
        <p>Fecha y hora (Colombia): <strong>${fechaTexto}</strong></p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        subject: `Nuevo pronóstico: ${equipoLocal} vs ${equipoVisitante} - ${nombre}`,
        html,
    });
}

/**
 * Notifica a un participante de un partido anterior que ya puede comprar su bono
 * para el siguiente partido de la Selección Colombia.
 * @param {{ destinatario: string, nombre: string, equipoLocal: string, equipoVisitante: string, linkCompra: string }} datos
 */
async function enviarCorreoRecompra({ destinatario, nombre, equipoLocal, equipoVisitante, linkCompra, unsubscribeUrl }) {
    const transporter = crearTransporter();

    const unsub = unsubscribeUrl
        ? `<p style="font-size: 11px; color: #a1a1aa; text-align: center; margin-top: 24px;">
               ¿No deseas recibir más correos? <a href="${unsubscribeUrl}" style="color: #a1a1aa;">Cancelar suscripción</a>
           </p>`
        : '';

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h1 style="color: #f59e0b;">¡${nombre}, llegó el siguiente partido de Colombia! 🇨🇴</h1>
        <p><strong>${equipoLocal} vs ${equipoVisitante}</strong> ya está disponible en la Polla Mundialista de La Retoucherie de Manuela.</p>
        <p>Compra tu nuevo Bono Digital, recibe saldo para tus servicios de belleza y participa prediciendo el marcador para ganar premios.</p>
        <p style="text-align: center; margin: 30px 0;">
            <a href="${linkCompra}" style="background: linear-gradient(90deg, #f59e0b, #f97316); color: #18181b; font-weight: bold; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block;">
                Comprar mi bono
            </a>
        </p>
        <p style="font-size: 12px; color: #71717a;">Si el botón no funciona, copia y pega este link en tu navegador: ${linkCompra}</p>
        ${unsub}
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        bcc: BCC_COMERCIAL,
        subject: `¡${equipoLocal} vs ${equipoVisitante}! Compra tu bono y participa 🇨🇴`,
        html,
    });
}

/**
 * Correo personalizado al cerrar un partido: le cuenta a cada participante su
 * propio resultado (en vez del aviso genérico de "inicio de partido"/"gol" que
 * antes se mandaba por WhatsApp) y lo invita a comprar más cupos — reemplaza
 * esas notificaciones con algo que sí motiva la recompra, a costo de correo
 * (casi gratis) en vez de SMS (caro a esta escala).
 * @param {{ destinatario: string, nombre: string, equipoLocal: string, equipoVisitante: string, golesLocal: number, golesVisitante: number, prediccionLocal: number, prediccionVisitante: number, puntosGanados: number, cuposDisponibles: number, proximoPartido?: { equipoLocal: string, equipoVisitante: string }, linkCompra: string }} datos
 */
async function enviarCorreoResultadoPartido({
    destinatario, nombre, equipoLocal, equipoVisitante, golesLocal, golesVisitante,
    prediccionLocal, prediccionVisitante, puntosGanados, cuposDisponibles, proximoPartido, linkCompra,
}) {
    const transporter = crearTransporter();

    const acertoExacto = puntosGanados > 0 && prediccionLocal === golesLocal && prediccionVisitante === golesVisitante;
    const resultadoTexto = puntosGanados === 0
        ? 'Esta vez no acertaste, ¡pero el Mundial sigue!'
        : acertoExacto
            ? `¡Le pegaste exacto y ganaste ${puntosGanados} puntos! 🎯`
            : `Acertaste la tendencia y ganaste ${puntosGanados} puntos.`;

    const proximoHtml = proximoPartido
        ? `<p><strong>${proximoPartido.equipoLocal} vs ${proximoPartido.equipoVisitante}</strong> es el siguiente partido disponible en la Polla.</p>`
        : '';

    const cuposHtml = cuposDisponibles > 0
        ? `<p>Todavía te quedan <strong>${cuposDisponibles} cupo(s)</strong> sin usar para seguir pronosticando.</p>`
        : `<p>Ya usaste todos tus cupos — compra un nuevo bono para seguir participando.</p>`;

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h1 style="color: #f59e0b;">${equipoLocal} ${golesLocal} - ${golesVisitante} ${equipoVisitante}</h1>
        <p>Hola ${nombre}, tu pronóstico fue <strong>${prediccionLocal} - ${prediccionVisitante}</strong>. ${resultadoTexto}</p>
        ${cuposHtml}
        ${proximoHtml}
        <p style="text-align: center; margin: 30px 0;">
            <a href="${linkCompra}" style="background: linear-gradient(90deg, #f59e0b, #f97316); color: #18181b; font-weight: bold; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block;">
                Comprar mi bono
            </a>
        </p>
        <p style="font-size: 12px; color: #71717a;">Si el botón no funciona, copia y pega este link en tu navegador: ${linkCompra}</p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        bcc: BCC_COMERCIAL,
        subject: `${equipoLocal} ${golesLocal}-${golesVisitante} ${equipoVisitante} — así te fue en la Polla`,
        html,
    });
}

/**
 * Envía el respaldo periódico de la base de datos (JSON comprimido) al correo
 * del administrador.
 * @param {{ destinatario: string, filename: string, buffer: Buffer, resumen: Record<string, number> }} datos
 */
async function enviarCorreoBackup({ destinatario, filename, buffer, resumen }) {
    const transporter = crearTransporter();
    const fechaTexto = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

    const filas = Object.entries(resumen)
        .map(([tabla, cantidad]) => `<li>${tabla}: ${cantidad} fila(s)</li>`)
        .join('');

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h2 style="color: #f59e0b;">Respaldo automático de la base de datos</h2>
        <p>Generado: <strong>${fechaTexto}</strong> (Colombia)</p>
        <ul>${filas}</ul>
        <p>Adjunto encontrarás el archivo <strong>${filename}</strong> con el contenido completo (JSON comprimido).</p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        subject: `Respaldo Polla Mundialista - ${fechaTexto}`,
        html,
        attachments: [
            {
                filename,
                content: buffer,
                contentType: 'application/gzip',
            },
        ],
    });
}

/**
 * Envía el código OTP de recuperación de contraseña al correo del usuario.
 */
async function enviarCorreoResetPassword({ destinatario, nombre, codigo, vigenciaMin }) {
    const transporter = crearTransporter();

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h1 style="color: #FCD116;">🔐 Recuperar contraseña</h1>
        <p>Hola <strong>${nombre}</strong>,</p>
        <p>Tu código para reestablecer la contraseña de la <strong>Polla Mundialista de La Retoucherie</strong> es:</p>
        <div style="text-align: center; margin: 30px 0;">
            <span style="font-size: 40px; font-weight: bold; letter-spacing: 12px; color: #18181b; background: #FCD116; padding: 16px 32px; border-radius: 12px;">
                ${codigo}
            </span>
        </div>
        <p>Este código vence en <strong>${vigenciaMin} minutos</strong>. Si no solicitaste este cambio, ignora este correo.</p>
        <p style="font-size: 12px; color: #71717a; margin-top: 24px;">La Retoucherie de Manuela · GanaConRetoucherie</p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        subject: `${codigo} — Tu código de recuperación · La Retoucherie`,
        html,
    });
}

/**
 * Notifica a un ganador del Bono Colombia $1M que acertó el marcador exacto.
 */
async function enviarCorreoBonoColWinner({ destinatario, nombre, partido, monto }) {
    const transporter = crearTransporter();

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h1 style="color: #FCD116;">🇨🇴 ¡Felicitaciones, ${nombre}!</h1>
        <p>Acertaste el <strong>marcador exacto</strong> del partido <strong>${partido}</strong>.</p>
        <p>¡Has ganado el <strong>Bono Colombia</strong> por valor de
           <strong style="color: #f59e0b;">$${monto.toLocaleString('es-CO')} COP</strong>
           en Gift Card!</p>
        <p>Nuestro equipo se comunicará contigo a la brevedad para coordinar la entrega.
           Recuerda tener a mano tu documento de identidad.</p>
        <p style="font-size: 12px; color: #71717a; margin-top: 24px;">
            La Retoucherie de Manuela · GanaConRetoucherie
        </p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        bcc: BCC_COMERCIAL,
        subject: '🇨🇴 ¡Ganaste el Bono Colombia! — La Retoucherie',
        html,
    });
}

/**
 * Envía una contraseña temporal a la cuenta de un local (Admin QR).
 */
async function enviarCorreoResetLocalPassword({ destinatario, nombre, tempPass }) {
    const transporter = crearTransporter();

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h1 style="color: #FCD116;">🔑 Contraseña temporal — Admin QR</h1>
        <p>Hola <strong>${nombre || 'Administrador'}</strong>,</p>
        <p>Se ha generado una contraseña temporal para tu cuenta de <strong>Admin QR</strong> en La Retoucherie de Manuela:</p>
        <div style="text-align: center; margin: 30px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #18181b; background: #FCD116; padding: 16px 32px; border-radius: 12px; font-family: monospace;">
                ${tempPass}
            </span>
        </div>
        <p>Usa esta contraseña para ingresar. Por seguridad, pídele al administrador que la actualice pronto.</p>
        <p style="font-size: 12px; color: #71717a; margin-top: 24px;">La Retoucherie de Manuela · Admin QR</p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        subject: `🔑 Tu contraseña temporal — Admin QR La Retoucherie`,
        html,
    });
}

/**
 * Envía el standup o cierre del día del Growth Checklist a comercial@retoucherie.com.co.
 */
async function enviarCorreoChecklist({ tipo, fecha, contenido, usuario }) {
    const transporter = crearTransporter();
    const tipoLabel = tipo === 'standup' ? 'Standup' : 'Cierre del día';
    const asunto = `[Checklist Diario] ${tipoLabel} - ${fecha}`;
    const contenidoHtml = contenido
        .split('\n')
        .map((l) => `<p style="margin:4px 0;">${l || '&nbsp;'}</p>`)
        .join('');

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h2 style="color: #f59e0b;">${tipoLabel} — ${fecha}</h2>
        <p style="color: #71717a; font-size: 13px;">Enviado por <strong>${usuario}</strong></p>
        <div style="background: #f4f4f5; border-radius: 8px; padding: 16px 20px; margin-top: 16px; white-space: pre-wrap; line-height: 1.6;">
            ${contenidoHtml}
        </div>
        <p style="font-size: 11px; color: #a1a1aa; margin-top: 24px;">Growth Checklist · La Retoucherie de Manuela</p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: BCC_COMERCIAL,
        subject: asunto,
        html,
    });
}

/**
 * Envía un código OTP de 6 dígitos al correo del usuario para login sin contraseña.
 */
async function enviarCorreoOTP({ destinatario, codigo }) {
    const transporter = crearTransporter();

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h1 style="color: #FCD116;">🔐 Tu código de ingreso</h1>
        <p>Usa este código para ingresar a la <strong>Polla Mundialista de La Retoucherie</strong>:</p>
        <div style="text-align: center; margin: 30px 0;">
            <span style="font-size: 40px; font-weight: bold; letter-spacing: 12px; color: #18181b; background: #FCD116; padding: 16px 32px; border-radius: 12px;">
                ${codigo}
            </span>
        </div>
        <p>Este código vence en <strong>10 minutos</strong>. Si no solicitaste este código, ignora este correo.</p>
        <p style="font-size: 12px; color: #71717a; margin-top: 24px;">La Retoucherie de Manuela · GanaConRetoucherie</p>
    </div>`;

    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        subject: `${codigo} — Tu código de ingreso · La Retoucherie`,
        html,
    });
}

/**
 * Recuperación de acceso al panel (cualquier rol). Siempre va al correo de la
 * empresa: el dueño decide si reenvía el enlace a la persona.
 */
async function enviarCorreoRecuperacionAcceso({ destinatario, usuario, enlace, vigenciaMin, ip }) {
    const transporter = crearTransporter();
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        <h1 style="color: #f59e0b;">🔐 Recuperar acceso al panel</h1>
        <p>Se pidió restablecer la contraseña del usuario <strong>${usuario}</strong> en www.ganaconretoucherie.com.</p>
        <p>Si fuiste tú o lo autorizas, abre este enlace (o reenvíalo a la persona) para crear una contraseña nueva:</p>
        <p style="text-align: center; margin: 28px 0;">
            <a href="${enlace}" style="background: #f59e0b; color: #18181b; font-weight: bold; padding: 14px 28px; border-radius: 999px; text-decoration: none;">Crear contraseña nueva</a>
        </p>
        <p>El enlace vence en <strong>${vigenciaMin} minutos</strong> y sirve una sola vez. La verificación en dos pasos de la cuenta no cambia.</p>
        <p style="font-size: 12px; color: #71717a;">Solicitud desde la IP ${ip || 'desconocida'}. Si nadie lo pidió, ignora este correo: la contraseña actual sigue funcionando.</p>
    </div>`;
    await transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        subject: `Recuperar acceso del usuario ${usuario} · GanaConRetoucherie`,
        html,
    });
}

/**
 * Diagnóstico del correo saliente: qué variables hay (sin revelar valores),
 * si el servidor SMTP acepta la conexión y, opcionalmente, un envío de prueba.
 */
async function diagnosticarCorreo({ enviarA } = {}) {
    const vars = Object.fromEntries(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']
        .map((k) => [k, process.env[k] ? (k === 'SMTP_PASS' ? 'definida' : k === 'SMTP_USER' ? process.env[k].replace(/^(.{3}).*(@.*)$/, '$1•••$2') : process.env[k]) : 'FALTA']));
    const r = { variables: vars };
    try {
        await crearTransporter().verify();
        r.conexion = 'ok';
    } catch (err) {
        r.conexion = `error: ${err.code || ''} ${err.message}`.slice(0, 400);
    }
    if (enviarA) {
        try {
            const info = await crearTransporter().sendMail({
                from: process.env.MAIL_FROM, to: enviarA,
                subject: 'Prueba de correo · GanaConRetoucherie',
                html: '<p>Este es un correo de prueba del panel de www.ganaconretoucherie.com. Si lo recibes, el envío de correos funciona.</p>',
            });
            r.envio = { aceptado: info.accepted, rechazado: info.rejected, respuesta: String(info.response || '').slice(0, 200) };
        } catch (err) {
            r.envio = `error: ${err.code || ''} ${err.message}`.slice(0, 400);
        }
    }
    return r;
}

/**
 * Envía las boletas de la rifa iPhone 18 Pro por correo (clientes sin WhatsApp).
 * Adjunta cada boleta como imagen y trae botones para confirmar los datos.
 * Copia oculta a comercial@ salvo en la prueba (que ya va a ese correo).
 */
async function enviarCorreoBoletasRifa({ destinatario, nombre, numeros, facturas, adjuntos, linkOk, linkError, esPrueba }) {
    const transporter = crearTransporter();
    const lista = numeros.map((n) => `#${String(n).padStart(3, '0')}`).join(', ');
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #18181b;">
        ${esPrueba ? '<p style="background:#fef3c7;padding:8px 12px;border-radius:8px;font-size:12px;">🧪 PRUEBA — así le llegará el correo al cliente.</p>' : ''}
        <h1 style="color: #f59e0b; margin-bottom: 4px;">🎟️ Tus boletas para la rifa del iPhone 18 Pro</h1>
        <p>Hola <strong>${nombre}</strong>,</p>
        <p>Gracias por tu compra en <strong>La Retoucherie de Manuela</strong>. Tienes <strong>${numeros.length} boleta${numeros.length > 1 ? 's' : ''}</strong>
           para la rifa del iPhone 18 Pro: <strong>${lista}</strong> (factura ${facturas.join(', ')}).</p>
        <p>Las encuentras adjuntas a este correo. El sorteo se realizará el <strong>20 de diciembre de 2026</strong>.</p>
        <p style="margin-top: 24px;">¿Los datos de tus boletas (nombre, cédula, factura y sede) están correctos?</p>
        <p style="text-align: center; margin: 20px 0;">
            <a href="${linkOk}" style="background:#22c55e;color:#fff;font-weight:bold;padding:12px 22px;border-radius:999px;text-decoration:none;margin:4px;display:inline-block;">✅ Sí, están correctos</a>
            <a href="${linkError}" style="background:#ef4444;color:#fff;font-weight:bold;padding:12px 22px;border-radius:999px;text-decoration:none;margin:4px;display:inline-block;">❌ Hay un error</a>
        </p>
        <p style="font-size: 12px; color: #71717a;">Si tienes dudas, escríbenos por WhatsApp al +57 323 383 3253.<br>La Retoucherie de Manuela · www.ganaconretoucherie.com</p>
    </div>`;
    return transporter.sendMail({
        from: process.env.MAIL_FROM,
        to: destinatario,
        ...(esPrueba ? {} : { bcc: BCC_COMERCIAL }),
        subject: `${esPrueba ? '[PRUEBA] ' : ''}🎟️ Tus boletas ${lista} · Rifa iPhone 18 Pro · La Retoucherie`,
        html,
        attachments: adjuntos,
    });
}

module.exports = { enviarCorreoBoletasRifa, diagnosticarCorreo, enviarCorreoRecuperacionAcceso, enviarCorreoBono, enviarCorreoNotificacionVoto, enviarCorreoRecompra, enviarCorreoResultadoPartido, enviarCorreoBackup, enviarCorreoResetPassword, enviarCorreoBonoColWinner, enviarCorreoResetLocalPassword, enviarCorreoChecklist, enviarCorreoOTP };
