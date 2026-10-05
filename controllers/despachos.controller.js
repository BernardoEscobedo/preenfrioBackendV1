import despachosModel from "../models/despachos.model.js";
import ocupacionesModel from "../models/ocupaciones.model.js";
import transportesModel from "../models/transportes.model.js";
import cedisModel from "../models/cedis.model.js";

// ============================================================================
// DESPACHOS
// ============================================================================
// req.camaras lo pone cargarAlcance:
//     null  -> Admin / Coordinador
//     [...] -> Supervisor / Operativo
//
// ⚠️ ESTE CONTROLLER NO TOCA ocupaciones_camaras
//   Agregar una línea dispara trg_despacho_detalle_movimiento, que crea el
//   movimiento tipo 3; ese movimiento dispara el trigger que descuenta la
//   cámara. Una sola vía de descuento.
//
//   Quitar una línea llama a fn_quitar_linea_despacho, que borra la línea y
//   su movimiento; trg_revertir_movimiento (v2.5) devuelve la fruta. Una
//   sola vía de reversa: desde la v2.5 recepciones, movimientos y
//   mantenimientos también tienen la suya en la BD.
//
// ⚠️ LA FUNCIÓN DE REVERSA DEVUELVE TEXTO, NO EXCEPCIÓN
//   fn_quitar_linea_despacho regresa 'OK: ...' o el motivo del rechazo. Sin
//   leer el prefijo, un fallo respondería 200 y el operador creería que la
//   fruta volvió a la cámara cuando sigue cargada en el camión.
//
// ⚠️ LA INOCUIDAD ES DEL DESPACHO, NO DEL TRANSPORTE
//   Se registra con PATCH /:id/inocuidad sobre el borrador. El cierre exige
//   despachos.inocuidad = 1; ya no consulta transportes.inocuidad. Si el
//   borrador cambia de transporte, la BD borra la inspección y hay que
//   volver a revisar la nueva caja.
//
// ⚠️ LOS TRIGGERS DE LA BD SON LA ÚLTIMA PALABRA
//   trg_validar_cierre y los de inventario lanzan excepciones (P0001) con
//   mensajes ya legibles. Se devuelven como 409 en vez de un 500 genérico.
//
// EL ALCANCE SOBRE UN DOCUMENTO SIN CÁMARA
//   El despacho no tiene cámara: la tienen sus líneas. Un despacho ya
//   armado pertenece a quien puso la fruta; uno vacío todavía no tiene
//   planta asignada, así que cualquiera puede continuarlo.
//
// NOTA DE LA AUDITORÍA
//   El aviso de "fruta planeada para otro cliente" al agregar una línea no
//   salía nunca: ocupacionesModel.getOcupacionById no devolvía id_cc. Se
//   corrigió en el model (primera entrega); este controller no cambió su
//   lógica, solo sus comentarios.
// ============================================================================

/** fn_quitar_linea_despacho marca el éxito con este prefijo. */
const esExito = (respuesta) => String(respuesta).startsWith("OK:");

/**
 * Errores que vienen de la BD con un mensaje útil para el usuario.
 * Devuelve true si ya respondió.
 */
const responderErrorBD = (res, error) => {
    // RAISE EXCEPTION de los triggers: el mensaje ya está en español
    if (error.code === "P0001") {
        res.status(409).json({ error: error.message });
        return true;
    }
    // CHECK violado (p. ej. chk_despachos_inocuidad_revision)
    if (error.code === "23514") {
        res.status(409).json({
            error: "La BD rechazó el dato por una regla de integridad" +
                (error.constraint ? ` (${error.constraint})` : "")
        });
        return true;
    }
    return false;
};

/**
 * Valida que el usuario tenga acceso a un despacho ya armado.
 * Devuelve un objeto de error listo para responder, o null si todo cuadra.
 *
 * Un despacho sin líneas pasa siempre: no tiene cámara que comparar.
 */
const validarAlcanceDespacho = async (id_despacho, camaras) => {
    if (!Array.isArray(camaras)) return null;

    const camarasDelDespacho = await despachosModel.getCamarasDelDespacho(
        id_despacho
    );

    // Borrador vacío: sin fruta todavía, no hay planta que proteger
    if (camarasDelDespacho.length === 0) return null;

    const tieneAcceso = camarasDelDespacho.some((c) => camaras.includes(c));

    if (!tieneAcceso) {
        return {
            status: 403,
            error: "No tienes acceso a ese despacho: su fruta salió de otras cámaras"
        };
    }

    return null;
};

