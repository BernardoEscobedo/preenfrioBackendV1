import { db } from "../database/connection.database.js";
import m, { PREFIJO_OBSERVACION } from "../models/movimientoBloque.model.js";

// ============================================================================
// POST /api/preenfrio/movimientos/bloque · supervisor+
// ============================================================================
// Saca un bloque del preenfrío y lo pasa a conservación, completo o solo
// las tarimas elegidas (las que no han llegado a la temperatura óptima se
// quedan). En UNA transacción:
//
//   1. Suma lo que llevan las tarimas elegidas, por lote.
//   2. Por cada lote toma sus ocupaciones en el preenfrío (las más antiguas
//      primero) y crea los movimientos tipo 2. El trigger de siempre
//      descuenta el preenfrío y suma la conserva.
//   3. Cambia la ubicación de las tarimas a la conserva.
//
// TARIMAS MIXTAS
//   Una tarima con varios lotes cuenta como 1 tarima para el lote que más
//   cajas lleva; los demás lotes viajan solo con sus cajas. Así el total de
//   tarimas movidas coincide con las tarimas físicas.
//
// Si el inventario del preenfrío no alcanza para lo que dicen las tarimas
// (por ejemplo, ya se despachó parte), no se mueve nada y se dice qué lote.
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

const sinAlcance = (req, id) => Array.isArray(req.camaras) && !req.camaras.includes(Number(id));

