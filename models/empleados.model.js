import { db } from "../database/connection.database.js";

// ============================================================================
// EMPLEADOS
// ============================================================================
// Catálogo de personal. Es la base de 'usuarios': una cuenta siempre
// pertenece a un empleado, y de ahí sale el nombre real que se muestra en
// el dashboard (no el nombre de la cuenta).
//
// 'turno' y 'zona' son descriptivos: no afectan permisos ni alcance. Quién
// ve qué cámaras se define en usuarios_camaras.
// ============================================================================

// Lista con indicador de si ya tiene cuenta.
// Sirve para que al crear un usuario solo se ofrezcan los que no tienen:
// dos cuentas para la misma persona confunden la trazabilidad.
const getEmpleados = async () => {
    const result = await db.query(
        `
        SELECT
            e.*,
            CASE WHEN u.id_usuario IS NOT NULL THEN TRUE ELSE FALSE END AS tiene_usuario,
            u.id_usuario,
            u.usuario
        FROM empleados e
        LEFT JOIN usuarios u ON u.id_empleado = e.id_empleado
        ORDER BY e.nombre, e.apellidos
        `
    );
    return result.rows;
};

const getEmpleadoById = async (id_empleado) => {
    const result = await db.query(
        `SELECT * FROM empleados WHERE id_empleado = $1`,
        [id_empleado]
    );
    return result.rows[0];
};

// Empleados que AÚN no tienen cuenta. Alimenta el dropdown del alta de
// usuarios.
const getSinUsuario = async () => {
    const result = await db.query(
        `
        SELECT e.*
        FROM empleados e
        LEFT JOIN usuarios u ON u.id_empleado = e.id_empleado
        WHERE u.id_usuario IS NULL
        ORDER BY e.nombre, e.apellidos
        `
    );
    return result.rows;
};

const createEmpleado = async ({ nombre, apellidos, turno, zona }) => {
    const result = await db.query(
        `
        INSERT INTO empleados (nombre, apellidos, turno, zona)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        `,
        [nombre, apellidos, turno, zona]
    );
    return result.rows[0];
};

const updateEmpleado = async (
    id_empleado,
    { nombre, apellidos, turno, zona }
) => {
    const result = await db.query(
        `
        UPDATE empleados
        SET nombre = $1, apellidos = $2, turno = $3, zona = $4
        WHERE id_empleado = $5
        RETURNING *
        `,
        [nombre, apellidos, turno, zona, id_empleado]
    );
    return result.rows[0];
};

// Si el empleado tiene cuenta, la FK lo impide (error 23503) y el
// controller lo traduce a un mensaje entendible.
const deleteEmpleado = async (id_empleado) => {
    const result = await db.query(
        `DELETE FROM empleados WHERE id_empleado = $1 RETURNING *`,
        [id_empleado]
    );
    return result.rows[0];
};

const empleadosModel = {
    getEmpleados,
    getEmpleadoById,
    getSinUsuario,
    createEmpleado,
    updateEmpleado,
    deleteEmpleado
};

export default empleadosModel;
