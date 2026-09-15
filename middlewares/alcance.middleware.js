import { db } from "../database/connection.database.js";

// ============================================================================
// ALCANCE POR CÁMARA
// ============================================================================
// EL PROBLEMA QUE RESUELVE
//   El personal de Doña Nelly no debe ver lo de Fortaleza, ni al revés.
//   Pero Admin y Coordinador sí necesitan ver todas las plantas.
//
// POR QUÉ AQUÍ Y NO EN EL FRONTEND
//   Ocultar cámaras en la vista no protege nada: con el token en la mano,
//   cualquiera puede llamar el endpoint directo y recibir todo. El recorte
//   tiene que pasar antes de responder.
//
// CÓMO SE USA
//   1. En la ruta, después de verifyToken:
//        router.get("/x", verifyToken, verifyOperativo, cargarAlcance, ctrl.x);
//
//   2. En el controller:
//        await modelo.getAlgo(req.camaras);
//
//   3. En el modelo:
//        WHERE ($1::INT[] IS NULL OR id_camara = ANY($1))
//
//      Ese patrón sirve para los dos casos con la MISMA query: si el
//      parámetro llega NULL la condición se cumple siempre. Sin él habría
//      que armar SQL dinámico o duplicar cada método.
//
// VALORES DE req.camaras
//   null    → sin restricción  (Admin / Coordinador)
//   [1, 2]  → solo esas cámaras (Supervisor / Operativo)
//   []      → no ve nada        (usuario sin asignación vigente)
// ============================================================================

// Roles con alcance total. Se dejan explícitos aquí para que el criterio
// sea visible y no haya que rastrearlo entre el código.
const ROLES_ALCANCE_TOTAL = [1, 2]; // 1=Admin · 2=Coordinador

/**
 * Carga en req.camaras las cámaras visibles para el usuario de la sesión.
 * Requiere que verifyToken haya corrido antes.
 */
export const cargarAlcance = async (req, res, next) => {
    try {
        const id_usuario = req.id_usuario ?? req.usuario?.id_usuario ?? null;
        const id_role = req.id_role ?? req.usuario?.id_role ?? null;

        if (!id_usuario) {
            return res.status(401).json({
                error: "No se pudo identificar al usuario de la sesión"
            });
        }

        // Alcance total: null significa "no filtres"
        if (ROLES_ALCANCE_TOTAL.includes(Number(id_role))) {
            req.camaras = null;
            req.alcanceTotal = true;
            return next();
        }

        // Alcance limitado: la función de BD ya resuelve la regla completa
        // (incluido el filtro de asignaciones vigentes por fecha_fin).
        const result = await db.query(
            `SELECT fn_camaras_usuario($1) AS camaras`,
            [id_usuario]
        );

        req.camaras = result.rows[0]?.camaras ?? [];
        req.alcanceTotal = false;

        // Un supervisor sin cámaras no ve absolutamente nada. Se avisa en
        // el log porque desde la app parece un error del sistema, cuando en
        // realidad es configuración pendiente.
        if (req.camaras.length === 0) {
            console.warn(
                `[alcance] Usuario ${id_usuario} (rol ${id_role}) sin cámaras asignadas: no verá datos.`
            );
        }

        next();
    } catch (error) {
        console.error("Error al cargar el alcance del usuario:", error);
        res.status(500).json({
            error: "Error al determinar las cámaras del usuario"
        });
    }
};

/**
 * Valida que una cámara concreta esté dentro del alcance del usuario.
 *
 * Leer filtrado no basta: sin esto, alguien podría registrar una recepción
 * en una cámara ajena mandando el id a mano en el body.
 *
 * @param {String} origen  De dónde leer el id: 'params' | 'body'
 * @param {String} campo   Nombre del campo (por defecto 'id_camara')
 */
export const validarCamaraEnAlcance = (origen = "params", campo = "id_camara") => {
    return (req, res, next) => {
        // Alcance total: no hay nada que validar
        if (req.alcanceTotal || req.camaras === null) {
            return next();
        }

        const fuente = origen === "body" ? req.body : req.params;
        const valor = fuente?.[campo];

        // Si el endpoint no manda cámara, esta validación no aplica.
        // Ej: un movimiento sin destino, o una producción que va directo.
        if (valor === undefined || valor === null || valor === "") {
            return next();
        }

        const id = Number(valor);
        if (isNaN(id)) {
            return res.status(400).json({
                error: `El campo "${campo}" debe ser numérico`
            });
        }

        if (!req.camaras.includes(id)) {
            return res.status(403).json({
                error: "No tienes acceso a esa cámara"
            });
        }

        next();
    };
};

export default { cargarAlcance, validarCamaraEnAlcance };
