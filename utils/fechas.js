// ============================================================================
// FECHAS EN LA ZONA DE OPERACIÓN
// ============================================================================
// EL PROBLEMA QUE RESUELVE
//   new Date("2026-09-26") se interpreta como medianoche UTC. En Tapachula
//   (UTC-6) eso es el 25 a las 18:00. Si luego se compara contra "el fin del
//   día de hoy" en hora local, la fecha de MAÑANA pasa la validación de
//   "no puede ser futura".
//
//   Además Render corre en UTC y los equipos de planta en hora local, así
//   que el mismo código daba resultados distintos según dónde corriera.
//
// LA SOLUCIÓN
//   Todas las fechas de negocio (recepción, movimiento, empaque, cita) son
//   DÍAS, no instantes. Se manejan como texto 'AAAA-MM-DD' y se comparan
//   como texto. El "hoy" se calcula en la zona de la operación, no en la del
//   servidor.
//
//   Los TIMESTAMP (armado de bloque, pulpeos) sí son instantes y siguen
//   comparándose con new Date(): ahí no aplica este problema.
// ============================================================================

const ZONA_OPERACION = "America/Mexico_City";

// 'en-CA' formatea como AAAA-MM-DD, que es justo lo que se necesita.
const formatoDia = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA_OPERACION,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
});

/** Fecha de hoy en la zona de operación, como 'AAAA-MM-DD'. */
export const hoyISO = () => formatoDia.format(new Date());

/**
 * Normaliza una fecha a 'AAAA-MM-DD'. Devuelve null si no es válida.
 *
 * Acepta:
 *   · '2026-09-26'                  (lo normal desde el frontend)
 *   · '2026-09-26T08:30:00Z'        (se toma solo la parte del día)
 *   · un Date que venga de la BD    (pg entrega DATE como medianoche local)
 */
export const aFechaISO = (valor) => {
    if (valor === undefined || valor === null || valor === "") return null;

    if (valor instanceof Date) {
        if (isNaN(valor.getTime())) return null;
        const a = valor.getFullYear();
        const m = String(valor.getMonth() + 1).padStart(2, "0");
        const d = String(valor.getDate()).padStart(2, "0");
        return `${a}-${m}-${d}`;
    }

    const coincidencia = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(valor).trim());
    if (!coincidencia) return null;

    const [, a, m, d] = coincidencia;

    // Ida y vuelta por Date.UTC para rechazar fechas imposibles (31 de
    // febrero): si el día cambia al reconstruirla, no existía.
    const f = new Date(Date.UTC(Number(a), Number(m) - 1, Number(d)));
    if (
        f.getUTCFullYear() !== Number(a) ||
        f.getUTCMonth() !== Number(m) - 1 ||
        f.getUTCDate() !== Number(d)
    ) {
        return null;
    }

    return `${a}-${m}-${d}`;
};

/** true si la fecha 'AAAA-MM-DD' es posterior a hoy en la zona de operación. */
export const esFechaFutura = (iso) => iso > hoyISO();

/** Suma días a una fecha 'AAAA-MM-DD' y devuelve otra 'AAAA-MM-DD'. */
export const sumarDiasISO = (iso, dias) => {
    const [a, m, d] = iso.split("-").map(Number);
    const f = new Date(Date.UTC(a, m - 1, d));
    f.setUTCDate(f.getUTCDate() + dias);
    return f.toISOString().slice(0, 10);
};

/**
 * Número de semana ISO de una fecha 'AAAA-MM-DD'.
 *
 * Trabaja todo en UTC a propósito. La versión anterior mezclaba getDate()
 * local con una fecha parseada en UTC y los lunes devolvía la semana
 * anterior.
 */
export const semanaISO = (iso) => {
    const [a, m, d] = iso.split("-").map(Number);
    const f = new Date(Date.UTC(a, m - 1, d));

    // El jueves de esa semana define a qué año ISO pertenece
    f.setUTCDate(f.getUTCDate() + 4 - (f.getUTCDay() || 7));

    const inicioAnio = new Date(Date.UTC(f.getUTCFullYear(), 0, 1));
    return Math.ceil(((f - inicioAnio) / 86400000 + 1) / 7);
};
