import { MAX_FILAS, claveDestino } from "../utils/importacionProduccion.js";

// ============================================================================
// VALIDACIONES · IMPORTACIÓN DE PRODUCCIÓN
// ============================================================================
// Aquí solo se valida la FORMA de la petición. Las reglas de negocio de
// cada fila viven en utils/importacionProduccion.js, porque una fila con
// errores no es un 400: es una fila que se muestra en rojo para corregirla.
// ============================================================================

const CAMPOS_FILA = [
    "semana", "region", "finca", "productor", "fecha_empaque", "transito",
    "fecha_entrega", "cedis", "cliente", "sku", "cajas", "estiba",
    "comentarios", "lote"
];

const esObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const esValorSimple = (v) => v === null || v === undefined || ["string", "number"].includes(typeof v);

export const validarCargaImportacion = (req, res, next) => {
    const { filas, destinos, nombre_archivo, esperadas } = req.body ?? {};

    if (!Array.isArray(filas) || filas.length === 0) {
        return res.status(400).json({ error: "El archivo no trae filas para importar" });
    }
    if (filas.length > MAX_FILAS) {
        return res.status(400).json({ error: `Máximo ${MAX_FILAS} filas por archivo` });
    }

    const limpias = [];
    for (const [i, f] of filas.entries()) {
        if (!esObjeto(f)) {
            return res.status(400).json({ error: `La fila ${i + 1} no tiene un formato válido` });
        }
        const fila = { fila: Number.isInteger(f.fila) ? f.fila : i + 2 };
        for (const campo of CAMPOS_FILA) {
            const v = f[campo];
            if (!esValorSimple(v)) {
                return res.status(400).json({ error: `Fila ${fila.fila}: el campo "${campo}" no es válido` });
            }
            if (typeof v === "string" && v.length > 300) {
                return res.status(400).json({ error: `Fila ${fila.fila}: el campo "${campo}" es demasiado largo` });
            }
            fila[campo] = v ?? null;
        }
        fila.usar_lote = f.usar_lote === "excel" ? "excel" : "sugerido";
        limpias.push(fila);
    }

    // destinos: { clave: id_cc }. La clave se reconstruye en el servidor
    // para que coincida con la de la BD aunque el navegador la arme distinto.
    const destinosLimpios = {};
    if (destinos !== undefined && destinos !== null) {
        if (!esObjeto(destinos)) {
            return res.status(400).json({ error: 'El campo "destinos" debe ser un objeto' });
        }
        for (const [clave, idCc] of Object.entries(destinos)) {
            const n = Number(idCc);
            if (!Number.isInteger(n) || n <= 0) {
                return res.status(400).json({ error: `Destino inválido para "${clave}"` });
            }
            const [cedis = "", cliente = ""] = clave.split("|");
            destinosLimpios[claveDestino(cedis, cliente)] = n;
        }
    }

    if (nombre_archivo !== undefined && nombre_archivo !== null &&
        (typeof nombre_archivo !== "string" || nombre_archivo.length > 200)) {
        return res.status(400).json({ error: 'El campo "nombre_archivo" no es válido' });
    }

    if (esperadas !== undefined && (!Number.isInteger(esperadas) || esperadas < 0)) {
        return res.status(400).json({ error: 'El campo "esperadas" no es válido' });
    }

    req.body = {
        filas: limpias,
        destinos: destinosLimpios,
        nombre_archivo: nombre_archivo ? nombre_archivo.trim() : null,
        esperadas
    };
    next();
};

export const validarAsignacionCamara = (req, res, next) => {
    const { ids, id_camara } = req.body ?? {};

    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
        return res.status(400).json({ error: "Selecciona entre 1 y 500 líneas de producción" });
    }
    const numeros = ids.map(Number);
    if (numeros.some((n) => !Number.isInteger(n) || n <= 0)) {
        return res.status(400).json({ error: "Hay ids de producción inválidos" });
    }

    const camara = Number(id_camara);
    if (!Number.isInteger(camara) || camara <= 0) {
        return res.status(400).json({ error: "Selecciona la cámara de preenfrío" });
    }

    req.body = { ids: [...new Set(numeros)], id_camara: camara };
    next();
};

export const validarFiltrosSinCamara = (req, res, next) => {
    const { semana, fecha_empaque } = req.query;
    if (semana !== undefined && semana !== "") {
        const n = Number(semana);
        if (!Number.isInteger(n) || n < 1 || n > 53) {
            return res.status(400).json({ error: "La semana debe ser un entero entre 1 y 53" });
        }
    }
    if (fecha_empaque !== undefined && fecha_empaque !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha_empaque))) {
        return res.status(400).json({ error: "La fecha de empaque debe tener formato AAAA-MM-DD" });
    }
    next();
};
