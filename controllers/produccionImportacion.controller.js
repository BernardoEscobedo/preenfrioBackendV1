import { db } from "../database/connection.database.js";
import model from "../models/produccionImportacion.model.js";
import { evaluarFilas, marcarYaImportadas, resumir } from "../utils/importacionProduccion.js";

// ============================================================================
// PRODUCCIÓN · IMPORTACIÓN DESDE EXCEL Y ASIGNACIÓN DE PREENFRÍO
// ============================================================================
// FLUJO
//   1. El navegador lee el Excel y manda las filas tal cual vienen.
//   2. POST /vista-previa evalúa cada fila (✅ ⚠️ ❌ u omitida). No guarda.
//   3. El usuario elige destinos, corrige errores y decide lotes; cada
//      cambio vuelve a pedir la vista previa.
//   4. POST /confirmar vuelve a evaluar TODO dentro de una transacción y
//      guarda las filas ✅ y ⚠️, sin cámara.
//   5. El coordinador asigna el preenfrío en PATCH /asignar-camara.
//
// LA CONFIRMACIÓN NO CONFÍA EN LA VISTA PREVIA
//   Entre una y otra puede cambiar un catálogo u otra persona puede subir el
//   mismo archivo. Se recalcula todo bajo un bloqueo, y si el número de
//   filas a guardar no coincide con el que vio el usuario, se le regresa la
//   vista previa nueva en lugar de guardar algo distinto.
// ============================================================================

const LOCK_IMPORTACION = [712026, 3];

const evaluar = async (ejecutor, filas, destinos) => {
    const catalogos = await model.getCatalogos(ejecutor);
    const resultados = evaluarFilas(filas, catalogos, destinos);
    const huellas = [...new Set(resultados.map((r) => r.huella).filter(Boolean))];
    const conteo = await model.contarHuellas(ejecutor, huellas);
    marcarYaImportadas(resultados, conteo);
    return { filas: resultados, ...resumir(resultados) };
};

// GET /api/preenfrio/produccion-importacion/catalogos
const getCatalogos = async (req, res) => {
    try {
        res.status(200).json(await model.getListasCorreccion());
    } catch (error) {
        console.error("Error al obtener catálogos de importación:", error);
        res.status(500).json({ error: "Error al obtener los catálogos" });
    }
};

// POST /api/preenfrio/produccion-importacion/vista-previa
// body: { filas: [...], destinos: { "CLAVE": id_cc } }
const vistaPrevia = async (req, res) => {
    try {
        const { filas, destinos } = req.body;
        res.status(200).json(await evaluar(db, filas, destinos));
    } catch (error) {
        console.error("Error en la vista previa:", error);
        res.status(500).json({ error: "Error al evaluar el archivo" });
    }
};

// POST /api/preenfrio/produccion-importacion/confirmar
// body: { filas, destinos, nombre_archivo, esperadas }
const confirmar = async (req, res) => {
    const { filas, destinos, nombre_archivo, esperadas } = req.body;
    const client = await db.connect();

    try {
        await client.query("BEGIN");
        // Dos personas subiendo el mismo archivo a la vez no deben duplicar
        await client.query("SELECT pg_advisory_xact_lock($1, $2)", LOCK_IMPORTACION);

        const evaluacion = await evaluar(client, filas, destinos);
        const aGuardar = evaluacion.filas.filter((r) => r.estado === "ok" || r.estado === "aviso");

        if (esperadas !== undefined && aGuardar.length !== esperadas) {
            await client.query("ROLLBACK");
            return res.status(409).json({
                error: `La validación cambió desde la vista previa: ahora se guardarían ${aGuardar.length} fila(s), no ${esperadas}. Revisa la vista previa actualizada.`,
                vista_previa: evaluacion
            });
        }

        if (aGuardar.length === 0) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "No hay filas listas para guardar", vista_previa: evaluacion });
        }

        // Equivalencias elegidas a mano: solo las de filas que se guardan
        const nuevas = new Map();
        for (const r of aGuardar) {
            if (r.destino.origen === "seleccion") nuevas.set(r.destino.clave, r.destino);
        }
        await model.guardarEquivalencias(client, [...nuevas.values()], req.id_usuario ?? null);

        const id_importacion = await model.crearImportacion(client, {
            nombre_archivo: nombre_archivo ?? null,
            filas_archivo: evaluacion.resumen.total,
            filas_insertadas: aGuardar.length,
            filas_omitidas: evaluacion.resumen.omitida,
            filas_con_error: evaluacion.resumen.error,
            id_usuario: req.id_usuario ?? null
        });

        const ids = await model.insertarFilas(
            client,
            aGuardar.map((r) => ({ ...r.datos, huella: r.huella })),
            id_importacion
        );

        await client.query("COMMIT");

        res.status(201).json({
            mensaje: `Se guardaron ${ids.length} línea(s) de producción. Falta asignarles preenfrío.`,
            id_importacion,
            insertadas: ids.length,
            omitidas: evaluacion.resumen.omitida,
            con_error: evaluacion.resumen.error,
            equivalencias_guardadas: nuevas.size
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error al confirmar la importación:", error);
        if (["23503", "23514", "P0001"].includes(error.code)) {
            return res.status(409).json({ error: `La BD rechazó la carga: ${error.message}` });
        }
        res.status(500).json({ error: "Error al guardar la producción. No se guardó ninguna fila." });
    } finally {
        client.release();
    }
};

