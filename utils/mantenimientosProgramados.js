import { db } from "../database/connection.database.js";

// ============================================================================
// ACTIVADOR DE MANTENIMIENTOS PROGRAMADOS
// ============================================================================
// Un preventivo programado bloquea la cámara A LA HORA PROGRAMADA. Lo hace
// fn_activar_mantenimientos_programados (pasa a estado 2 y el trigger de
// siempre crea el bloqueo).
//
// Se llama de dos formas:
//   · iniciarActivadorProgramados()   cada minuto mientras el servidor corre
//   · middlewareActivarProgramados    antes de cada petición a la API (con
//                                     un mínimo de 30 s entre llamadas).
//                                     Cubre el caso de Render: si el
//                                     servidor estaba dormido, la primera
//                                     petición activa lo vencido ANTES de,
//                                     por ejemplo, registrar una recepción.
// ============================================================================

const zona = () => process.env.ZONA_HORARIA || "America/Mexico_City";
const ESPERA_MS = 30_000;
let ultima = 0;
let enCurso = null;

export const activarMantenimientosProgramados = async (forzar = false) => {
    if (!forzar && Date.now() - ultima < ESPERA_MS) return 0;
    if (enCurso) return enCurso;
    ultima = Date.now();
    enCurso = db
        .query(`SELECT fn_activar_mantenimientos_programados($1) AS activados`, [zona()])
        .then((r) => {
            const n = Number(r.rows[0]?.activados ?? 0);
            if (n > 0) console.log(`[mantenimientos] ${n} preventivo(s) iniciados a su hora programada`);
            return n;
        })
        .catch((e) => {
            console.error("[mantenimientos] No se pudieron activar los programados:", e.message);
            return 0;
        })
        .finally(() => {
            enCurso = null;
        });
    return enCurso;
};

export const middlewareActivarProgramados = async (req, res, next) => {
    await activarMantenimientosProgramados();
    next();
};

export const iniciarActivadorProgramados = () => {
    activarMantenimientosProgramados(true);
    setInterval(() => activarMantenimientosProgramados(true), 60_000).unref?.();
};
