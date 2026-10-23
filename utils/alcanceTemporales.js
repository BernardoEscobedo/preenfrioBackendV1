import { db } from "../database/connection.database.js";

// ============================================================================
// ALCANCE · CAJAS TEMPORALES
// ============================================================================
// Una caja temporal pertenece a la planta de la cámara de la que salió
// (camaras.id_camara_origen). Quien tiene acceso a esa cámara tiene acceso
// a su caja: puede recibir, despachar y reingresar desde ella.
//
// Se usa dentro de cargarAlcance (ver instrucciones de instalación):
//     req.camaras = await sumarTemporales(req.camaras);
// ============================================================================

export const sumarTemporales = async (camaras) => {
    if (!Array.isArray(camaras) || camaras.length === 0) return camaras;
    const r = await db.query(
        `SELECT id_camara FROM camaras
         WHERE es_temporal AND estado = 1 AND id_camara_origen = ANY($1::INT[])`,
        [camaras.map(Number)]
    );
    return [...new Set([...camaras.map(Number), ...r.rows.map((x) => Number(x.id_camara))])];
};

// Alternativa si prefieres no tocar alcance.middleware.js: ponlo después de
// cargarAlcance en las rutas que lo necesiten.
export const ampliarAlcanceTemporales = async (req, res, next) => {
    try {
        req.camaras = await sumarTemporales(req.camaras);
        next();
    } catch (error) {
        console.error("Error al ampliar el alcance a cajas temporales:", error);
        res.status(500).json({ error: "Error al validar el acceso a las cajas temporales" });
    }
};
