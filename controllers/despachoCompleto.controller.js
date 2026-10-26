import { db } from "../database/connection.database.js";
import m from "../models/despachoCompleto.model.js";
import t from "../models/despachoTarimas.model.js";

// ============================================================================
// DESPACHO EN UN PASO (asistente) · operativo+
// ============================================================================
// El camión se revisa en el andén: si la caja está bien, se carga y sale.
// El despacho se registra y se CIERRA en una sola transacción:
//
//   1. altas rápidas (operador, tracto, cajas) si no existían
//   2. el servicio de transporte (se reutiliza si ya existe la combinación)
//   3. el documento en borrador (folio de la secuencia)
//   4. la inspección de cada caja (todas aprobadas o no se carga)
//   5. las TARIMAS elegidas → líneas de picking por lote; los triggers
//      descuentan las cámaras
//   6. las tarimas salen de su bloque (y el bloque vacío se desarma)
//   7. el cierre (trg_validar_cierre y trg_validar_cierre_full)
//
// SALE POR TARIMA FÍSICA DE BLOQUE
//   Completa, media o mixta: sube la tarima entera con lo que lleva. No se
//   sacan cajas sueltas ni bloques completos.
//
//   Por lote se descuentan sus cajas exactas. Cada tarima cuenta como 1 y se
//   le carga al lote que más cajas lleva en ella; los demás lotes de una
//   tarima mixta salen solo con cajas. Así el despacho dice cuántas tarimas
//   salieron de verdad.
//
//   Si un montón se queda en 0 cajas, trg_cerrar_tarimas_sin_cajas cierra
//   sus tarimas sobrantes (no quedan tarimas fantasma).
//
// ⚠️ CONTEXTO DE AUDITORÍA
//   fn_auditar_inocuidad_cierre_despacho EXIGE app.id_usuario en la
//   transacción. Se fija al inicio junto con app.motivo.
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
        const x = await m.getTracto(c, tr.id);
        if (!x) falla("El tractocamión indicado no existe");
        if (Number(x.estado) !== 1) falla(`El tractocamión ${x.placas} está dado de baja`);
        if (!compatible(x.id_linea_fletera, idLinea)) falla(`El tractocamión ${x.placas} pertenece a otra línea fletera`);
        return { pieza: x, nuevo: false };
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

// ----------------------------------------------------------------------------
// GET /api/preenfrio/despachos/tarimas?id_cc=3&todos=1
// ----------------------------------------------------------------------------
// Bloques con sus tarimas, para elegir cuáles suben al camión.
const getTarimas = async (req, res) => {
    try {
        const idCc = Number(req.query.id_cc);
        if (!Number.isInteger(idCc) || idCc <= 0) {
            return res.status(400).json({ error: "Indica el cliente/CEDIS (id_cc)" });
        }
        const todos = req.query.todos === "1" || req.query.todos === "true";

        const filas = await t.getTarimasDisponibles(idCc, todos, req.camaras);
        const bloques = new Map();
        for (const f of filas) {
            const lotes = f.lotes ?? [];
            const b = bloques.get(f.id_bloque) ?? {
                id_bloque: f.id_bloque,
                codigo_bloque: f.codigo_bloque,
                posiciones: f.posiciones,
                tarimas: []
            };
            b.tarimas.push({
                id_tarima: f.id_tarima,
                posicion: f.posicion,
                id_camara: f.id_camara,
                nombre_camara: f.nombre_camara,
                horas: f.horas,
                ultima_temperatura: f.ultima_temperatura,
                cajas: f.cajas,
                fecha_empaque: f.fecha_empaque,
                lotes,
                mixta: lotes.length > 1,
                de_otro_cliente: lotes.some((l) => Number(l.id_cc) !== idCc)
            });
            bloques.set(f.id_bloque, b);
        }

        const sinBloque = await t.getSinBloque(idCc, req.camaras);
        res.status(200).json({ bloques: [...bloques.values()], sin_bloque: sinBloque });
    } catch (error) {
        console.error("Error al obtener las tarimas:", error);
        res.status(500).json({ error: "Error al obtener las tarimas disponibles" });
    }
};

