import { db } from "../database/connection.database.js";
import m from "../models/temporales.model.js";

// ============================================================================
// CAJAS TEMPORALES · operativo+
// ============================================================================
//   GET  /temporales                     cajas abiertas con su contenido
//   GET  /temporales/:id/fruta           lotes dentro de la caja
//   GET  /temporales/destinos?excluir=   cámaras operando (destinos)
//   GET  /temporales/recepcion/:id_camara
//        ¿la cámara planeada está fuera de servicio? y dónde recibir
//   POST /temporales/reubicar            saca TODA la fruta de una cámara
//        fuera de servicio (o de una caja) hacia una caja nueva, una caja
//        abierta u otra cámara operando
//   POST /temporales/:id/cerrar          cierra una caja vacía
//
// La fruta nunca sale del inventario: la caja es una cámara más (tipo 3).
// ============================================================================

class ErrorNegocio extends Error {
    constructor(mensaje, status = 409) {
        super(mensaje);
        this.status = status;
    }
}
const falla = (mensaje, status) => {
    throw new ErrorNegocio(mensaje, status);
};

const sinAlcance = (req, camara) =>
    Array.isArray(req.camaras) &&
    !req.camaras.includes(Number(camara.id_camara)) &&
    !(camara.id_camara_origen && req.camaras.includes(Number(camara.id_camara_origen)));

const responder = (res, error, contexto) => {
    if (error instanceof ErrorNegocio) return res.status(error.status).json({ error: error.message });
    console.error(`Error al ${contexto}:`, error);
    if (error.code === "P0001") return res.status(409).json({ error: error.message });
    if (error.code === "23505") return res.status(409).json({ error: "Ya existe una cámara con ese nombre: intenta de nuevo en un minuto" });
    if (error.code === "23514") return res.status(409).json({ error: `La BD rechazó el dato: ${error.message}` });
    res.status(500).json({ error: `Error al ${contexto}` });
};

const getAbiertas = async (req, res) => {
    try {
        res.status(200).json(await m.getAbiertas(req.camaras));
    } catch (error) {
        responder(res, error, "obtener las cajas temporales");
    }
};

const getFruta = async (req, res) => {
    try {
        const caja = await m.getCamara(db, req.params.id);
        if (!caja || !caja.es_temporal) return res.status(404).json({ error: "Caja temporal no encontrada" });
        if (sinAlcance(req, caja)) return res.status(403).json({ error: "No tienes acceso a esa caja" });
        res.status(200).json(await m.getFruta(caja.id_camara));
    } catch (error) {
        responder(res, error, "obtener la fruta de la caja");
    }
};

const getDestinos = async (req, res) => {
    try {
        const excluir = Number(req.query.excluir) || 0;
        res.status(200).json(await m.getDestinos(excluir, req.camaras));
    } catch (error) {
        responder(res, error, "obtener los destinos");
    }
};

const getDestinosRecepcion = async (req, res) => {
    try {
        const id = Number(req.params.id_camara);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Cámara inválida" });
        const filas = await m.getDestinosRecepcion(id, req.camaras);
        const planeada = filas.find((f) => Number(f.id_camara) === id) ?? null;
        res.status(200).json({
            planeada,
            opciones: filas.filter((f) => !f.bloqueada)
        });
    } catch (error) {
        responder(res, error, "obtener dónde recibir");
    }
};

// ----------------------------------------------------------------------------
// POST /temporales/reubicar
// body: { id_camara_origen, destino: { id_camara } | { nueva: { id_linea_fletera,
//         id_caja_refrigerada, capacidad } } }
// ----------------------------------------------------------------------------
const reubicar = async (req, res) => {
    const { id_camara_origen, destino } = req.body;
    const client = await db.connect();
    try {
        await client.query("BEGIN");

        const origen = await m.getCamara(client, id_camara_origen);
        if (!origen) falla("La cámara de origen no existe", 404);
        if (sinAlcance(req, origen)) falla(`No tienes acceso a "${origen.nombre_camara}"`, 403);

        let idDestino = destino.id_camara ?? null;
        let nueva = false;
        if (!idDestino) {
            // La caja nueva pertenece a la planta de la cámara de origen
            const raiz = origen.es_temporal && origen.id_camara_origen ? origen.id_camara_origen : origen.id_camara;
            idDestino = await m.abrir(client, { id_camara_origen: raiz, ...destino.nueva });
            nueva = true;
        } else {
            const d = await m.getCamara(client, idDestino);
            if (!d) falla("La cámara destino no existe", 404);
            if (sinAlcance(req, d)) falla(`No tienes acceso a "${d.nombre_camara}"`, 403);
        }

        const r = await m.reubicar(client, origen.id_camara, idDestino, req.id_usuario ?? null);

        // Una caja que quedó vacía al reingresar su fruta se cierra sola
        let cerrada = false;
        if (origen.es_temporal && (await m.estaVacia(client, origen.id_camara))) {
            cerrada = Boolean(await m.cerrar(client, origen.id_camara));
        }

        await client.query("COMMIT");

        const avisos = [];
        if (r.procesos_cola > 0) {
            avisos.push(
                `${r.procesos_cola} proceso(s) en cola pasaron a "${r.destino}"; ${r.cola_ingresados} entraron y el resto sigue en espera.`
            );
        }
        if (cerrada) avisos.push(`"${r.origen}" quedó vacía y se cerró.`);

        res.status(201).json({
            mensaje: `${r.tarimas} tarima(s) y ${r.cajas} cajas pasaron de "${r.origen}" a "${r.destino}"${nueva ? " (caja nueva)" : ""}.`,
            id_camara_destino: idDestino,
            resultado: r,
            avisos
        });
    } catch (error) {
        await client.query("ROLLBACK");
        responder(res, error, "reubicar la fruta");
    } finally {
        client.release();
    }
};

// POST /temporales/:id/cerrar — solo vacía
const cerrar = async (req, res) => {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const caja = await m.getCamara(client, req.params.id);
        if (!caja || !caja.es_temporal) falla("Caja temporal no encontrada", 404);
        if (sinAlcance(req, caja)) falla("No tienes acceso a esa caja", 403);
        if (Number(caja.estado) !== 1) falla("La caja ya estaba cerrada");
        if (!(await m.estaVacia(client, caja.id_camara))) {
            falla("La caja todavía tiene fruta: reingrésala a una cámara o despáchala antes de cerrarla");
        }
        await m.cerrar(client, caja.id_camara);
        await client.query("COMMIT");
        res.status(200).json({ mensaje: `"${caja.nombre_camara}" cerrada` });
    } catch (error) {
        await client.query("ROLLBACK");
        responder(res, error, "cerrar la caja");
    } finally {
        client.release();
    }
};

export const temporalesController = {
    getAbiertas,
    getFruta,
    getDestinos,
    getDestinosRecepcion,
    reubicar,
    cerrar
};