/**
 * Valida que un transporte pueda asignarse a un despacho.
 * Devuelve { status, error } si no puede, o { transporte } si sí.
 *
 * Desde la etapa de catálogos, el servicio debe tener sus cuatro piezas
 * (línea, operador, tracto, caja) y todas activas: sin ellas, la BD no
 * deja registrar la inspección y el despacho nunca podría cerrarse.
 */
const validarTransporteParaDespacho = async (id_transporte) => {
    const transporte = await transportesModel.getTransporteById(id_transporte);

    if (!transporte) {
        return { status: 409, error: "El transporte indicado no existe" };
    }

    if (Number(transporte.estado) === 0) {
        return {
            status: 409,
            error: `El transporte "${transporte.razon_social} - ${transporte.nombre_operador}" está dado de baja`
        };
    }

    if (!transporte.catalogos_completos) {
        return {
            status: 409,
            error: `El transporte #${transporte.id_transporte} es un registro anterior sin línea, operador, tracto y caja de catálogo. Vincúlalo en el catálogo de transportes antes de usarlo.`
        };
    }

    if (!transporte.catalogos_activos) {
        return {
            status: 409,
            error: `Alguna pieza del transporte #${transporte.id_transporte} (línea, operador, tracto o caja) está dada de baja. Elige otro servicio.`
        };
    }

    return { transporte };
};

// GET /api/preenfrio/despachos?estado=1&buscar=texto
//   ?inocuidad=1 | 0 | pendiente
const getDespachos = async (req, res) => {
    try {
        const {
            estado,
            id_cc,
            id_transporte,
            fecha_desde,
            fecha_hasta,
            buscar,
            inocuidad
        } = req.query;

        const pendiente = inocuidad === "pendiente";

        const despachos = await despachosModel.getDespachos(
            {
                estado: estado !== undefined && estado !== "" ? Number(estado) : null,
                id_cc: id_cc ? Number(id_cc) : null,
                id_transporte: id_transporte ? Number(id_transporte) : null,
                fecha_desde: fecha_desde || null,
                fecha_hasta: fecha_hasta || null,
                buscar: buscar || null,
                inocuidad:
                    !pendiente && inocuidad !== undefined && inocuidad !== ""
                        ? Number(inocuidad)
                        : null,
                inocuidad_pendiente: pendiente
            },
            req.camaras
        );

        res.status(200).json(despachos);
    } catch (error) {
        console.error("Error al obtener despachos:", error);
        res.status(500).json({ error: "Error al obtener los despachos" });
    }
};