// ----------------------------------------------------------------------------
// Tarimas → líneas de picking por montón
// ----------------------------------------------------------------------------
// Devuelve [{ id_ocupacion, id_produccion, id_camara, tarimas, cajas }].
const armarLineas = async (client, tarimas) => {
    // Por cámara y lote: cajas exactas y tarimas físicas (al lote mayor)
    const porLote = new Map();
    for (const ta of tarimas) {
        ta.lotes.forEach((l, i) => {
            const k = `${ta.id_camara}|${l.id_produccion}`;
            const a = porLote.get(k) ?? {
                id_camara: Number(ta.id_camara),
                nombre_camara: ta.nombre_camara,
                id_produccion: Number(l.id_produccion),
                codigo_lote: l.codigo_lote,
                cajas: 0,
                tarimas: 0
            };
            a.cajas += Number(l.cantidad_cajas);
            if (i === 0) a.tarimas += 1;
            porLote.set(k, a);
        });
    }

    const lineas = [];
    for (const l of porLote.values()) {
        const montones = await t.getOcupacionesLote(client, l.id_camara, l.id_produccion);
        const hay = montones.reduce((s, o) => s + Number(o.cantidad_cajas), 0);
        if (hay < l.cajas) {
            falla(`Del lote ${l.codigo_lote} las tarimas dicen ${l.cajas} cajas, pero en "${l.nombre_camara}" hay ${hay}. Revisa el bloque: ¿ya salió fruta de ese lote?`);
        }

        // 1) Cajas, del montón más antiguo al más nuevo
        const propias = [];
        let resta = l.cajas;
        for (const o of montones) {
            if (resta <= 0) break;
            const cajas = Math.min(resta, Number(o.cantidad_cajas));
            propias.push({ o, cajas, tarimas: 0 });
            resta -= cajas;
        }

        // 2) Tarimas sobre esos mismos montones, sin pasar de lo que tienen
        let restaTar = l.tarimas;
        for (const p of propias) {
            if (restaTar <= 0) break;
            const tar = Math.min(restaTar, Number(p.o.cantidad_tarimas), p.cajas);
            p.tarimas = tar;
            restaTar -= tar;
        }

        for (const p of propias) {
            lineas.push({
                id_ocupacion: p.o.id_ocupacion,
                id_produccion: l.id_produccion,
                id_camara: l.id_camara,
                tarimas: p.tarimas,
                cajas: p.cajas
            });
        }
    }
    return lineas;
};