// GET /api/preenfrio/produccion-importacion/sin-camara?semana=41&fecha_empaque=2026-10-06
const getSinCamara = async (req, res) => {
    try {
        const { semana, fecha_empaque } = req.query;
        res.status(200).json(
            await model.getSinCamara({
                semana: semana ? Number(semana) : null,
                fecha_empaque: fecha_empaque || null
            })
        );
    } catch (error) {
        console.error("Error al obtener producción sin cámara:", error);
        res.status(500).json({ error: "Error al obtener la producción sin preenfrío" });
    }
};

// GET /api/preenfrio/produccion-importacion/camaras
const getCamaras = async (req, res) => {
    try {
        res.status(200).json(await model.getCamarasPreenfrio());
    } catch (error) {
        console.error("Error al obtener cámaras:", error);
        res.status(500).json({ error: "Error al obtener las cámaras de preenfrío" });
    }
};

// PATCH /api/preenfrio/produccion-importacion/asignar-camara
// body: { ids: [..], id_camara }
// Para quitar una cámara asignada por error: PATCH /produccion/:id/camara
// con id_camara null (bloqueado si ya hubo recepciones).
const asignarCamara = async (req, res) => {
    const { ids, id_camara } = req.body;
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        const camara = await model.getCamaraById(client, id_camara);
        if (!camara) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: "La cámara indicada no existe" });
        }
        if (Number(camara.estado) !== 1) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: `"${camara.nombre_camara}" está fuera de servicio` });
        }
        if (Number(camara.tipo_camara) !== 1) {
            await client.query("ROLLBACK");
            return res.status(409).json({
                error: `"${camara.nombre_camara}" es de conservación: la planeación solo asigna preenfrío`
            });
        }

        const filas = await model.getParaAsignar(client, ids);
        const problemas = [];
        if (filas.length !== ids.length) problemas.push(`${ids.length - filas.length} línea(s) no existen`);
        for (const f of filas) {
            if (Number(f.estado) === 0) problemas.push(`${f.codigo_lote} está cancelada`);
            else if (f.id_camara !== null) problemas.push(`${f.codigo_lote} ya tiene preenfrío asignado`);
            else if (f.recepciones > 0) problemas.push(`${f.codigo_lote} ya tiene recepciones`);
        }
        if (problemas.length) {
            await client.query("ROLLBACK");
            return res.status(409).json({ error: `No se asignó nada: ${problemas.slice(0, 5).join("; ")}` });
        }

        await model.asignarCamara(client, ids, id_camara);
        await client.query("COMMIT");

        const tarimas = filas.reduce((s, f) => s + Number(f.estiba_pallets ?? 0), 0);
        const avisos = [];
        if (tarimas > Number(camara.capacidad_max_tarimas)) {
            avisos.push(
                `Asignaste ${tarimas} tarimas y "${camara.nombre_camara}" recibe ${camara.capacidad_max_tarimas} por ciclo: el excedente esperará en cola.`
            );
        }

        res.status(200).json({
            mensaje: `${ids.length} línea(s) (${tarimas} tarimas) asignadas a "${camara.nombre_camara}"`,
            asignadas: ids.length,
            tarimas,
            avisos
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Error al asignar cámara:", error);
        res.status(500).json({ error: "Error al asignar el preenfrío" });
    } finally {
        client.release();
    }
};

export const produccionImportacionController = {
    getCatalogos,
    vistaPrevia,
    confirmar,
    getSinCamara,
    getCamaras,
    asignarCamara
};
