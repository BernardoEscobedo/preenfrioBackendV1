import bajasModel from "../models/bajas.model.js";
import { conContextoAuditoria } from "../utils/auditoriaContexto.js";

// ============================================================================
// BAJAS DE CÁMARAS Y EMPLEADOS · HISTORIAL
// ============================================================================
// Todo el módulo es SOLO ADMIN.
//
// Sustituye al borrado físico de cámaras y empleados. La baja es lógica
// (estado = 0) y siempre queda en el historial con quién la hizo, cuándo y
// por qué. Lo escribe el trigger fn_registrar_cambio_estado: este
// controller solo fija el contexto con conContextoAuditoria.
// ============================================================================

// ----------------------------------------------------------------------------
// PATCH /api/preenfrio/bajas/camaras/:id
// ----------------------------------------------------------------------------
// Una cámara se da de baja VACÍA y SIN PENDIENTES. Si tiene fruta, cola,
// mantenimiento en proceso o producción que todavía espera llegar ahí, se
// rechaza con el detalle de lo que falta resolver.
const bajaCamara = async (req, res) => {
    try {
        const { id } = req.params;
        const { motivo } = req.body;

        const camara = await bajasModel.getCamara(id);

        if (!camara) {
            return res.status(404).json({ error: "Cámara no encontrada" });
        }

        if (Number(camara.estado) === 0) {
            return res.status(409).json({
                error: `La cámara "${camara.nombre_camara}" ya está dada de baja`
            });
        }

        const imp = await bajasModel.getImpedimentosCamara(id);

        const pendientes = [];

        if (imp.tarimas_dentro > 0) {
            pendientes.push(`Tiene ${imp.tarimas_dentro} tarima(s) dentro: trasládalas o despáchalas.`);
        }

        if (imp.tarimas_en_cola > 0) {
            pendientes.push(`Tiene ${imp.tarimas_en_cola} tarima(s) en cola esperando entrar.`);
        }

        if (imp.mantenimiento_activo) {
            pendientes.push("Tiene un mantenimiento en proceso: finalízalo primero.");
        }

        if (imp.producciones_pendientes > 0) {
            pendientes.push(`Hay ${imp.producciones_pendientes} producción(es) planeadas que todavía esperan llegar a esta cámara: reasígnalas.`);
        }

        if (pendientes.length > 0) {
            return res.status(409).json({
                error: `No se puede dar de baja "${camara.nombre_camara}" todavía.`,
                pendientes
            });
        }

        const actualizada = await conContextoAuditoria(
            { id_usuario: req.id_usuario, motivo },
            (client) => bajasModel.setEstadoCamara(client, id, 0)
        );

        const avisos = [];

        // No se cierran sus asignaciones: si la cámara se reactiva, sus
        // supervisores la recuperan sin reconfigurar nada. Mientras esté de
        // baja, fn_camaras_usuario la excluye.
        if (imp.usuarios_asignados > 0) {
            avisos.push(
                `${imp.usuarios_asignados} usuario(s) la tenían asignada y dejarán de verla. Revisa que no se queden sin zona de trabajo (GET /usuarios/sincamaras).`
            );
        }

        res.status(200).json({
            mensaje: `Cámara "${actualizada.nombre_camara}" dada de baja. Quedó registrado en el historial.`,
            camara: actualizada,
            avisos
        });
    } catch (error) {
        console.error("Error al dar de baja la camara:", error);
        res.status(500).json({ error: "Error al dar de baja la cámara" });
    }
};

// PATCH /api/preenfrio/bajas/camaras/:id/reactivar
const reactivarCamara = async (req, res) => {
    try {
        const { id } = req.params;
        const { motivo } = req.body;

        const camara = await bajasModel.getCamara(id);

        if (!camara) {
            return res.status(404).json({ error: "Cámara no encontrada" });
        }

        if (Number(camara.estado) === 1) {
            return res.status(409).json({
                error: `La cámara "${camara.nombre_camara}" ya está operativa`
            });
        }

        const actualizada = await conContextoAuditoria(
            { id_usuario: req.id_usuario, motivo },
            (client) => bajasModel.setEstadoCamara(client, id, 1)
        );

        res.status(200).json({
            mensaje: `Cámara "${actualizada.nombre_camara}" reactivada. Sus usuarios asignados vuelven a verla.`,
            camara: actualizada
        });
    } catch (error) {
        console.error("Error al reactivar la camara:", error);
        res.status(500).json({ error: "Error al reactivar la cámara" });
    }
};

