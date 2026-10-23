import jwt from "jsonwebtoken";
import crypto from "crypto";
import { db } from "../database/connection.database.js";
import m from "../models/tarimas.model.js";
import {
    sharepointConfigurado,
    rutaEvidencias,
    crearSesionCarga,
    obtenerArchivo,
    eliminarArchivo,
    idBiblioteca
} from "../utils/sharepoint.js";
import { LIMITES } from "../middlewares/evidencias.middleware.js";

// ============================================================================
// BLOQUES POR TARIMA Y PULPEOS · operativo+ (retirar = supervisor+)
// ============================================================================
// El TRASLADO del bloque a conservación se hace en Movimientos
// (POST /movimientos/bloque): mueve el inventario y la ubicación de las
// tarimas en la misma operación.
//
// SEMÁFORO DE PULPEO (solo preenfrío: se pulpea cada hora)
//   al_dia     último pulpeo hace menos de 60 min
//   toca       entre 60 y 75 min
//   vencido    más de 75 min, o lleva 60 min dentro sin ningún pulpeo
//   primero    recién entró (< 60 min) y aún no se pulpea
//   libre      conservación: sin frecuencia fija
//
// ALERTA DE 5 HORAS: la tarima lleva 5 h o más dentro del preenfrío
// (desde fecha_hora_ingreso).
//
// PULPEO CON FOTO OBLIGATORIA (mismo esquema que evidencias)
//   1. POST /tarimas/:id/pulpeo/sesion   lectura + datos de la foto
//   2. El frontend sube la foto directo a SharePoint
//   3. POST /tarimas/pulpeo/confirmar    { token_carga, item_id }
//      → guarda pulpeo + desglose + foto JUNTOS. Un trigger diferido
//        revierte todo si faltara la foto.
// ============================================================================

const PROPOSITO = "pulpeo_tarima";
const MIN_PULPEO = 60;
const MIN_TOLERANCIA = 75;
const HORAS_ALERTA = 5;

class ErrorNegocio extends Error {
    constructor(mensaje, status = 409) {
        super(mensaje);
        this.status = status;
    }
}
const falla = (mensaje, status) => {
    throw new ErrorNegocio(mensaje, status);
};

const sinAlcance = (req, id_camara) => Array.isArray(req.camaras) && !req.camaras.includes(Number(id_camara));

const semaforo = (t) => {
    if (Number(t.tipo_camara) !== 1) return "libre";
    const min = t.minutos_desde_pulpeo === null ? null : Number(t.minutos_desde_pulpeo);
    if (min === null) return Number(t.minutos_en_camara) >= MIN_PULPEO ? "vencido" : "primero";
    if (min < MIN_PULPEO) return "al_dia";
    if (min <= MIN_TOLERANCIA) return "toca";
    return "vencido";
};