// ----------------------------------------------------------------------------
// POST /api/preenfrio/despachos/completo
// ----------------------------------------------------------------------------
const crearDespachoCompleto = async (req, res) => {
    const d = req.body;

    if (!req.id_usuario) {
        return res.status(401).json({ error: "No se pudo identificar al usuario de la sesión" });
    }

    const client = await db.connect();

    try {
        await client.query("BEGIN");

        await client.query(
            `SELECT set_config('app.id_usuario', $1, true), set_config('app.motivo', $2, true)`,
            [String(req.id_usuario), MOTIVO_AUDITORIA]
        );

        // ---- Destino ----
        const cedis = await m.getCedis(client, d.id_cc);
        if (!cedis) falla("El cliente/CEDIS indicado no existe");
        if (Number(cedis.estado) !== 1) falla(`El destino ${cedis.acronimo} está dado de baja`);

        // ---- Tarimas (antes que nada: si no están, no se da de alta nada) ----
        const tarimas = await t.bloquearTarimas(client, d.id_tarimas);
        if (tarimas.length !== d.id_tarimas.length) falla("Alguna tarima ya no existe: actualiza la lista");

        const deOtroCliente = [];
        for (const ta of tarimas) {
            const nombre = `tarima ${ta.posicion} del bloque ${ta.codigo_bloque}`;
            if (Number(ta.estado) !== 1 || Number(ta.estado_bloque) !== 1) falla(`La ${nombre} ya salió o su bloque está desarmado: actualiza la lista`);
            if (Array.isArray(req.camaras) && !req.camaras.includes(Number(ta.id_camara)))
                falla(`No tienes acceso a "${ta.nombre_camara}"`, 403);
            if (!ta.lotes.length) falla(`La ${nombre} no tiene lotes registrados`);
            for (const l of ta.lotes) {
                if (l.id_cc && Number(l.id_cc) !== d.id_cc) deOtroCliente.push({ ...l, tarima: nombre });
            }
        }

        if (deOtroCliente.length && !d.confirmar_reasignacion) {
            falla(`Llevas fruta planeada para otro cliente (${deOtroCliente.length} lote(s)). Confirma la reasignación para despacharla.`);
        }

        const lineasPicking = await armarLineas(client, tarimas);

        // ---- Línea y piezas ----
        const tr = d.transporte;
        const linea = await m.getLinea(client, tr.id_linea_fletera);
        if (!linea) falla("La línea fletera indicada no existe");
        if (Number(linea.estado) !== 1) falla(`La línea fletera ${linea.razon_social} está dada de baja`);

        const altas = [];
        const operador = await resolverOperador(client, tr.operador, linea.id_linea_fletera);
        if (operador.nuevo) altas.push(`operador ${operador.pieza.nombre}`);
        const tracto = await resolverTracto(client, tr.tractocamion, linea.id_linea_fletera);
        if (tracto.nuevo) altas.push(`tracto ${tracto.pieza.placas}`);

        const cajas = [];
        for (const [i, cj] of tr.cajas.entries()) {
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
            tipo_unidad: tr.tipo_unidad
        };
        let transporte = await m.buscarTransporte(client, combinacion);
        if (transporte && Number(transporte.estado) !== 1) await m.reactivarTransporte(client, transporte.id_transporte);
        if (!transporte) transporte = await m.crearTransporte(client, combinacion);

        // ---- Documento ----
        const despacho = await m.crearDespacho(client, { ...d, id_transporte: transporte.id_transporte });

        // ---- Inspección de las cajas ----
        await m.registrarInspeccion(client, despacho.id_despacho, {
            caja1: d.inspeccion[0],
            caja2: tr.tipo_unidad === 2 ? d.inspeccion[1] : null,
            id_usuario: req.id_usuario
        });

        // ---- Picking (los triggers descuentan las cámaras) ----
        for (const l of lineasPicking) {
            await m.agregarLinea(client, {
                id_despacho: despacho.id_despacho,
                id_produccion: l.id_produccion,
                id_ocupacion_origen: l.id_ocupacion,
                id_camara_origen: l.id_camara,
                cantidad_tarimas: l.tarimas,
                cantidad_cajas: l.cajas
            });
        }

        // ---- Las tarimas salen de su bloque ----
        await t.retirarTarimas(client, d.id_tarimas, despacho.id_despacho);
        const desarmados = await t.cerrarBloquesVacios(client, [...new Set(tarimas.map((x) => x.id_bloque))]);

        // ---- Auditoría de reasignación y cierre ----
        if (deOtroCliente.length) {
            await m.insertarAuditoria(client, {
                id_despacho: despacho.id_despacho,
                motivo: "Despacho confirmado con fruta reasignada de otro cliente",
                cambios: deOtroCliente
                    .map((l) => `Lote ${l.codigo_lote} (${l.tarima}): planeado para ${l.cliente} ${l.cedis} → ${cedis.cliente} ${cedis.cedis}`)
                    .join("; ")
                    .slice(0, 1000),
                id_usuario: req.id_usuario
            });
        }
        await m.cerrar(client, despacho.id_despacho, deOtroCliente.length > 0);

        await client.query("COMMIT");

        const completo = await m.getDespacho(despacho.id_despacho);
        const avisos = [];
        if (altas.length) avisos.push(`Se dieron de alta: ${altas.join(", ")}.`);
        if (desarmados.length) avisos.push(`Bloque(s) ${desarmados.join(", ")} quedaron vacíos y se desarmaron.`);

        res.status(201).json({
            mensaje: `Despacho ${completo.folio_despacho} confirmado: ${completo.cantidad_tarimas} tarimas y ${completo.cantidad_cajas} cajas salieron a ${completo.cliente} · ${completo.cedis}`,
            despacho: completo,
            avisos
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

export const despachoCompletoController = { getTarimas, crearDespachoCompleto };
