import transportesModel from "../models/transportes.model.js";

// ============================================================================
// TRANSPORTES
// ============================================================================
// Catálogo sin alcance por cámara: una unidad recoge en cualquier planta.
// El acceso lo limita el rol.
//
// LA INOCUIDAD SE AVISA, NO SE BLOQUEA
//   Una unidad con inocuidad = 0 no debería cargar fruta, pero el bloqueo
//   duro vive en el módulo de despachos, no aquí: este catálogo solo la
//   registra. El listado la expone para que la pantalla la marque en rojo.
// ============================================================================

// GET /api/preenfrio/transportes?estado=1&inocuidad=1&buscar=texto
const getTransportes = async (req, res) => {
    try {
        const { estado, inocuidad, buscar } = req.query;

        const transportes = await transportesModel.getTransportes({
            estado: estado !== undefined && estado !== "" ? Number(estado) : null,
            inocuidad:
                inocuidad !== undefined && inocuidad !== "" ? Number(inocuidad) : null,
            buscar: buscar || null
        });

        res.status(200).json(transportes);
    } catch (error) {
        console.error("Error al obtener transportes:", error);
        res.status(500).json({ error: "Error al obtener los transportes" });
    }
};

// GET /api/preenfrio/transportes/:id
const getTransporteById = async (req, res) => {
    try {
        const { id } = req.params;
        const transporte = await transportesModel.getTransporteById(id);

        if (!transporte) {
            return res.status(404).json({ error: "Transporte no encontrado" });
        }

        res.status(200).json(transporte);
    } catch (error) {
        console.error("Error al obtener transporte:", error);
        res.status(500).json({ error: "Error al obtener el transporte" });
    }
};

// POST /api/preenfrio/transportes
const createTransporte = async (req, res) => {
    try {
        const { placas_tracto, placas_caja, nombre_operador, inocuidad } = req.body;

        // El duplicado se mide por la combinación tracto + caja: un mismo
        // tracto jala cajas distintas y cada combinación es una unidad
        // legítima en el andén.
        const duplicado = await transportesModel.existeUnidad(
            placas_tracto,
            placas_caja
        );
        if (duplicado) {
            return res.status(409).json({
                error: `Esa unidad ya está registrada (${duplicado.razon_social} - ${duplicado.nombre_operador}). Si cambió de operador, edita el registro existente.`
            });
        }

        const nuevo = await transportesModel.createTransporte(req.body);

        res.status(201).json({
            ...nuevo,
            // Aviso, no bloqueo: la unidad queda registrada pero no debería
            // cargar hasta que apruebe la inspección.
            aviso: Number(inocuidad) === 0
                ? "Unidad registrada con inocuidad RECHAZADA: no debe cargar fruta hasta aprobar la inspección."
                : null
        });
    } catch (error) {
        console.error("Error al crear transporte:", error);
        res.status(500).json({
            error: "Error al crear el transporte" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/transportes/:id
const updateTransporte = async (req, res) => {
    try {
        const { id } = req.params;
        const { placas_tracto, placas_caja, inocuidad } = req.body;

        const existente = await transportesModel.getTransporteById(id);
        if (!existente) {
            return res.status(404).json({ error: "Transporte no encontrado" });
        }

        const duplicado = await transportesModel.existeUnidad(
            placas_tracto,
            placas_caja,
            Number(id)
        );
        if (duplicado) {
            return res.status(409).json({
                error: `Esas placas ya pertenecen a otra unidad registrada (${duplicado.razon_social} - ${duplicado.nombre_operador})`
            });
        }

        const actualizado = await transportesModel.updateTransporte(id, req.body);

        res.status(200).json({
            ...actualizado,
            aviso: Number(inocuidad) === 0
                ? "Unidad con inocuidad RECHAZADA: no debe cargar fruta hasta aprobar la inspección."
                : null
        });
    } catch (error) {
        console.error("Error al actualizar transporte:", error);
        res.status(500).json({ error: "Error al actualizar el transporte" });
    }
};

// PATCH /api/preenfrio/transportes/:id/inocuidad
// Actualiza SOLO el resultado de la inspección.
// Va aparte del PUT porque es una decisión que se toma en el andén, con la
// unidad enfrente: obligar a reenviar placas y datos del operador para
// marcar un rechazo invitaba a errores de captura.
const setInocuidad = async (req, res) => {
    try {
        const { id } = req.params;
        const { inocuidad } = req.body;

        const existente = await transportesModel.getTransporteById(id);
        if (!existente) {
            return res.status(404).json({ error: "Transporte no encontrado" });
        }

        const transporte = await transportesModel.setInocuidad(id, inocuidad);

        res.status(200).json({
            mensaje: inocuidad === 1
                ? "Inocuidad APROBADA: la unidad puede cargar"
                : "Inocuidad RECHAZADA: la unidad no debe cargar fruta",
            transporte
        });
    } catch (error) {
        console.error("Error al actualizar la inocuidad:", error);
        res.status(500).json({ error: "Error al actualizar la inocuidad" });
    }
};

// DELETE /api/preenfrio/transportes/:id
// Baja LÓGICA: despachos.id_transporte apunta aquí y ante un reclamo hay
// que poder decir quién se llevó la fruta.
const bajaTransporte = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await transportesModel.getTransporteById(id);
        if (!existente) {
            return res.status(404).json({ error: "Transporte no encontrado" });
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "El transporte ya está dado de baja"
            });
        }

        const dependencias = await transportesModel.getDependencias(id);
        const transporte = await transportesModel.bajaTransporte(id);

        res.status(200).json({
            mensaje: "Transporte dado de baja. El histórico de despachos se conserva.",
            transporte,
            dependencias
        });
    } catch (error) {
        console.error("Error al dar de baja el transporte:", error);
        res.status(500).json({ error: "Error al dar de baja el transporte" });
    }
};

// PATCH /api/preenfrio/transportes/:id/reactivar
const reactivarTransporte = async (req, res) => {
    try {
        const { id } = req.params;
        const transporte = await transportesModel.reactivarTransporte(id);

        if (!transporte) {
            return res.status(404).json({ error: "Transporte no encontrado" });
        }

        res.status(200).json({
            mensaje: "Transporte reactivado correctamente",
            transporte
        });
    } catch (error) {
        console.error("Error al reactivar el transporte:", error);
        res.status(500).json({ error: "Error al reactivar el transporte" });
    }
};

export const transportesController = {
    getTransportes,
    getTransporteById,
    createTransporte,
    updateTransporte,
    setInocuidad,
    bajaTransporte,
    reactivarTransporte
};