const responderError = (res, error, contexto) => {
    if (error instanceof ErrorNegocio) return res.status(error.status).json({ error: error.message });
    console.error(`Error al ${contexto}:`, error);
    if (error.code === "P0001") return res.status(409).json({ error: error.message });
    if (error.code === "23505") return res.status(409).json({ error: "Esa posición o ese lote ya están registrados en la tarima" });
    if (error.code === "23503") return res.status(409).json({ error: "El bloque, la cámara o el lote indicados no existen" });
    res.status(500).json({ error: `Error al ${contexto}` });
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/tarimas?id_camara=1
// ----------------------------------------------------------------------------
// Bloques con sus tarimas en esa cámara. posiciones_fuera: las tarimas del
// mismo bloque que ya están en otra cámara (traslado parcial).
const getBloques = async (req, res) => {
    try {
        const idCamara = req.query.id_camara ? Number(req.query.id_camara) : null;
        if (idCamara && sinAlcance(req, idCamara)) {
            return res.status(403).json({ error: "No tienes acceso a esa cámara" });
        }
        const tarimas = await m.getTarimas({ id_camara: idCamara }, req.camaras);

        const bloques = new Map();
        for (const t of tarimas) {
            const estado = semaforo(t);
            const alerta = Number(t.tipo_camara) === 1 && Number(t.horas_en_camara) >= HORAS_ALERTA;
            const b = bloques.get(t.id_bloque) ?? {
                id_bloque: t.id_bloque,
                codigo_bloque: t.codigo_bloque,
                posiciones: t.posiciones,
                fecha_hora_armado: t.fecha_hora_armado,
                tarimas: [],
                posiciones_fuera: []
            };
            b.tarimas.push({ ...t, estado_pulpeo: estado, alerta_5h: alerta });
            bloques.set(t.id_bloque, b);
        }

        if (idCamara && bloques.size) {
            const fuera = await m.getTarimasFuera([...bloques.keys()], idCamara);
            for (const f of fuera) {
                bloques.get(f.id_bloque)?.posiciones_fuera.push({ posicion: f.posicion, nombre_camara: f.nombre_camara });
            }
        }

        const lista = [...bloques.values()];
        const todas = lista.flatMap((b) => b.tarimas);
        res.status(200).json({
            resumen: {
                bloques: lista.length,
                tarimas: todas.length,
                por_pulpear: todas.filter((t) => t.estado_pulpeo === "toca" || t.estado_pulpeo === "vencido").length,
                vencidas: todas.filter((t) => t.estado_pulpeo === "vencido").length,
                alerta_5h: todas.filter((t) => t.alerta_5h).length
            },
            bloques: lista
        });
    } catch (error) {
        responderError(res, error, "obtener los bloques");
    }
};

// GET /api/preenfrio/tarimas/lotes?id_camara=1
const getLotes = async (req, res) => {
    try {
        const idCamara = Number(req.query.id_camara);
        if (!Number.isInteger(idCamara) || idCamara <= 0) return res.status(400).json({ error: "Indica la cámara" });
        if (sinAlcance(req, idCamara)) return res.status(403).json({ error: "No tienes acceso a esa cámara" });
        res.status(200).json(await m.getLotesCamara(idCamara));
    } catch (error) {
        responderError(res, error, "obtener los lotes");
    }
};

// GET /api/preenfrio/tarimas/:id/pulpeos
const getHistorial = async (req, res) => {
    try {
        const tarima = await m.getTarima(db, req.params.id);
        if (!tarima) return res.status(404).json({ error: "Tarima no encontrada" });
        if (sinAlcance(req, tarima.id_camara)) return res.status(403).json({ error: "No tienes acceso a esa tarima" });
        res.status(200).json(await m.getHistorial(req.params.id));
    } catch (error) {
        responderError(res, error, "obtener el historial");
    }
};

// ----------------------------------------------------------------------------
// Validar lotes contra la cámara
// ----------------------------------------------------------------------------
const validarLotes = async (client, id_camara, tarimas) => {
    const ids = [...new Set(tarimas.flatMap((t) => t.lotes.map((l) => l.id_produccion)))];
    const presentes = await m.lotesEnCamara(client, id_camara, ids);
    const faltan = ids.filter((id) => !presentes.includes(id));
    if (faltan.length) falla(`${faltan.length} lote(s) no están dentro de esa cámara: actualiza la lista`);
};

// ----------------------------------------------------------------------------
// POST /api/preenfrio/tarimas/bloques
// ----------------------------------------------------------------------------
const armarBloque = async (req, res) => {
    const { codigo_bloque, id_camara, posiciones, fecha_hora_ingreso, tarimas } = req.body;
    const client = await db.connect();
    try {
        await client.query("BEGIN");

        const camara = await m.getCamara(client, id_camara);
        if (!camara) falla("La cámara no existe");
        if (Number(camara.estado) !== 1) falla(`"${camara.nombre_camara}" está fuera de servicio`);
        if (![1, 2].includes(Number(camara.tipo_camara))) falla("Solo se arman bloques en preenfrío o conservación");
        if (sinAlcance(req, id_camara)) falla("No tienes acceso a esa cámara", 403);

        for (const t of tarimas) {
            if (t.posicion > posiciones) falla(`El bloque es de ${posiciones} tarimas: no existe la posición ${t.posicion}`);
        }
        await validarLotes(client, id_camara, tarimas);

        let codigo = codigo_bloque;
        if (codigo && (await m.existeCodigo(client, codigo))) falla(`El código ${codigo} ya existe`);
        if (!codigo) codigo = await m.siguienteCodigo(client);

        const ahora = await m.ahoraLocal(client);
        const bloque = await m.crearBloque(client, {
            codigo_bloque: codigo,
            id_camara,
            posiciones,
            fecha_hora_armado: ahora
        });
        for (const t of tarimas) {
            await m.crearTarima(client, {
                id_bloque: bloque.id_bloque,
                posicion: t.posicion,
                id_camara,
                fecha_hora_ingreso: fecha_hora_ingreso ?? ahora,
                id_usuario: req.id_usuario,
                lotes: t.lotes
            });
        }

        await client.query("COMMIT");
        res.status(201).json({
            mensaje: `Bloque ${bloque.codigo_bloque} armado con ${tarimas.length} de ${posiciones} tarima(s) en "${camara.nombre_camara}"`,
            bloque
        });
    } catch (error) {
        await client.query("ROLLBACK");
        responderError(res, error, "armar el bloque");
    } finally {
        client.release();
    }
};

// POST /api/preenfrio/tarimas/bloques/:id/tarimas  — completar posiciones
// Las tarimas nuevas entran a la cámara donde está el bloque.
const agregarTarimas = async (req, res) => {
    const { fecha_hora_ingreso, tarimas } = req.body;
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const bloque = await m.getBloque(client, req.params.id, true);
        if (!bloque) falla("Bloque no encontrado", 404);
        if (Number(bloque.estado) !== 1) falla(`El bloque ${bloque.codigo_bloque} está desarmado`);
        if (!bloque.posiciones) falla("Ese bloque es del registro anterior (sin tarimas): arma uno nuevo");
        if (sinAlcance(req, bloque.id_camara)) falla("No tienes acceso a la cámara del bloque", 403);

        for (const t of tarimas) {
            if (t.posicion > bloque.posiciones) falla(`El bloque es de ${bloque.posiciones} tarimas: no existe la posición ${t.posicion}`);
            if (await m.posicionOcupada(client, bloque.id_bloque, t.posicion)) falla(`La posición ${t.posicion} ya tiene tarima`);
        }
        await validarLotes(client, bloque.id_camara, tarimas);

        const ahora = await m.ahoraLocal(client);
        for (const t of tarimas) {
            await m.crearTarima(client, {
                id_bloque: bloque.id_bloque,
                posicion: t.posicion,
                id_camara: bloque.id_camara,
                fecha_hora_ingreso: fecha_hora_ingreso ?? ahora,
                id_usuario: req.id_usuario,
                lotes: t.lotes
            });
        }
        await client.query("COMMIT");
        res.status(201).json({ mensaje: `${tarimas.length} tarima(s) agregadas al bloque ${bloque.codigo_bloque}` });
    } catch (error) {
        await client.query("ROLLBACK");
        responderError(res, error, "agregar tarimas");
    } finally {
        client.release();
    }
};

