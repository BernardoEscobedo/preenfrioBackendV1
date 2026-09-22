import cedisModel from "../models/cedis.model.js";

// ============================================================================
// CEDIS / CLIENTE
// ============================================================================
// Catálogo sin alcance por cámara: un cliente es el DESTINO de la fruta, no
// el lugar donde se enfría. El acceso lo limita el rol.
//
// El formato y la normalización del acrónimo viven en cedis.middleware.js.
// Aquí queda lo que exige consultar la BD: duplicados y dependencias.
// ============================================================================

// GET /api/preenfrio/cedis?estado=1&buscar=texto
const getCedis = async (req, res) => {
    try {
        const { estado, buscar } = req.query;

        const registros = await cedisModel.getCedis({
            estado: estado !== undefined && estado !== "" ? Number(estado) : null,
            buscar: buscar || null
        });

        res.status(200).json(registros);
    } catch (error) {
        console.error("Error al obtener cedis/clientes:", error);
        res.status(500).json({ error: "Error al obtener los clientes" });
    }
};

// GET /api/preenfrio/cedis/:id
const getCedisById = async (req, res) => {
    try {
        const { id } = req.params;
        const registro = await cedisModel.getCedisById(id);

        if (!registro) {
            return res.status(404).json({ error: "Cliente/CEDIS no encontrado" });
        }

        res.status(200).json(registro);
    } catch (error) {
        console.error("Error al obtener cedis/cliente:", error);
        res.status(500).json({ error: "Error al obtener el cliente" });
    }
};

// GET /api/preenfrio/cedis/acronimo/:acronimo
// La usa la importación del Excel semanal, que trae el acrónimo y no el id.
const getByAcronimo = async (req, res) => {
    try {
        const { acronimo } = req.params;
        const registro = await cedisModel.getByAcronimo(acronimo);

        if (!registro) {
            return res.status(404).json({
                error: `No existe ningún cliente/CEDIS con el acrónimo "${acronimo}"`
            });
        }

        // Se responde 200 aunque esté dado de baja, pero con aviso: al
        // importador le sirve más "existe pero está inactivo" que un 404
        // que lo llevaría a crear un duplicado.
        res.status(200).json({
            ...registro,
            aviso: registro.estado === 0
                ? "Este cliente/CEDIS está dado de baja"
                : null
        });
    } catch (error) {
        console.error("Error al buscar por acrónimo:", error);
        res.status(500).json({ error: "Error al buscar el cliente" });
    }
};

// POST /api/preenfrio/cedis
const createCedis = async (req, res) => {
    try {
        const { cliente, cedis, acronimo } = req.body;

        const duplicadoAcronimo = await cedisModel.existeAcronimo(acronimo);
        if (duplicadoAcronimo) {
            return res.status(409).json({
                error: `El acrónimo "${acronimo}" ya está en uso por: ${duplicadoAcronimo.cliente} - ${duplicadoAcronimo.cedis}`
            });
        }

        // El mismo destino capturado dos veces con acrónimos distintos haría
        // que la planeación no supiera a cuál mandar la fruta.
        const duplicadoDestino = await cedisModel.existeClienteCedis(cliente, cedis);
        if (duplicadoDestino) {
            return res.status(409).json({
                error: `Ya existe "${cliente} - ${cedis}" con el acrónimo "${duplicadoDestino.acronimo}"`
            });
        }

        const nuevo = await cedisModel.createCedis(req.body);
        res.status(201).json(nuevo);
    } catch (error) {
        console.error("Error al crear cedis/cliente:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Ese acrónimo ya está en uso"
            });
        }

        res.status(500).json({
            error: "Error al crear el cliente" +
                (error.message ? `: ${error.message}` : "")
        });
    }
};

// PUT /api/preenfrio/cedis/:id
const updateCedis = async (req, res) => {
    try {
        const { id } = req.params;
        const { cliente, cedis, acronimo } = req.body;

        const existente = await cedisModel.getCedisById(id);
        if (!existente) {
            return res.status(404).json({ error: "Cliente/CEDIS no encontrado" });
        }

        const duplicadoAcronimo = await cedisModel.existeAcronimo(
            acronimo,
            Number(id)
        );
        if (duplicadoAcronimo) {
            return res.status(409).json({
                error: `El acrónimo "${acronimo}" ya está en uso por: ${duplicadoAcronimo.cliente} - ${duplicadoAcronimo.cedis}`
            });
        }

        const duplicadoDestino = await cedisModel.existeClienteCedis(
            cliente,
            cedis,
            Number(id)
        );
        if (duplicadoDestino) {
            return res.status(409).json({
                error: `Ya existe "${cliente} - ${cedis}" con el acrónimo "${duplicadoDestino.acronimo}"`
            });
        }

        // Cambiar el acrónimo rompe el cruce con las hojas de logística que
        // ya circulan. No se bloquea (a veces hay que corregirlo), pero se
        // avisa si el destino tiene operación registrada.
        const cambiaAcronimo =
            String(existente.acronimo).toUpperCase() !== String(acronimo).toUpperCase();

        const actualizado = await cedisModel.updateCedis(id, req.body);

        let aviso = null;
        if (cambiaAcronimo) {
            const dependencias = await cedisModel.getDependencias(id);
            if (Number(dependencias.producciones) > 0) {
                aviso = `Cambiaste el acrónimo de "${existente.acronimo}" a "${acronimo}". Actualiza el Excel de planeación: las hojas que sigan usando el anterior ya no cruzarán.`;
            }
        }

        res.status(200).json({ ...actualizado, aviso });
    } catch (error) {
        console.error("Error al actualizar cedis/cliente:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Ese acrónimo ya está en uso"
            });
        }

        res.status(500).json({ error: "Error al actualizar el cliente" });
    }
};

// DELETE /api/preenfrio/cedis/:id
// Baja LÓGICA: produccion.id_cc y despachos.id_cc apuntan aquí.
const bajaCedis = async (req, res) => {
    try {
        const { id } = req.params;

        const existente = await cedisModel.getCedisById(id);
        if (!existente) {
            return res.status(404).json({ error: "Cliente/CEDIS no encontrado" });
        }

        if (existente.estado === 0) {
            return res.status(409).json({
                error: "El cliente/CEDIS ya está dado de baja"
            });
        }

        const dependencias = await cedisModel.getDependencias(id);
        const registro = await cedisModel.bajaCedis(id);

        res.status(200).json({
            mensaje: "Cliente/CEDIS dado de baja. El histórico se conserva.",
            cedis: registro,
            dependencias
        });
    } catch (error) {
        console.error("Error al dar de baja el cedis/cliente:", error);
        res.status(500).json({ error: "Error al dar de baja el cliente" });
    }
};

// PATCH /api/preenfrio/cedis/:id/reactivar
const reactivarCedis = async (req, res) => {
    try {
        const { id } = req.params;
        const registro = await cedisModel.reactivarCedis(id);

        if (!registro) {
            return res.status(404).json({ error: "Cliente/CEDIS no encontrado" });
        }

        res.status(200).json({
            mensaje: "Cliente/CEDIS reactivado correctamente",
            cedis: registro
        });
    } catch (error) {
        console.error("Error al reactivar el cedis/cliente:", error);
        res.status(500).json({ error: "Error al reactivar el cliente" });
    }
};

export const cedisController = {
    getCedis,
    getCedisById,
    getByAcronimo,
    createCedis,
    updateCedis,
    bajaCedis,
    reactivarCedis
};