// GET /api/preenfrio/despachos/:id
// Devuelve el documento con su picking completo y su auditoría.
const getDespachoById = async (req, res) => {
    try {
        const { id } = req.params;

        const despacho = await despachosModel.getDespachoById(id);

        if (!despacho) {
            return res.status(404).json({ error: "Despacho no encontrado" });
        }

        const problema = await validarAlcanceDespacho(id, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        const detalle = await despachosModel.getDetalle(id);
        const auditoria = await despachosModel.getAuditoria(id);
        const descuadres = await despachosModel.getLineasDeOtroCliente(id);

        res.status(200).json({
            ...despacho,
            detalle,
            auditoria,
            // Líneas cuyo cliente no coincide con el del documento: el
            // error que cuesta un viaje completo si nadie lo revisa.
            lineas_de_otro_cliente: descuadres
        });
    } catch (error) {
        console.error("Error al obtener el despacho:", error);
        res.status(500).json({ error: "Error al obtener el despacho" });
    }
};

// GET /api/preenfrio/despachos/clientes-disponibles
// Dropdown del picking: solo clientes que REALMENTE tienen fruta en las
// cámaras del alcance, ordenados por criticidad.
const getClientesDisponibles = async (req, res) => {
    try {
        const clientes = await despachosModel.getClientesConInventario(req.camaras);
        res.status(200).json(clientes);
    } catch (error) {
        console.error("Error al obtener los clientes disponibles:", error);
        res.status(500).json({ error: "Error al obtener los clientes" });
    }
};

// GET /api/preenfrio/despachos/:id/disponible
// Fruta que se puede subir a este despacho. Filtra por el cliente del
// documento, porque es lo que normalmente se carga.
//
//   ?todos=1 → muestra también fruta de otros clientes, para los casos de
//              reasignación. Viene marcada para que no pase inadvertida.
const getDisponible = async (req, res) => {
    try {
        const { id } = req.params;
        const { todos } = req.query;

        const despacho = await despachosModel.getDespachoById(id);

        if (!despacho) {
            return res.status(404).json({ error: "Despacho no encontrado" });
        }

        // Mismo criterio que el resto de acciones sobre el documento: un
        // despacho armado con fruta de otra planta no se consulta desde
        // aquí. Antes esta ruta devolvía su encabezado sin revisarlo.
        const problema = await validarAlcanceDespacho(id, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        const verTodos = todos === "1" || todos === "true";

        const disponible = await despachosModel.getDisponibleParaPicking(
            verTodos ? null : Number(despacho.id_cc),
            req.camaras
        );

        res.status(200).json({
            despacho: {
                folio: despacho.folio_despacho,
                cliente: despacho.cliente,
                cedis: despacho.cedis,
                id_cc: despacho.id_cc
            },
            inventario: disponible.map((f) => ({
                ...f,
                // Marca visible cuando se listan todos: subir fruta de otro
                // cliente es legítimo pero tiene que ser una decisión, no
                // un descuido.
                es_de_otro_cliente: Number(f.id_cc) !== Number(despacho.id_cc)
            }))
        });
    } catch (error) {
        console.error("Error al obtener el inventario disponible:", error);
        res.status(500).json({ error: "Error al obtener el inventario" });
    }
};

// ----------------------------------------------------------------------------
// POST /api/preenfrio/despachos
// ----------------------------------------------------------------------------
// Crea el documento en borrador, con la inspección PENDIENTE. El folio lo
// genera la BD con la secuencia, no el backend.
const createDespacho = async (req, res) => {
    try {
        const { id_transporte, id_cc } = req.body;

        // ---- Transporte ----
        const validacion = await validarTransporteParaDespacho(id_transporte);
        if (validacion.error) {
            return res.status(validacion.status).json({ error: validacion.error });
        }

        // ---- Cliente ----
        const cliente = await cedisModel.getCedisById(id_cc);

        if (!cliente) {
            return res.status(409).json({ error: "El cliente/CEDIS indicado no existe" });
        }

        if (cliente.estado === 0) {
            return res.status(409).json({
                error: `El destino "${cliente.cliente} - ${cliente.cedis}" está dado de baja`
            });
        }

        const nuevo = await despachosModel.createDespacho(req.body);
        const completo = await despachosModel.getDespachoById(nuevo.id_despacho);

        // La inspección se avisa al crear y se BLOQUEA al cerrar. Avisar
        // desde el borrador da tiempo de revisar la caja antes de cargar.
        const avisos = [
            `Inspección de inocuidad PENDIENTE para la caja ${completo.placas_caja}. Regístrala antes de cerrar el despacho.`
        ];

        res.status(201).json({
            mensaje: `Despacho ${completo.folio_despacho} creado en borrador`,
            despacho: completo,
            avisos
        });
    } catch (error) {
        console.error("Error al crear el despacho:", error);

        if (responderErrorBD(res, error)) return;

        if (error.code === "23503") {
            return res.status(409).json({
                error: "El transporte o el cliente indicados no existen"
            });
        }

        res.status(500).json({
            error: "Error al crear el despacho" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// ----------------------------------------------------------------------------
// PUT /api/preenfrio/despachos/:id
// ----------------------------------------------------------------------------
// Editar el encabezado. Si el despacho está CERRADO exige motivo y registra
// auditoría: el camión ya salió, así que cualquier cambio es una corrección
// administrativa que alguien tendrá que justificar después.
//
// ⚠️ TRANSPORTE
//   · Borrador: se puede cambiar, pero la BD BORRA la inspección. Se avisa.
//   · Cerrado:  no se puede cambiar. Hay que reabrir primero (admin).
const updateDespacho = async (req, res) => {
    try {
        const { id } = req.params;
        const { motivo, id_transporte } = req.body;

        const existente = await despachosModel.getDespachoById(id);

        if (!existente) {
            return res.status(404).json({ error: "Despacho no encontrado" });
        }

        const problema = await validarAlcanceDespacho(id, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        const estabaCerrado = Number(existente.estado) === 2;
        const cambiaTransporte =
            Number(id_transporte) !== Number(existente.id_transporte);

        // El middleware validarMotivo se encadena solo en la ruta de
        // corrección; aquí se verifica por si se llamó al PUT normal sobre
        // un documento ya cerrado.
        if (estabaCerrado && (!motivo || String(motivo).trim().length < 10)) {
            return res.status(409).json({
                error: "El despacho ya está cerrado. Para corregirlo debes indicar un motivo de al menos 10 caracteres."
            });
        }

        // Un despacho cerrado salió con una caja inspeccionada: cambiar el
        // transporte dejaría esa inspección ligada a otra unidad. La BD lo
        // rechaza (trg_validar_cierre); aquí se responde claro.
        if (estabaCerrado && cambiaTransporte) {
            return res.status(409).json({
                error: "No se puede cambiar el transporte de un despacho cerrado. Reabre primero el despacho (admin) y vuelve a registrar la inspección."
            });
        }

        if (cambiaTransporte) {
            const validacion = await validarTransporteParaDespacho(id_transporte);
            if (validacion.error) {
                return res.status(validacion.status).json({ error: validacion.error });
            }
        }

        await despachosModel.updateDespacho(id, req.body);
        const completo = await despachosModel.getDespachoById(id);

        // ---- Auditoría de la corrección ----
        if (estabaCerrado) {
            // Snapshot legible de lo que cambió: 'Cita: A123 → A124'.
            // Guardar el JSON completo sería más fiel pero ilegible para
            // quien audite meses después.
            const campos = [
                ["Transporte", existente.id_transporte, completo.id_transporte],
                ["Cliente", existente.id_cc, completo.id_cc],
                ["Fecha", existente.fecha_despacho, completo.fecha_despacho],
                ["Hora salida", existente.hora_salida, completo.hora_salida],
                ["Orden venta", existente.orden_venta, completo.orden_venta],
                ["Cita", existente.cita, completo.cita],
                ["Fecha cita", existente.fecha_cita, completo.fecha_cita],
                [
                    "Temperatura",
                    existente.temperatura_salida,
                    completo.temperatura_salida
                ]
            ];

            const cambios = campos
                .filter(([, antes, despues]) => String(antes) !== String(despues))
                .map(([campo, antes, despues]) => `${campo}: ${antes} → ${despues}`)
                .join("; ");

            await despachosModel.registrarAuditoria({
                id_despacho: id,
                estado_al_editar: 2,
                motivo,
                cambios: cambios || "Sin cambios detectados en los campos auditados",
                id_usuario: req.id_usuario
            });
        }

        const avisos = [];
        if (cambiaTransporte && existente.inocuidad !== null) {
            avisos.push(
                `Cambió el transporte: la inspección anterior se borró. Registra la inocuidad de la caja ${completo.placas_caja} antes de cerrar.`
            );
        }

        res.status(200).json({
            mensaje: estabaCerrado
                ? "Corrección registrada en la auditoría del despacho"
                : "Despacho actualizado",
            despacho: completo,
            avisos
        });
    } catch (error) {
        console.error("Error al actualizar el despacho:", error);

        if (responderErrorBD(res, error)) return;

        res.status(500).json({ error: "Error al actualizar el despacho" });
    }
};

// ----------------------------------------------------------------------------
// PATCH /api/preenfrio/despachos/:id/inocuidad
// ----------------------------------------------------------------------------
// Registra la inspección de la caja para ESTE despacho. Es la decisión que
// el supervisor toma en el andén con la unidad enfrente.
//
//   · Solo en borrador: un despacho cerrado ya salió con la inspección que
//     tenía. Para cambiarla hay que reabrirlo (admin, auditado).
//   · El usuario es el de la sesión; la fecha la pone la BD.
//   · Se puede volver a inspeccionar: un rechazo se corrige lavando la caja
//     y registrando una nueva revisión.
const registrarInocuidad = async (req, res) => {
    try {
        const { id } = req.params;
        const { inocuidad, inocuidad_observaciones } = req.body;

        if (!req.id_usuario) {
            return res.status(401).json({
                error: "No se pudo identificar al usuario de la sesión"
            });
        }

        const despacho = await despachosModel.getDespachoById(id);

        if (!despacho) {
            return res.status(404).json({ error: "Despacho no encontrado" });
        }

        const problema = await validarAlcanceDespacho(id, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        if (Number(despacho.estado) === 2) {
            return res.status(409).json({
                error: `El despacho ${despacho.folio_despacho} ya está cerrado: su inspección no se modifica. Reábrelo primero si fue un error.`
            });
        }

        // La BD exige los cuatro catálogos del transporte para registrar
        // la inspección. Se revisa antes para dar un mensaje útil.
        const transporte = await transportesModel.getTransporteById(
            despacho.id_transporte
        );
        if (!transporte || !transporte.catalogos_completos) {
            return res.status(409).json({
                error: "El transporte de este despacho no tiene sus cuatro catálogos (línea, operador, tracto y caja). Cambia el servicio antes de inspeccionar."
            });
        }

        const actualizado = await despachosModel.registrarInocuidad(id, {
            inocuidad,
            id_usuario: req.id_usuario,
            observaciones: inocuidad_observaciones
        });

        // Se cerró entre la lectura y el UPDATE
        if (!actualizado) {
            return res.status(409).json({
                error: "El despacho ya no está en borrador: no se registró la inspección"
            });
        }

        const completo = await despachosModel.getDespachoById(id);

        res.status(200).json({
            mensaje: inocuidad === 1
                ? `Inocuidad APROBADA para la caja ${completo.placas_caja}: el despacho ${completo.folio_despacho} puede cerrarse`
                : `Inocuidad RECHAZADA para la caja ${completo.placas_caja}: no debe cargar fruta. Cambia de unidad o vuelve a inspeccionar.`,
            despacho: completo
        });
    } catch (error) {
        console.error("Error al registrar la inocuidad:", error);

        if (responderErrorBD(res, error)) return;

        if (error.code === "23503") {
            return res.status(409).json({
                error: "El usuario de la sesión no existe en la BD"
            });
        }

        res.status(500).json({ error: "Error al registrar la inspección de inocuidad" });
    }
};

// ----------------------------------------------------------------------------
// POST /api/preenfrio/despachos/:id/lineas
// ----------------------------------------------------------------------------
// Agregar fruta al picking. El INSERT dispara la cadena de triggers que
// descuenta la cámara.
const agregarLinea = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            id_ocupacion_origen,
            cantidad_tarimas,
            cantidad_cajas
        } = req.body;

        const despacho = await despachosModel.getDespachoById(id);

        if (!despacho) {
            return res.status(404).json({ error: "Despacho no encontrado" });
        }

        // Un despacho cerrado ya salió: agregarle fruta descontaría una
        // cámara por producto que nunca se subió al camión.
        if (Number(despacho.estado) === 2) {
            return res.status(409).json({
                error: `El despacho ${despacho.folio_despacho} ya está cerrado: no se le puede agregar fruta.`
            });
        }

        // ---- La ocupación de origen ----
        const origen = await ocupacionesModel.getOcupacionById(id_ocupacion_origen);

        if (!origen) {
            return res.status(409).json({ error: "La ocupación de origen no existe" });
        }

        if (origen.estado !== 1) {
            return res.status(409).json({
                error: "Esa ocupación ya está cerrada: no queda fruta que despachar"
            });
        }

        // Solo se despacha lo que está DENTRO. La cola sigue en el patio.
        if (origen.tipo_ocupacion !== 1) {
            return res.status(409).json({
                error: `Esa ocupación es "${origen.tipo_texto}". Solo se puede despachar fruta que ya está dentro de la cámara.`
            });
        }

        // ---- Alcance sobre la cámara de origen ----
        // No viene en el body: se deduce de la ocupación, así que
        // validarCamaraEnAlcance no puede verla.
        if (
            Array.isArray(req.camaras) &&
            !req.camaras.includes(Number(origen.id_camara))
        ) {
            return res.status(403).json({
                error: "No tienes acceso a la cámara de origen de esa fruta"
            });
        }

        // ---- No se puede subir más de lo que hay ----
        // La BD también lo rechaza, pero aquí se responde con el nombre de
        // la cámara y el saldo exacto del lote.
        if (Number(cantidad_tarimas) > Number(origen.cantidad_tarimas)) {
            return res.status(409).json({
                error: `No puedes despachar ${cantidad_tarimas} tarimas: en "${origen.nombre_camara}" solo hay ${origen.cantidad_tarimas} de este lote.`
            });
        }

        if (Number(cantidad_cajas) > Number(origen.cantidad_cajas)) {
            return res.status(409).json({
                error: `No puedes despachar ${cantidad_cajas} cajas: en "${origen.nombre_camara}" solo hay ${origen.cantidad_cajas} de este lote.`
            });
        }

        // ---- INSERT ----
        // id_produccion e id_camara_origen salen de la ocupación: el
        // trigger también los deduciría, pero dejarlos explícitos hace el
        // registro legible y evita depender de ese detalle.
        const linea = await despachosModel.agregarLinea({
            ...req.body,
            id_despacho: Number(id),
            id_produccion: origen.id_produccion,
            id_camara_origen: origen.id_camara
        });

        // ---- Qué quedó después ----
        const completa = await despachosModel.getLineaById(linea.id_detalle);
        const origenDespues = await ocupacionesModel.getOcupacionById(
            id_ocupacion_origen
        );
        const despachoActualizado = await despachosModel.getDespachoById(id);

        const avisos = [];

        // Fruta de otro cliente: legítimo cuando se reasigna, pero es el
        // error que cuesta el viaje completo si pasa inadvertido. Se avisa
        // aquí y se bloquea al cerrar.
        if (origen.id_cc && Number(origen.id_cc) !== Number(despacho.id_cc)) {
            avisos.push(
                `⚠️ Este lote estaba planeado para ${origen.cliente} - ${origen.cedis}, y el despacho va a ${despacho.cliente} - ${despacho.cedis}. Verifica que la reasignación sea correcta.`
            );
        }

        // Cargar antes de inspeccionar es posible, pero el cierre lo va a
        // bloquear: se recuerda desde la primera línea.
        if (Number(despachoActualizado.inocuidad) !== 1) {
            avisos.push(
                despachoActualizado.inocuidad === null
                    ? "Inspección de inocuidad PENDIENTE: regístrala antes de cerrar."
                    : "⚠️ La inspección de inocuidad de esta caja está RECHAZADA: no podrás cerrar el despacho."
            );
        }

        res.status(201).json({
            mensaje: `Se agregaron ${cantidad_tarimas} tarimas al despacho ${despacho.folio_despacho}`,
            linea: completa,
            origen: {
                camara: origen.nombre_camara,
                // El trigger cierra la ocupación si quedó en cero
                tarimas_restantes: origenDespues?.cantidad_tarimas ?? 0,
                cerrada: origenDespues?.estado === 0
            },
            // Los totales los recalculó trg_recalcular_totales_despacho
            totales: {
                tarimas: despachoActualizado.cantidad_tarimas,
                cajas: despachoActualizado.cantidad_cajas,
                lineas: despachoActualizado.lineas
            },
            avisos
        });
    } catch (error) {
        console.error("Error al agregar la linea:", error);

        if (responderErrorBD(res, error)) return;

        if (error.code === "23503") {
            return res.status(409).json({
                error: "La ocupación, el bloque o el despacho indicados no existen"
            });
        }

        res.status(500).json({
            error: "Error al agregar la línea" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// ----------------------------------------------------------------------------
// DELETE /api/preenfrio/despachos/:id/lineas/:id_detalle
// ----------------------------------------------------------------------------
// Llama a fn_quitar_linea_despacho: verifica que el despacho siga en
// borrador, borra la línea y su movimiento. Al borrar el movimiento,
// trg_revertir_movimiento devuelve la fruta a su cámara y reabre la
// ocupación si se había cerrado.
const quitarLinea = async (req, res) => {
    try {
        const { id, id_detalle } = req.params;

        const despacho = await despachosModel.getDespachoById(id);

        if (!despacho) {
            return res.status(404).json({ error: "Despacho no encontrado" });
        }

        const linea = await despachosModel.getLineaById(id_detalle);

        if (!linea) {
            return res.status(404).json({ error: "Línea no encontrada" });
        }

        if (Number(linea.id_despacho) !== Number(id)) {
            return res.status(409).json({
                error: "Esa línea no pertenece a este despacho"
            });
        }

        // Alcance sobre la cámara de donde salió la fruta
        if (
            Array.isArray(req.camaras) &&
            linea.id_camara_origen !== null &&
            !req.camaras.includes(Number(linea.id_camara_origen))
        ) {
            return res.status(403).json({
                error: "No tienes acceso a la cámara de origen de esa línea"
            });
        }

        // ---- Llamada a la función de reversa ----
        const resultado = await despachosModel.quitarLinea(id_detalle);

        // ⚠️ Devuelve TEXTO, no excepción. Sin esta comprobación, intentar
        // quitar una línea de un despacho cerrado respondería 200 y el
        // operador creería que la fruta volvió a la cámara.
        if (!esExito(resultado)) {
            return res.status(409).json({ error: resultado });
        }

        const despachoActualizado = await despachosModel.getDespachoById(id);

        res.status(200).json({
            mensaje: resultado,
            lote: linea.codigo_lote,
            devuelto_a: linea.camara_origen,
            totales: {
                tarimas: despachoActualizado.cantidad_tarimas,
                cajas: despachoActualizado.cantidad_cajas,
                lineas: despachoActualizado.lineas
            }
        });
    } catch (error) {
        console.error("Error al quitar la linea:", error);

        if (responderErrorBD(res, error)) return;

        res.status(500).json({ error: "Error al quitar la línea" });
    }
};

// ----------------------------------------------------------------------------
// PATCH /api/preenfrio/despachos/:id/cerrar
// ----------------------------------------------------------------------------
// El camión salió. Es el punto donde se aplican los bloqueos duros: después
// de cerrar, corregir cuesta auditoría.
const cerrarDespacho = async (req, res) => {
    try {
        const { id } = req.params;

        const despacho = await despachosModel.getDespachoById(id);

        if (!despacho) {
            return res.status(404).json({ error: "Despacho no encontrado" });
        }

        const problema = await validarAlcanceDespacho(id, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        if (Number(despacho.estado) === 2) {
            return res.status(409).json({
                error: "El despacho ya está cerrado"
            });
        }

        // ---- Sin fruta no hay despacho ----
        if (Number(despacho.lineas) === 0) {
            return res.status(409).json({
                error: "No puedes cerrar un despacho sin líneas de picking"
            });
        }

        // ---- Inocuidad DEL DESPACHO: bloqueo duro ----
        // Ya no se consulta transportes.inocuidad: cada despacho exige su
        // propia inspección aprobada.
        if (despacho.inocuidad === null) {
            return res.status(409).json({
                error: `La inspección de inocuidad de la caja ${despacho.placas_caja} está PENDIENTE. Regístrala antes de cerrar.`
            });
        }

        if (Number(despacho.inocuidad) !== 1) {
            return res.status(409).json({
                error: `La caja ${despacho.placas_caja} tiene la INOCUIDAD RECHAZADA en este despacho: no puede transportar fruta. Cambia de unidad o vuelve a inspeccionar.`
            });
        }

        // ---- Fruta de otro cliente ----
        // Se bloquea AL CERRAR, no al agregar: reasignar fruta entre
        // clientes es legítimo, pero mandar el camión sin que nadie lo haya
        // notado es lo que cuesta el rechazo en el andén.
        const descuadres = await despachosModel.getLineasDeOtroCliente(id);
        const confirmado = req.query.confirmar === "1";

        if (descuadres.length > 0 && !confirmado) {
            return res.status(409).json({
                error: `Este despacho lleva ${descuadres.length} línea(s) de fruta planeada para otro cliente. Revísalas y vuelve a cerrar con ?confirmar=1 si la reasignación es correcta.`,
                lineas_de_otro_cliente: descuadres
            });
        }

        // El cierre y su auditoría van en UNA transacción, y la
        // confirmación de reasignación viaja a la BD con
        // app.confirmar_reasignacion (la exige trg_validar_cierre).
        //
        // Si se cerró con reasignación, queda constancia en la auditoría:
        // es exactamente el dato que alguien va a buscar si el CEDIS
        // rechaza la carga.
        await despachosModel.cerrarDespacho(id, {
            confirmarReasignacion: descuadres.length > 0 && confirmado,
            auditoria: descuadres.length > 0
                ? {
                    estado_al_editar: 1,
                    motivo: "Cierre confirmado con fruta reasignada de otro cliente",
                    cambios: descuadres
                        .map(
                            (d) =>
                                `Lote ${d.codigo_lote}: planeado para ${d.cliente_fruta} → despachado a ${d.cliente_despacho}`
                        )
                        .join("; "),
                    id_usuario: req.id_usuario
                }
                : null
        });

        const completo = await despachosModel.getDespachoById(id);

        res.status(200).json({
            mensaje: `Despacho ${completo.folio_despacho} cerrado: ${completo.cantidad_tarimas} tarimas y ${completo.cantidad_cajas} cajas salieron a ${completo.cliente} - ${completo.cedis}`,
            despacho: completo
        });
    } catch (error) {
        console.error("Error al cerrar el despacho:", error);

        if (responderErrorBD(res, error)) return;

        res.status(500).json({ error: "Error al cerrar el despacho" });
    }
};

// ----------------------------------------------------------------------------
// PATCH /api/preenfrio/despachos/:id/reabrir
// ----------------------------------------------------------------------------
// Solo admin, y siempre con motivo: reabrir significa que el documento se
// cerró por error. Queda registrado en la auditoría.
//
// La inspección se conserva al reabrir. Si se cambia el transporte del
// borrador reabierto, la BD la borra y hay que volver a inspeccionar.
const reabrirDespacho = async (req, res) => {
    try {
        const { id } = req.params;
        const { motivo } = req.body;

        const despacho = await despachosModel.getDespachoById(id);

        if (!despacho) {
            return res.status(404).json({ error: "Despacho no encontrado" });
        }

        if (Number(despacho.estado) !== 2) {
            return res.status(409).json({
                error: "El despacho no está cerrado"
            });
        }

        await despachosModel.reabrirDespacho(id);

        await despachosModel.registrarAuditoria({
            id_despacho: id,
            estado_al_editar: 2,
            motivo,
            cambios: "Estado: Cerrado → Borrador",
            id_usuario: req.id_usuario
        });

        const completo = await despachosModel.getDespachoById(id);

        res.status(200).json({
            mensaje: `Despacho ${completo.folio_despacho} reabierto a borrador. La corrección quedó registrada.`,
            despacho: completo
        });
    } catch (error) {
        console.error("Error al reabrir el despacho:", error);

        if (responderErrorBD(res, error)) return;

        res.status(500).json({ error: "Error al reabrir el despacho" });
    }
};

// ----------------------------------------------------------------------------
// DELETE /api/preenfrio/despachos/:id
// ----------------------------------------------------------------------------
// Solo borradores vacíos. Con líneas hay que quitar cada una para devolver
// la fruta a su cámara.
const deleteDespacho = async (req, res) => {
    try {
        const { id } = req.params;

        const despacho = await despachosModel.getDespachoById(id);

        if (!despacho) {
            return res.status(404).json({ error: "Despacho no encontrado" });
        }

        if (Number(despacho.estado) === 2) {
            return res.status(409).json({
                error: "No se puede eliminar un despacho cerrado: ese camión ya salió."
            });
        }

        if (Number(despacho.lineas) > 0) {
            return res.status(409).json({
                error: `El despacho tiene ${despacho.lineas} línea(s) de picking. Quítalas primero para devolver la fruta a sus cámaras.`
            });
        }

        const problema = await validarAlcanceDespacho(id, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        const eliminado = await despachosModel.deleteDespacho(id);

        res.status(200).json({
            mensaje: `Despacho ${eliminado.folio_despacho} eliminado`,
            despacho: eliminado
        });
    } catch (error) {
        console.error("Error al eliminar el despacho:", error);

        if (responderErrorBD(res, error)) return;

        if (error.code === "23503") {
            return res.status(409).json({
                error: "No se puede eliminar: el despacho tiene registros asociados"
            });
        }

        res.status(500).json({ error: "Error al eliminar el despacho" });
    }
};

// GET /api/preenfrio/despachos/:id/auditoria
const getAuditoria = async (req, res) => {
    try {
        const { id } = req.params;

        const despacho = await despachosModel.getDespachoById(id);

        if (!despacho) {
            return res.status(404).json({ error: "Despacho no encontrado" });
        }

        const problema = await validarAlcanceDespacho(id, req.camaras);
        if (problema) {
            return res.status(problema.status).json({ error: problema.error });
        }

        const auditoria = await despachosModel.getAuditoria(id);

        res.status(200).json(auditoria);
    } catch (error) {
        console.error("Error al obtener la auditoria:", error);
        res.status(500).json({ error: "Error al obtener la auditoría" });
    }
};

export const despachosController = {
    getDespachos,
    getDespachoById,
    getClientesDisponibles,
    getDisponible,
    createDespacho,
    updateDespacho,
    registrarInocuidad,
    agregarLinea,
    quitarLinea,
    cerrarDespacho,
    reabrirDespacho,
    deleteDespacho,
    getAuditoria
};