// PATCH /api/preenfrio/tarimas/:id/retirar — la tarima salió del bloque
const retirarTarima = async (req, res) => {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const t = await m.getTarima(client, req.params.id, true);
        if (!t) falla("Tarima no encontrada", 404);
        if (Number(t.estado) !== 1) falla("La tarima ya estaba retirada");
        if (sinAlcance(req, t.id_camara)) falla("No tienes acceso a esa tarima", 403);
        await m.retirarTarima(client, t.id_tarima);
        await client.query("COMMIT");
        res.status(200).json({ mensaje: `Tarima ${t.posicion} retirada del bloque ${t.codigo_bloque}. Sus pulpeos se conservan.` });
    } catch (error) {
        await client.query("ROLLBACK");
        responderError(res, error, "retirar la tarima");
    } finally {
        client.release();
    }
};

// ----------------------------------------------------------------------------
// PULPEO · paso 1: POST /api/preenfrio/tarimas/:id/pulpeo/sesion
// ----------------------------------------------------------------------------
const crearSesionPulpeo = async (req, res) => {
    try {
        if (!sharepointConfigurado()) {
            return res.status(503).json({
                error: "SharePoint todavía no está configurado en el servidor (variables SP_*). Sin él no se pueden guardar las fotos, y el pulpeo no se registra sin foto."
            });
        }
        const { temperatura, fecha_hora, observaciones, foto } = req.body;

        const t = await m.getTarima(db, req.params.id);
        if (!t) falla("Tarima no encontrada", 404);
        if (Number(t.estado) !== 1 || Number(t.estado_bloque) !== 1) falla("La tarima ya no está en un bloque armado");
        if (sinAlcance(req, t.id_camara)) falla("No tienes acceso a esa tarima", 403);

        const anio = String((fecha_hora ?? new Date().toISOString()).slice(0, 4));
        const carpeta = rutaEvidencias("Pulpeos", anio, t.codigo_bloque, `tarima-${t.posicion}`);
        const sello = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
        const nombre_archivo = `PULP-${t.codigo_bloque}-T${t.posicion}_${sello}_${crypto.randomBytes(3).toString("hex")}.${foto.extension}`;

        const sesion = await crearSesionCarga(carpeta, nombre_archivo);

        const token_carga = jwt.sign(
            {
                proposito: PROPOSITO,
                id_tarima: t.id_tarima,
                temperatura,
                fecha_hora,
                observaciones,
                carpeta,
                nombre_archivo,
                nombre_original: foto.nombre_original,
                mime_type: foto.mime_type,
                tamano_bytes: foto.tamano_bytes,
                id_usuario: req.id_usuario
            },
            process.env.JWT_SECRET,
            { expiresIn: "2h" }
        );

        res.status(201).json({
            upload_url: sesion.uploadUrl,
            expira: sesion.expirationDateTime,
            nombre_archivo,
            token_carga
        });
    } catch (error) {
        if (error.status && !(error instanceof ErrorNegocio)) {
            console.error("Error de SharePoint:", error);
            return res.status(502).json({ error: `No se pudo preparar la carga en SharePoint: ${error.message}` });
        }
        responderError(res, error, "preparar el pulpeo");
    }
};

