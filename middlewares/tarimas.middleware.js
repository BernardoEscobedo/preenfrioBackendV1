import { MIME_PERMITIDOS, LIMITES, TIPOS } from "./evidencias.middleware.js";
import { zona } from "../models/tarimas.model.js";

// ============================================================================
// VALIDACIONES · BLOQUES POR TARIMA Y PULPEOS
// ============================================================================
// Las fechas llegan en hora local "AAAA-MM-DDTHH:MM" y se comparan contra
// la hora local de operación (ZONA_HORARIA del .env), nunca contra la del
// servidor.
// ============================================================================

const FECHA_HORA = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;
const TEMP_MIN = -2;
const TEMP_MAX = 40;

export const ahoraLocalTexto = () =>
    new Date().toLocaleString("sv-SE", { timeZone: zona() }).slice(0, 16).replace(" ", "T");

/** "AAAA-MM-DDTHH:MM" local, no futura. Devuelve { valor } o { error }. */
export const leerFechaHora = (v, nombre) => {
    if (v === undefined || v === null || v === "") return { valor: null };
    const t = String(v).trim().replace(" ", "T").slice(0, 16);
    if (!FECHA_HORA.test(t)) return { error: `"${nombre}" debe tener formato AAAA-MM-DDTHH:MM` };
    if (t > ahoraLocalTexto()) return { error: `"${nombre}" no puede ser futura` };
    return { valor: t.replace("T", " ") + ":00" };
};

const entero = (v) => Number.isInteger(Number(v)) && Number(v) > 0;

/** Tarimas: [{ posicion, lotes: [{ id_produccion, cantidad_cajas }] }] */
const leerTarimas = (tarimas) => {
    if (!Array.isArray(tarimas) || tarimas.length === 0) return { error: "Captura al menos una tarima" };
    if (tarimas.length > 12) return { error: "Un bloque tiene máximo 12 tarimas" };

    const posiciones = new Set();
    const limpias = [];
    for (const t of tarimas) {
        const pos = Number(t?.posicion);
        if (!Number.isInteger(pos) || pos < 1 || pos > 12) return { error: "Posición de tarima inválida (1 a 12)" };
        if (posiciones.has(pos)) return { error: `La posición ${pos} viene repetida` };
        posiciones.add(pos);

        if (!Array.isArray(t.lotes) || t.lotes.length === 0) return { error: `La tarima ${pos} no tiene lotes` };
        const vistos = new Set();
        const lotes = [];
        let cajas = 0;
        for (const l of t.lotes) {
            if (!entero(l?.id_produccion)) return { error: `Tarima ${pos}: lote inválido` };
            if (!entero(l.cantidad_cajas)) return { error: `Tarima ${pos}: las cajas deben ser un entero mayor a 0` };
            const id = Number(l.id_produccion);
            if (vistos.has(id)) return { error: `Tarima ${pos}: un lote viene repetido` };
            vistos.add(id);
            cajas += Number(l.cantidad_cajas);
            lotes.push({ id_produccion: id, cantidad_cajas: Number(l.cantidad_cajas) });
        }
        if (cajas > 80) return { error: `Tarima ${pos}: ${cajas} cajas no caben en una tarima` };
        limpias.push({ posicion: pos, lotes });
    }
    return { valor: limpias.sort((a, b) => a.posicion - b.posicion) };
};

// POST /tarimas/bloques
export const validarArmado = (req, res, next) => {
    const b = req.body ?? {};

    if (!entero(b.id_camara)) return res.status(400).json({ error: "Elige la cámara" });
    const posiciones = Number(b.posiciones);
    if (![10, 12].includes(posiciones)) return res.status(400).json({ error: "El bloque es de 10 o 12 tarimas" });

    let codigo = null;
    if (b.codigo_bloque) {
        codigo = String(b.codigo_bloque).trim().toUpperCase().replace(/\s+/g, "");
        if (codigo.length > 50 || !/^[A-Z0-9_-]+$/.test(codigo))
            return res.status(400).json({ error: "El código solo admite letras, números, guion y guion bajo (máx. 50)" });
    }

    const fecha = leerFechaHora(b.fecha_hora_ingreso, "fecha_hora_ingreso");
    if (fecha.error) return res.status(400).json({ error: fecha.error });

    const tarimas = leerTarimas(b.tarimas);
    if (tarimas.error) return res.status(400).json({ error: tarimas.error });

    req.body = {
        codigo_bloque: codigo,
        id_camara: Number(b.id_camara),
        posiciones,
        fecha_hora_ingreso: fecha.valor,
        tarimas: tarimas.valor
    };
    next();
};