// ----------------------------------------------------------------------------
// PATCH /api/preenfrio/bajas/empleados/:id
// ----------------------------------------------------------------------------
// Dar de baja a un empleado deshabilita su cuenta en la misma transacción
// (trigger fn_baja_empleado_cascada). En el historial quedan las DOS
// entradas: la del empleado y la de su cuenta, con el mismo motivo.
const bajaEmpleado = async (req, res) => {
    try {
        const { id } = req.params;
        const { motivo } = req.body;

        const empleado = await bajasModel.getEmpleado(id);

        if (!empleado) {
            return res.status(404).json({ error: "Empleado no encontrado" });
        }

        if (Number(empleado.estado) === 0) {
            return res.status(409).json({
                error: `${empleado.nombre} ${empleado.apellidos} ya está dado de baja`
            });
        }

        // Darse de baja a sí mismo cortaría la sesión a media operación
        if (empleado.id_usuario && Number(empleado.id_usuario) === Number(req.id_usuario)) {
            return res.status(409).json({
                error: "No puedes darte de baja a ti mismo"
            });
        }

        // Nunca dejar el sistema sin un administrador activo
        if (
            empleado.id_usuario &&
            Number(empleado.id_role) === 1 &&
            Number(empleado.usuario_estado) === 1
        ) {
            const otros = await bajasModel.contarOtrosAdminsActivos(id);

            if (otros === 0) {
                return res.status(409).json({
                    error: "Es el único administrador activo del sistema: si se da de baja, nadie podría administrarlo."
                });
            }
        }

        const actualizado = await conContextoAuditoria(
            { id_usuario: req.id_usuario, motivo },
            (client) => bajasModel.setEstadoEmpleado(client, id, 0)
        );

        const cuentaDeshabilitada =
            empleado.id_usuario && Number(empleado.usuario_estado) === 1;

        res.status(200).json({
            mensaje: `${actualizado.nombre} ${actualizado.apellidos} dado de baja. Quedó registrado en el historial.`,
            empleado: actualizado,
            cuenta: cuentaDeshabilitada
                ? `Su cuenta "${empleado.usuario}" se deshabilitó: pierde el acceso en su siguiente acción.`
                : null
        });
    } catch (error) {
        console.error("Error al dar de baja el empleado:", error);
        res.status(500).json({ error: "Error al dar de baja el empleado" });
    }
};

// PATCH /api/preenfrio/bajas/empleados/:id/reactivar
// La cuenta NO se reactiva sola: volver a dar acceso es una decisión aparte
// (PATCH /usuarios/habilitar/:id).
const reactivarEmpleado = async (req, res) => {
    try {
        const { id } = req.params;
        const { motivo } = req.body;

        const empleado = await bajasModel.getEmpleado(id);

        if (!empleado) {
            return res.status(404).json({ error: "Empleado no encontrado" });
        }

        if (Number(empleado.estado) === 1) {
            return res.status(409).json({
                error: `${empleado.nombre} ${empleado.apellidos} ya está activo`
            });
        }

        const actualizado = await conContextoAuditoria(
            { id_usuario: req.id_usuario, motivo },
            (client) => bajasModel.setEstadoEmpleado(client, id, 1)
        );

        res.status(200).json({
            mensaje: `${actualizado.nombre} ${actualizado.apellidos} reactivado.`,
            empleado: actualizado,
            aviso: empleado.id_usuario && Number(empleado.usuario_estado) === 0
                ? `Su cuenta "${empleado.usuario}" sigue deshabilitada. Habilítala desde Usuarios si debe volver a entrar.`
                : null
        });
    } catch (error) {
        console.error("Error al reactivar el empleado:", error);
        res.status(500).json({ error: "Error al reactivar el empleado" });
    }
};

// ----------------------------------------------------------------------------
// GET /api/preenfrio/bajas/historial
// ----------------------------------------------------------------------------
//   ?tabla=camaras|empleados|usuarios   ?id_registro=3
//   ?accion=BAJA|REACTIVACION           ?fecha_desde=...&fecha_hasta=...
const TABLAS_VALIDAS = ["camaras", "empleados", "usuarios"];
const ACCIONES_VALIDAS = ["BAJA", "REACTIVACION", "CAMBIO"];

const getHistorial = async (req, res) => {
    try {
        const { tabla, id_registro, accion, fecha_desde, fecha_hasta } = req.query;

        if (tabla && !TABLAS_VALIDAS.includes(tabla)) {
            return res.status(400).json({
                error: `El filtro "tabla" debe ser: ${TABLAS_VALIDAS.join(", ")}`
            });
        }

        const accionNorm = accion ? String(accion).toUpperCase() : null;

        if (accionNorm && !ACCIONES_VALIDAS.includes(accionNorm)) {
            return res.status(400).json({
                error: `El filtro "accion" debe ser: ${ACCIONES_VALIDAS.join(", ")}`
            });
        }

        const historial = await bajasModel.getHistorial({
            tabla: tabla || null,
            id_registro: id_registro ? Number(id_registro) : null,
            accion: accionNorm,
            fecha_desde: fecha_desde || null,
            fecha_hasta: fecha_hasta || null
        });

        res.status(200).json({
            resumen: {
                total: historial.length,
                bajas: historial.filter((h) => h.accion === "BAJA").length,
                reactivaciones: historial.filter((h) => h.accion === "REACTIVACION").length,
                // Cambios sin usuario: se hicieron por SQL, fuera de la app
                fuera_del_sistema: historial.filter((h) => h.hecho_fuera_del_sistema).length
            },
            historial
        });
    } catch (error) {
        console.error("Error al obtener el historial:", error);
        res.status(500).json({ error: "Error al obtener el historial" });
    }
};

// GET /api/preenfrio/bajas/inactivos
// Todo lo que está dado de baja ahora, con su última baja. Es la pantalla
// desde la que el admin reactiva.
const getDadosDeBaja = async (req, res) => {
    try {
        const registros = await bajasModel.getDadosDeBaja();
        res.status(200).json(registros);
    } catch (error) {
        console.error("Error al obtener los dados de baja:", error);
        res.status(500).json({ error: "Error al obtener los registros dados de baja" });
    }
};

export const bajasController = {
    bajaCamara,
    reactivarCamara,
    bajaEmpleado,
    reactivarEmpleado,
    getHistorial,
    getDadosDeBaja
};