const trasladarBloque = async (req, res) => {
    const { id_bloque, id_tarimas, id_camara_destino, fecha_movimiento, hora_movimiento, temperatura, observaciones } = req.body;
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        // ---- Bloque y tarimas ----
        const bloque = await m.getBloque(client, id_bloque);
        if (!bloque) falla("El bloque no existe", 404);
        if (Number(bloque.estado) !== 1) falla(`El bloque ${bloque.codigo_bloque} está desarmado`);

        const activas = await m.getTarimas(client, id_bloque);
        await m.bloquearTarimas(client, activas.map((t) => t.id_tarima));
        const porId = new Map(activas.map((t) => [Number(t.id_tarima), t]));

        const elegidas = id_tarimas.map((id) => porId.get(id));
        if (elegidas.some((t) => !t)) falla("Alguna tarima ya no está en el bloque: actualiza la pantalla");

        const origenes = new Set(elegidas.map((t) => Number(t.id_camara)));
        if (origenes.size > 1) falla("Las tarimas elegidas están en cámaras distintas: trasládalas por separado");
        const idOrigen = [...origenes][0];

        // ---- Cámaras ----
        const origen = await m.getCamara(client, idOrigen);
        if (Number(origen.tipo_camara) !== 1) falla(`Las tarimas ya están en "${origen.nombre_camara}", que no es preenfrío`);
        if (sinAlcance(req, idOrigen)) falla(`No tienes acceso a "${origen.nombre_camara}"`, 403);

        const destino = await m.getCamara(client, id_camara_destino);
        if (!destino) falla("La cámara destino no existe");
        if (Number(destino.estado) !== 1) falla(`"${destino.nombre_camara}" está fuera de servicio`);
        if (Number(destino.tipo_camara) !== 2) falla(`"${destino.nombre_camara}" no es de conservación`);
        if (sinAlcance(req, id_camara_destino)) falla(`No tienes acceso a "${destino.nombre_camara}"`, 403);

        // ---- Qué se mueve, por lote ----
        const porLote = new Map();
        for (const t of elegidas) {
            if (!t.lotes.length) falla(`La tarima ${t.posicion} no tiene lotes registrados`);
            t.lotes.forEach((l, i) => {
                const actual = porLote.get(l.id_produccion) ?? { codigo_lote: l.codigo_lote, tarimas: 0, cajas: 0 };
                actual.cajas += Number(l.cantidad_cajas);
                if (i === 0) actual.tarimas += 1; // el lote con más cajas lleva la tarima
                porLote.set(l.id_produccion, actual);
            });
        }

        // ---- Movimientos (el trigger mueve el inventario) ----
        const ahora = await m.ahoraLocal(client);
        const fecha = fecha_movimiento ?? ahora.fecha;
        const hora = hora_movimiento ?? ahora.hora;
        const posiciones = elegidas.map((t) => t.posicion).join(",");
        const nota = `${PREFIJO_OBSERVACION} ${bloque.codigo_bloque} · T${posiciones}${observaciones ? ` · ${observaciones}` : ""}`.slice(0, 250);

        let movimientos = 0;
        for (const [idProd, l] of porLote) {
            const ocupaciones = await m.getOcupacionesLote(client, idOrigen, idProd);
            const hayCajas = ocupaciones.reduce((s, o) => s + Number(o.cantidad_cajas), 0);
            const hayTarimas = ocupaciones.reduce((s, o) => s + Number(o.cantidad_tarimas), 0);
            if (hayCajas < l.cajas || hayTarimas < l.tarimas) {
                falla(`Del lote ${l.codigo_lote} el bloque dice ${l.tarimas} tar / ${l.cajas} cj, pero en "${origen.nombre_camara}" hay ${hayTarimas} tar / ${hayCajas} cj. Revisa si ya salió fruta de ese lote.`);
            }

            let faltanCajas = l.cajas;
            let faltanTarimas = l.tarimas;
            for (const o of ocupaciones) {
                if (faltanCajas <= 0 && faltanTarimas <= 0) break;
                const cajas = Math.min(faltanCajas, Number(o.cantidad_cajas));
                let tarimas = Math.min(faltanTarimas, Number(o.cantidad_tarimas));
                if (tarimas > cajas && cajas > 0) tarimas = cajas;
                if (cajas === 0 && tarimas === 0) continue;
                await m.crearMovimiento(client, {
                    id_produccion: idProd,
                    id_ocupacion_origen: o.id_ocupacion,
                    id_camara_origen: idOrigen,
                    id_camara_destino,
                    fecha,
                    hora,
                    tarimas,
                    cajas,
                    temperatura,
                    id_usuario: req.id_usuario,
                    observaciones: nota
                });
                movimientos += 1;
                faltanCajas -= cajas;
                faltanTarimas -= tarimas;
            }
            if (faltanCajas > 0 || faltanTarimas > 0) {
                falla(`No se pudo repartir el lote ${l.codigo_lote} entre sus montones del preenfrío. No se movió nada.`);
            }
        }

        // ---- Ubicación de las tarimas ----
        await m.moverTarimas(client, elegidas.map((t) => t.id_tarima), id_camara_destino, `${fecha} ${hora}`);
        const quedan = activas.filter((t) => Number(t.id_camara) === idOrigen).length - elegidas.length;
        if (quedan <= 0) await m.setCamaraBloque(client, id_bloque, id_camara_destino);

        await client.query("COMMIT");

        const cajas = [...porLote.values()].reduce((s, l) => s + l.cajas, 0);
        res.status(201).json({
            mensaje: `Bloque ${bloque.codigo_bloque}: ${elegidas.length} tarima(s) y ${cajas} cajas pasaron de "${origen.nombre_camara}" a "${destino.nombre_camara}"`,
            movimientos,
            avisos: quedan > 0 ? [`${quedan} tarima(s) del bloque se quedan en "${origen.nombre_camara}".`] : []
        });
    } catch (error) {
        await client.query("ROLLBACK");
        if (error instanceof ErrorNegocio) return res.status(error.status).json({ error: error.message });
        console.error("Error al trasladar el bloque:", error);
        if (error.code === "P0001") return res.status(409).json({ error: error.message });
        res.status(500).json({ error: "Error al trasladar el bloque. No se movió nada." });
    } finally {
        client.release();
    }
};

export const movimientoBloqueController = { trasladarBloque };
