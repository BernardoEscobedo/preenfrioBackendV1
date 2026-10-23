import { aFechaISO, esFechaFutura, hoyISO, sumarDiasISO } from "../utils/fechas.js";

// ============================================================================
// VALIDACIONES DE MANTENIMIENTOS
// ============================================================================
// Aquí se valida el FORMATO. Lo que exige consultar la BD —que no haya otro
// mantenimiento activo en la cámara, qué fruta hay dentro, si la transición
// de estado es válida— vive en el controller.
//
//   tipo       1 Preventivo · 2 Correctivo · 3 Emergencia
//   prioridad  1 Alta · 2 Media · 3 Baja
//
// v3
//   · observaciones (técnico, proveedor, detalle) hasta 500 caracteres
//   · comentario de cierre al finalizar/cancelar, hasta 500
//   · Un mantenimiento "en proceso" no puede empezar en el futuro, ni
//     siquiera más tarde el mismo día: el trigger bloquea al instante. Se
//     compara contra la hora local de operación (ZONA_HORARIA).
// ============================================================================

const TIPOS_VALIDOS = [1, 2, 3];
const PRIORIDADES_VALIDAS = [1, 2, 3];
const ESTADOS_AL_CREAR = [1, 2]; // 1 Programado · 2 En proceso

const REGEX_HORA = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

const zona = () => process.env.ZONA_HORARIA || "America/Mexico_City";

/** 'AAAA-MM-DDTHH:MM' de ahora en la zona de operación */
const ahoraLocal = () =>
    new Date().toLocaleString("sv-SE", { timeZone: zona() }).slice(0, 16).replace(" ", "T");

const leerObservaciones = (v, campo = "observaciones") => {
    if (v === undefined || v === null || String(v).trim() === "") return { valor: null };
    const t = String(v).trim();
    if (t.length > 500) return { error: `El campo "${campo}" no puede exceder 500 caracteres` };
    return { valor: t };
};

export const validarMantenimiento = (req, res, next) => {
    const {
        id_camara,
        fecha_inicio,
        hora_inicio,
        tipo,
        motivo,
        prioridad,
        estado,
        observaciones
    } = req.body;

    // ---- Cámara ----
    if (!id_camara || isNaN(Number(id_camara))) {
        return res.status(400).json({ error: 'El campo "id_camara" es obligatorio y debe ser numérico' });
    }

    // ---- Fecha de inicio ----
    if (!fecha_inicio) {
        return res.status(400).json({ error: 'El campo "fecha_inicio" es obligatorio' });
    }
    const fecha = aFechaISO(fecha_inicio);
    if (!fecha) {
        return res.status(400).json({ error: 'El campo "fecha_inicio" no es una fecha válida (usa AAAA-MM-DD)' });
    }
    // Los preventivos se agendan con anticipación. El tope de 180 días
    // atrapa el error de dedo en el año.
    if (fecha > sumarDiasISO(hoyISO(), 180)) {
        return res.status(400).json({ error: "La fecha de inicio está a más de 180 días: revisa el dato" });
    }

    // ---- Hora de inicio ----
    if (!hora_inicio || !REGEX_HORA.test(String(hora_inicio))) {
        return res.status(400).json({ error: 'El campo "hora_inicio" es obligatorio (formato HH:MM)' });
    }

    // ---- Tipo ----
    if (!tipo || !TIPOS_VALIDOS.includes(Number(tipo))) {
        return res.status(400).json({
            error: 'El campo "tipo" debe ser 1 (preventivo), 2 (correctivo) o 3 (emergencia)'
        });
    }

    // ---- Motivo ----
    // VARCHAR(60): es lo que se lee cuando se pregunta por qué la cámara no
    // recibe fruta. El detalle va en observaciones.
    if (!motivo || typeof motivo !== "string" || motivo.trim().length < 5) {
        return res.status(400).json({
            error: 'El campo "motivo" es obligatorio y debe tener al menos 5 caracteres'
        });
    }
    if (motivo.trim().length > 60) {
        return res.status(400).json({
            error: 'El campo "motivo" no puede exceder 60 caracteres: el detalle va en observaciones'
        });
    }

    // ---- Prioridad ----
    if (!prioridad || !PRIORIDADES_VALIDAS.includes(Number(prioridad))) {
        return res.status(400).json({ error: 'El campo "prioridad" debe ser 1 (alta), 2 (media) o 3 (baja)' });
    }

    // ---- Estado ----
    const estadoNum = estado === undefined || estado === null ? 1 : Number(estado);
    if (!ESTADOS_AL_CREAR.includes(estadoNum)) {
        return res.status(400).json({
            error: 'El campo "estado" al crear debe ser 1 (programado) o 2 (en proceso)'
        });
    }

    // Un paro "en proceso" que empieza en el futuro bloquearía la cámara
    // desde ahora: el trigger reacciona al estado, no a la fecha.
    const inicio = `${fecha}T${String(hora_inicio).slice(0, 5)}`;
    if (estadoNum === 2 && (esFechaFutura(fecha) || inicio > ahoraLocal())) {
        return res.status(400).json({
            error: "La falla no puede registrarse con una hora futura. Si es un mantenimiento a futuro, prográmalo como preventivo."
        });
    }

    // ---- Observaciones ----
    const obs = leerObservaciones(observaciones);
    if (obs.error) return res.status(400).json({ error: obs.error });

    // ---- Normalización ----
    req.body.id_camara = Number(id_camara);
    req.body.fecha_inicio = fecha;
    req.body.tipo = Number(tipo);
    req.body.prioridad = Number(prioridad);
    req.body.estado = estadoNum;
    req.body.motivo = motivo.trim();
    req.body.observaciones = obs.valor;
    // fecha_fin y hora_fin las escribe el endpoint de finalizar
    req.body.fecha_fin = null;
    req.body.hora_fin = null;

    next();
};