// POST /tarimas/bloques/:id/tarimas
export const validarAgregarTarimas = (req, res, next) => {
    const fecha = leerFechaHora(req.body?.fecha_hora_ingreso, "fecha_hora_ingreso");
    if (fecha.error) return res.status(400).json({ error: fecha.error });
    const tarimas = leerTarimas(req.body?.tarimas);
    if (tarimas.error) return res.status(400).json({ error: tarimas.error });
    req.body = { fecha_hora_ingreso: fecha.valor, tarimas: tarimas.valor };
    next();
};

// POST /tarimas/:id/pulpeo/sesion
// body: { temperatura, fecha_hora?, observaciones?, foto: { mime_type, tamano_bytes, nombre_original } }
export const validarSesionPulpeo = (req, res, next) => {
    const { temperatura, fecha_hora, observaciones, foto } = req.body ?? {};

    if (temperatura === undefined || temperatura === null || temperatura === "")
        return res.status(400).json({ error: "Captura la temperatura de la pulpa" });
    const temp = Number(temperatura);
    if (isNaN(temp) || temp < TEMP_MIN || temp > TEMP_MAX)
        return res.status(400).json({ error: `La temperatura debe estar entre ${TEMP_MIN} y ${TEMP_MAX} °C. Revisa la lectura.` });

    const fecha = leerFechaHora(fecha_hora, "fecha_hora");
    if (fecha.error) return res.status(400).json({ error: fecha.error });

    if (observaciones && String(observaciones).length > 250)
        return res.status(400).json({ error: "Las observaciones no pueden exceder 250 caracteres" });

    // ---- La foto es obligatoria ----
    if (!foto || typeof foto !== "object") return res.status(400).json({ error: "Toma la foto del termómetro: es obligatoria" });
    const mime = String(foto.mime_type ?? "").toLowerCase().trim();
    const extension = MIME_PERMITIDOS[TIPOS.FOTO][mime];
    if (!extension) return res.status(400).json({ error: `Formato de foto no permitido. Acepta: ${Object.keys(MIME_PERMITIDOS[TIPOS.FOTO]).join(", ")}` });
    const tamano = Number(foto.tamano_bytes);
    if (!Number.isInteger(tamano) || tamano <= 0) return res.status(400).json({ error: "Tamaño de la foto inválido" });
    if (tamano > LIMITES.FOTO_BYTES) return res.status(400).json({ error: `La foto pesa más de ${LIMITES.FOTO_BYTES / 1048576} MB` });

    req.body = {
        temperatura: Math.round(temp * 10) / 10,
        fecha_hora: fecha.valor,
        observaciones: observaciones ? String(observaciones).trim() : null,
        foto: {
            mime_type: mime,
            extension,
            tamano_bytes: tamano,
            nombre_original: foto.nombre_original ? String(foto.nombre_original).slice(0, 255) : null
        }
    };
    next();
};

export const validarConfirmarPulpeo = (req, res, next) => {
    const { token_carga, item_id } = req.body ?? {};
    if (!token_carga || typeof token_carga !== "string") return res.status(400).json({ error: "Falta el comprobante de carga" });
    if (!item_id || typeof item_id !== "string" || item_id.length > 200) return res.status(400).json({ error: "Falta el id de la foto en SharePoint" });
    next();
};

export const validarIdNumerico = (req, res, next) => {
    if (!entero(req.params.id)) return res.status(400).json({ error: "El id debe ser un número válido" });
    next();
};