// ----------------------------------------------------------------------------
// PULPEO · paso 3: POST /api/preenfrio/tarimas/pulpeo/confirmar
// ----------------------------------------------------------------------------
const confirmarPulpeo = async (req, res) => {
    const { token_carga, item_id } = req.body;

    let datos;
    try {
        datos = jwt.verify(token_carga, process.env.JWT_SECRET);
    } catch {
        return res.status(400).json({ error: "El comprobante caducó o es inválido. Vuelve a tomar el pulpeo." });
    }
    if (datos.proposito !== PROPOSITO) return res.status(400).json({ error: "Comprobante inválido" });
    if (Number(datos.id_usuario) !== Number(req.id_usuario)) return res.status(403).json({ error: "Este pulpeo lo inició otro usuario" });

    // Confirmar dos veces la misma foto no duplica el pulpeo
    const previo = await m.evidenciaPorItem(db, item_id);
    if (previo) return res.status(200).json({ mensaje: "Ese pulpeo ya estaba registrado", id_pulpeo: previo.id_pulpeo });

    let archivo;
    try {
        archivo = await obtenerArchivo(item_id);
    } catch (error) {
        if (error.status === 404) return res.status(404).json({ error: "SharePoint no encuentra la foto. ¿Terminó de subirse?" });
        console.error("Error al consultar SharePoint:", error);
        return res.status(502).json({ error: "No se pudo verificar la foto en SharePoint" });
    }

    const descartar = async (motivo, status = 409) => {
        await eliminarArchivo(item_id).catch((e) => console.error("No se pudo borrar la foto rechazada:", e.message));
        return res.status(status).json({ error: `${motivo}. La foto se eliminó de SharePoint; vuelve a tomar el pulpeo.` });
    };

    // ---- La foto es exactamente la autorizada ----
    const rutaPadre = decodeURIComponent(archivo.parentReference?.path ?? "");
    const mimeReal = String(archivo.file?.mimeType ?? "").toLowerCase();
    if (archivo.name !== datos.nombre_archivo) return descartar("El nombre de la foto no coincide");
    if (!rutaPadre.endsWith(`root:/${datos.carpeta}`)) return descartar("La foto no está en la carpeta autorizada");
    if (Number(archivo.size) > LIMITES.FOTO_BYTES) return descartar("La foto excede el tamaño máximo");
    if (mimeReal && mimeReal !== "application/octet-stream" && !mimeReal.startsWith("image/")) return descartar("El archivo no es una foto");

    const client = await db.connect();
    try {
        await client.query("BEGIN");

        const t = await m.getTarima(client, datos.id_tarima, true);
        if (!t || Number(t.estado) !== 1 || Number(t.estado_bloque) !== 1) {
            await client.query("ROLLBACK");
            return descartar("La tarima ya no está en un bloque armado");
        }
        if (sinAlcance(req, t.id_camara)) {
            await client.query("ROLLBACK");
            return descartar("Ya no tienes acceso a esa tarima", 403);
        }

        const lotes = await m.getLotesDeTarima(client, t.id_tarima);
        const numero = await m.siguienteNumero(client, t.id_tarima);
        const pulpeo = await m.crearPulpeo(client, {
            id_bloque: t.id_bloque,
            id_tarima: t.id_tarima,
            id_camara: t.id_camara,
            fecha_hora: datos.fecha_hora,
            numero_pulpeo: numero,
            temperatura: datos.temperatura,
            id_usuario: req.id_usuario,
            observaciones: datos.observaciones
        });
        await m.crearDetallePulpeo(client, pulpeo.id_pulpeo, pulpeo.fecha_hora, datos.temperatura, lotes);
        await m.crearEvidencia(client, {
            id_pulpeo: pulpeo.id_pulpeo,
            nombre_archivo: archivo.name,
            nombre_original: datos.nombre_original,
            mime_type: mimeReal || datos.mime_type,
            tamano_bytes: Number(archivo.size),
            sharepoint_drive_id: idBiblioteca(),
            sharepoint_item_id: archivo.id,
            web_url: archivo.webUrl ?? null,
            descripcion: `Pulpeo ${numero} · tarima ${t.posicion} · ${datos.temperatura} °C`,
            id_usuario: req.id_usuario
        });

        // El trigger diferido revisa aquí que el pulpeo tenga su foto
        await client.query("COMMIT");

        res.status(201).json({
            mensaje: `Pulpeo ${numero} de la tarima ${t.posicion} (${t.codigo_bloque}): ${datos.temperatura} °C, con evidencia.`,
            id_pulpeo: pulpeo.id_pulpeo
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error al confirmar el pulpeo:", error);
        await eliminarArchivo(item_id).catch(() => {});
        if (error.code === "P0001") return res.status(409).json({ error: `${error.message}. Vuelve a tomar el pulpeo.` });
        res.status(500).json({ error: "Error al registrar el pulpeo. No se guardó; vuelve a tomarlo." });
    } finally {
        client.release();
    }
};

export const tarimasController = {
    getBloques,
    getLotes,
    getHistorial,
    armarBloque,
    agregarTarimas,
    retirarTarima,
    crearSesionPulpeo,
    confirmarPulpeo
};