// ----------------------------------------------------------------------------
// Edición de datos administrativos (no toca el estado)
// ----------------------------------------------------------------------------
export const validarEdicionMantenimiento = (req, res, next) => {
    const { fecha_inicio, hora_inicio, tipo, motivo, prioridad, observaciones } = req.body;

    const fecha = fecha_inicio ? aFechaISO(fecha_inicio) : null;
    if (!fecha) {
        return res.status(400).json({ error: 'El campo "fecha_inicio" es obligatorio (AAAA-MM-DD)' });
    }
    if (!hora_inicio || !REGEX_HORA.test(String(hora_inicio))) {
        return res.status(400).json({ error: 'El campo "hora_inicio" es obligatorio (formato HH:MM)' });
    }
    if (!tipo || !TIPOS_VALIDOS.includes(Number(tipo))) {
        return res.status(400).json({
            error: 'El campo "tipo" debe ser 1 (preventivo), 2 (correctivo) o 3 (emergencia)'
        });
    }
    if (!motivo || typeof motivo !== "string" || motivo.trim().length < 5 || motivo.trim().length > 60) {
        return res.status(400).json({ error: 'El campo "motivo" debe tener entre 5 y 60 caracteres' });
    }
    if (!prioridad || !PRIORIDADES_VALIDAS.includes(Number(prioridad))) {
        return res.status(400).json({ error: 'El campo "prioridad" debe ser 1 (alta), 2 (media) o 3 (baja)' });
    }
    const obs = leerObservaciones(observaciones);
    if (obs.error) return res.status(400).json({ error: obs.error });

    req.body.fecha_inicio = fecha;
    req.body.tipo = Number(tipo);
    req.body.prioridad = Number(prioridad);
    req.body.motivo = motivo.trim();
    req.body.observaciones = obs.valor;

    next();
};

// ----------------------------------------------------------------------------
// Fecha, hora y comentario de una transición (iniciar / finalizar)
// ----------------------------------------------------------------------------
// Fecha y hora opcionales: por defecto el momento actual (local). Que el
// fin no quede antes del inicio lo valida el controller.
export const validarFechaTransicion = (req, res, next) => {
    const { fecha, hora, comentario } = req.body ?? {};

    let fechaNorm = null;
    if (fecha) {
        fechaNorm = aFechaISO(fecha);
        if (!fechaNorm) {
            return res.status(400).json({ error: 'El campo "fecha" no es una fecha válida (usa AAAA-MM-DD)' });
        }
        if (esFechaFutura(fechaNorm)) {
            return res.status(400).json({ error: "La fecha no puede ser futura" });
        }
    }

    let horaNorm = null;
    if (hora) {
        if (!REGEX_HORA.test(String(hora))) {
            return res.status(400).json({ error: 'El campo "hora" debe tener formato HH:MM o HH:MM:SS' });
        }
        horaNorm = String(hora);
        if (fechaNorm && `${fechaNorm}T${horaNorm.slice(0, 5)}` > ahoraLocal()) {
            return res.status(400).json({ error: "La hora no puede ser futura" });
        }
    }

    const com = leerObservaciones(comentario, "comentario");
    if (com.error) return res.status(400).json({ error: com.error });

    req.body = { fecha: fechaNorm, hora: horaNorm, comentario: com.valor };
    next();
};

export const validarIdMantenimiento = (req, res, next) => {
    const { id } = req.params;
    if (!id || isNaN(Number(id))) {
        return res.status(400).json({ error: "El id de mantenimiento debe ser un número válido" });
    }
    next();
};
