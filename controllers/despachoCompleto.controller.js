import { db } from "../database/connection.database.js";
import m from "../models/despachoCompleto.model.js";
import despachosModel from "../models/despachos.model.js";

// ============================================================================
// DESPACHO EN UN PASO (asistente) · operativo+
// ============================================================================
// El camión se revisa en el andén: si la caja está bien, se carga y sale.
// Por eso el despacho se registra y se CIERRA en una sola operación:
//
//   1. altas rápidas (operador, tracto, cajas) si no existían
//   2. el servicio de transporte (se reutiliza si ya existe la combinación)
//   3. el documento en borrador (folio de la secuencia)
//   4. la inspección de cada caja (todas aprobadas o no se carga)
//   5. las líneas de picking → los triggers descuentan las cámaras
//   6. el cierre (trg_validar_cierre y trg_validar_cierre_full lo validan)
//
// Todo en UNA transacción: si algo falla no queda ni el operador dado de
// alta ni la fruta descontada.
//
// ⚠️ CONTEXTO DE AUDITORÍA
//   fn_auditar_inocuidad_cierre_despacho registra en despachos_auditoria
//   cada cambio de inocuidad, transporte o estado, y EXIGE que la
//   transacción traiga app.id_usuario (si no, lanza excepción). Por eso se
//   fija al inicio, junto con app.motivo, con set_config(..., true): solo
//   vive dentro de esta transacción.
// ============================================================================

const MOTIVO_AUDITORIA = "Despacho confirmado desde el asistente (inspección y salida)";

class ErrorNegocio extends Error {
    constructor(mensaje, status = 409) {
        super(mensaje);
        this.status = status;
    }
}
const falla = (mensaje, status) => {
    throw new ErrorNegocio(mensaje, status);
};

const compatible = (lineaPieza, linea) => lineaPieza === null || Number(lineaPieza) === Number(linea);

// ---- Resolver piezas (existente o alta rápida) ----
const resolverOperador = async (c, op, idLinea) => {
    if (op.id) {
        const o = await m.getOperador(c, op.id);
        if (!o) falla("El operador indicado no existe");
        if (Number(o.estado) !== 1) falla(`El operador ${o.nombre} está dado de baja`);
        if (!compatible(o.id_linea_fletera, idLinea)) falla(`El operador ${o.nombre} pertenece a otra línea fletera`);
        return { pieza: o, nuevo: false };
    }
    const dup = await m.operadorPorCelular(c, op.nuevo.celular);
    if (dup) falla(`El celular ${op.nuevo.celular} ya pertenece al operador ${dup.nombre}: elígelo de la lista`);
    return { pieza: await m.crearOperador(c, { id_linea_fletera: idLinea, ...op.nuevo }), nuevo: true };
};

const resolverTracto = async (c, tr, idLinea) => {
    if (tr.id) {
        const t = await m.getTracto(c, tr.id);
        if (!t) falla("El tractocamión indicado no existe");
        if (Number(t.estado) !== 1) falla(`El tractocamión ${t.placas} está dado de baja`);
        if (!compatible(t.id_linea_fletera, idLinea)) falla(`El tractocamión ${t.placas} pertenece a otra línea fletera`);
        return { pieza: t, nuevo: false };
    }
    const dup = await m.tractoPorPlacas(c, tr.nuevo.placas);
    if (dup) falla(`Las placas ${dup.placas} ya están registradas como tractocamión: elígelo de la lista`);
    return { pieza: await m.crearTracto(c, { id_linea_fletera: idLinea, ...tr.nuevo }), nuevo: true };
};

const resolverCaja = async (c, cj, idLinea, n) => {
    if (cj.id) {
        const k = await m.getCaja(c, cj.id);
        if (!k) falla(`La caja ${n} no existe`);
        if (Number(k.estado) !== 1) falla(`La caja ${k.placas} está dada de baja`);
        if (!compatible(k.id_linea_fletera, idLinea)) falla(`La caja ${k.placas} pertenece a otra línea fletera`);
        return { pieza: k, nuevo: false };
    }
    const dup = await m.cajaPorPlacas(c, cj.nuevo.placas);
    if (dup) falla(`Las placas ${dup.placas} ya están registradas como caja: elígela de la lista`);
    return { pieza: await m.crearCaja(c, { id_linea_fletera: idLinea, ...cj.nuevo }), nuevo: true };
};

// GET /api/preenfrio/despachos/inventario?id_cc=3&todos=1
// Stock disponible de las cámaras para armar el despacho de un cliente.
const getInventario = async (req, res) => {
    try {
        const idCc = Number(req.query.id_cc);
        if (!Number.isInteger(idCc) || idCc <= 0) {
            return res.status(400).json({ error: "Indica el cliente/CEDIS (id_cc)" });
        }
        const todos = req.query.todos === "1" || req.query.todos === "true";
        const filas = await despachosModel.getDisponibleParaPicking(todos ? null : idCc, req.camaras);
        res.status(200).json(filas.map((f) => ({ ...f, es_de_otro_cliente: Number(f.id_cc) !== idCc })));
    } catch (error) {
        console.error("Error al obtener el inventario:", error);
        res.status(500).json({ error: "Error al obtener el inventario disponible" });
    }
};

// POST /api/preenfrio/despachos/completo
const crearDespachoCompleto = async (req, res) => {
    const d = req.body;

    if (!req.id_usuario) {
        return res.status(401).json({ error: "No se pudo identificar al usuario de la sesión" });
    }

    const client = await db.connect();

    try {
        await client.query("BEGIN");

        // Contexto que exige fn_auditar_inocuidad_cierre_despacho
        await client.query(
            `SELECT set_config('app.id_usuario', $1, true), set_config('app.motivo', $2, true)`,
            [String(req.id_usuario), MOTIVO_AUDITORIA]
        );

        // ---- Destino ----
        const cedis = await m.getCedis(client, d.id_cc);
        if (!cedis) falla("El cliente/CEDIS indicado no existe");
        if (Number(cedis.estado) !== 1) falla(`El destino ${cedis.acronimo} está dado de baja`);

        // ---- Fruta (antes que nada: si no hay, no se da de alta nada) ----
        const ocupaciones = await m.bloquearOcupaciones(client, d.lineas.map((l) => l.id_ocupacion_origen));
        const porId = new Map(ocupaciones.map((o) => [Number(o.id_ocupacion), o]));
        const deOtroCliente = [];

        for (const l of d.lineas) {
            const o = porId.get(l.id_ocupacion_origen);
            if (!o) falla(`La fruta seleccionada (#${l.id_ocupacion_origen}) ya no existe: actualiza el stock`);
            const lote = o.codigo_lote ?? `#${o.id_ocupacion}`;
            if (Number(o.estado) !== 1 || Number(o.tipo_ocupacion) !== 1)
                falla(`El lote ${lote} ya no está disponible en "${o.nombre_camara}": actualiza el stock`);
            if (Array.isArray(req.camaras) && !req.camaras.includes(Number(o.id_camara)))
                falla(`No tienes acceso a "${o.nombre_camara}"`, 403);
            if (l.cantidad_tarimas > Number(o.cantidad_tarimas))
                falla(`Del lote ${lote} solo quedan ${o.cantidad_tarimas} tarimas en "${o.nombre_camara}"`);
            if (l.cantidad_cajas > Number(o.cantidad_cajas))
                falla(`Del lote ${lote} solo quedan ${o.cantidad_cajas} cajas en "${o.nombre_camara}"`);
            if (o.id_cc && Number(o.id_cc) !== d.id_cc) deOtroCliente.push(o);
        }

        if (deOtroCliente.length && !d.confirmar_reasignacion) {
            falla(`Llevas ${deOtroCliente.length} lote(s) planeados para otro cliente. Confirma la reasignación para despacharlos.`);
        }

        // ---- Línea y piezas ----
        const t = d.transporte;
        const linea = await m.getLinea(client, t.id_linea_fletera);
        if (!linea) falla("La línea fletera indicada no existe");
        if (Number(linea.estado) !== 1) falla(`La línea fletera ${linea.razon_social} está dada de baja`);

        const altas = [];
        const operador = await resolverOperador(client, t.operador, linea.id_linea_fletera);
        if (operador.nuevo) altas.push(`operador ${operador.pieza.nombre}`);
        const tracto = await resolverTracto(client, t.tractocamion, linea.id_linea_fletera);
        if (tracto.nuevo) altas.push(`tracto ${tracto.pieza.placas}`);

        const cajas = [];
        for (const [i, cj] of t.cajas.entries()) {
            const r = await resolverCaja(client, cj, linea.id_linea_fletera, i + 1);
            if (r.nuevo) altas.push(`caja ${r.pieza.placas}`);
            cajas.push(r.pieza);
        }
        if (cajas.length === 2 && cajas[0].id_caja_refrigerada === cajas[1].id_caja_refrigerada) {
            falla("En una unidad full las dos cajas deben ser distintas");
        }

        // ---- Servicio de transporte ----
        const combinacion = {
            id_linea_fletera: linea.id_linea_fletera,
            id_operador: operador.pieza.id_operador,
            id_tractocamion: tracto.pieza.id_tractocamion,
            id_caja_1: cajas[0].id_caja_refrigerada,
            id_caja_2: cajas[1]?.id_caja_refrigerada ?? null,
            tipo_unidad: t.tipo_unidad
        };
        let transporte = await m.buscarTransporte(client, combinacion);
        if (transporte && Number(transporte.estado) !== 1) await m.reactivarTransporte(client, transporte.id_transporte);
        if (!transporte) transporte = await m.crearTransporte(client, combinacion);

        // ---- Documento ----
        const despacho = await m.crearDespacho(client, { ...d, id_transporte: transporte.id_transporte });

        // ---- Inspección de las cajas ----
        await m.registrarInspeccion(client, despacho.id_despacho, {
            caja1: d.inspeccion[0],
            caja2: t.tipo_unidad === 2 ? d.inspeccion[1] : null,
            id_usuario: req.id_usuario
        });

        // ---- Picking (los triggers descuentan las cámaras) ----
        for (const l of d.lineas) {
            const o = porId.get(l.id_ocupacion_origen);
            await m.agregarLinea(client, {
                id_despacho: despacho.id_despacho,
                id_produccion: o.id_produccion,
                id_ocupacion_origen: o.id_ocupacion,
                id_camara_origen: o.id_camara,
                cantidad_tarimas: l.cantidad_tarimas,
                cantidad_cajas: l.cantidad_cajas
            });
        }

        // ---- Auditoría de reasignación y cierre ----
        if (deOtroCliente.length) {
            await m.insertarAuditoria(client, {
                id_despacho: despacho.id_despacho,
                motivo: "Despacho confirmado con fruta reasignada de otro cliente",
                cambios: deOtroCliente
                    .map((o) => `Lote ${o.codigo_lote}: planeado para ${o.cliente} ${o.cedis} → ${cedis.cliente} ${cedis.cedis}`)
                    .join("; ")
                    .slice(0, 1000),
                id_usuario: req.id_usuario
            });
        }
        await m.cerrar(client, despacho.id_despacho, deOtroCliente.length > 0);

        await client.query("COMMIT");

        const completo = await m.getDespacho(despacho.id_despacho);
        res.status(201).json({
            mensaje: `Despacho ${completo.folio_despacho} confirmado: ${completo.cantidad_tarimas} tarimas y ${completo.cantidad_cajas} cajas salieron a ${completo.cliente} · ${completo.cedis}`,
            despacho: completo,
            avisos: altas.length ? [`Se dieron de alta: ${altas.join(", ")}.`] : []
        });
    } catch (error) {
        await client.query("ROLLBACK");
        if (error instanceof ErrorNegocio) {
            return res.status(error.status).json({ error: `${error.message}. No se guardó nada.` });
        }
        console.error("Error al confirmar el despacho:", error);
        if (error.code === "P0001") return res.status(409).json({ error: `${error.message}. No se guardó nada.` });
        if (error.code === "23505")
            return res.status(409).json({ error: "Alguno de los datos nuevos ya existe (celular o placas). Actualiza y elígelo de la lista. No se guardó nada." });
        if (error.code === "23503" || error.code === "23514")
            return res.status(409).json({ error: `La BD rechazó el despacho: ${error.message}. No se guardó nada.` });
        res.status(500).json({ error: "Error al confirmar el despacho. No se guardó nada." });
    } finally {
        client.release();
    }
};

export const despachoCompletoController = { getInventario, crearDespachoCompleto };
