import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { db } from "../database/connection.database.js";

dotenv.config();

// ============================================================================
// AUTENTICACIÓN Y PERMISOS POR ROL
// ============================================================================
// JERARQUÍA INCLUSIVA
//   1 Admin  ⊂  2 Coordinador  ⊂  3 Supervisor  ⊂  4 Operativo
//
//   "Inclusiva" significa que quien puede más, puede menos: si una ruta
//   exige verifyOperativo, también entran supervisor, coordinador y admin.
//   Por eso cada guard compara con <= en vez de ==.
//
// QUÉ DEJA EN req
//   req.id_usuario   → para saber quién registró cada movimiento
//   req.id_role      → para los guards y para el alcance por cámara
//   req.usuario      → el payload completo, por si hace falta algo más
//
//   cargarAlcance (alcance.middleware.js) depende de estos dos primeros.
//   Si se cambian de nombre, hay que ajustarlo allá también.
//
// ────────────────────────────────────────────────────────────────────────
// CORRECCIÓN DE SEGURIDAD · LA SESIÓN SE VALIDA CONTRA LA BD
// ────────────────────────────────────────────────────────────────────────
//   Antes verifyToken solo revisaba la firma del token. Como el token dura
//   12 horas, eso tenía dos consecuencias:
//
//     · Una cuenta DESHABILITADA seguía entrando hasta que vencía su token.
//       Si era admin o coordinador, con acceso total: cargarAlcance les da
//       camaras = null sin consultar nada. Un admin dado de baja podía
//       incluso crear otra cuenta de admin, y esa sí sobrevivía a la baja.
//
//     · BAJAR DE ROL a alguien no surtía efecto hasta que vencía el token,
//       porque el rol viajaba dentro del token.
//
//   Ahora cada petición consulta estado e id_role por llave primaria. Es la
//   consulta más barata posible y cierra los dos huecos: la baja y el cambio
//   de rol surten efecto en la siguiente petición.
//
//   El rol que manda es el de la BD, no el del token.
// ============================================================================

export const ROLES = {
    ADMIN: 1,
    COORDINADOR: 2,
    SUPERVISOR: 3,
    OPERATIVO: 4
};

// ----------------------------------------------------------------------------
// verifyToken — valida la sesión
// ----------------------------------------------------------------------------
// Va SIEMPRE primero en la cadena de middlewares: los demás guards asumen
// que req.id_role ya existe.
export const verifyToken = async (req, res, next) => {
    // ---- 1) El token ----
    let payload;

    try {
        const header = req.headers.authorization;

        if (!header || !header.startsWith("Bearer ")) {
            return res.status(401).json({
                error: "No se envió el token de sesión"
            });
        }

        const token = header.split(" ")[1];
        payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
        // Se distingue el vencimiento del token inválido: al frontend le
        // sirve para decidir si redirige al login o solo avisa.
        if (error.name === "TokenExpiredError") {
            return res.status(401).json({
                error: "Tu sesión expiró, vuelve a iniciar sesión",
                expirado: true
            });
        }

        return res.status(401).json({ error: "Token inválido" });
    }

    // Se aceptan varias formas del campo porque el login pudo firmarlo con
    // nombres distintos según la versión.
    const idUsuario = payload.id_usuario ?? payload.id ?? null;

    if (!idUsuario) {
        return res.status(401).json({
            error: "El token no contiene los datos de sesión esperados"
        });
    }

    // ---- 2) La cuenta, contra la BD ----
    // Va en su propio try: si la BD falla es un 500, no un "token inválido".
    // Confundirlos mandaría al usuario al login por un problema de servidor.
    try {
        const result = await db.query(
            `SELECT id_role, estado FROM usuarios WHERE id_usuario = $1`,
            [idUsuario]
        );

        const cuenta = result.rows[0];

        if (!cuenta || Number(cuenta.estado) !== 1) {
            return res.status(401).json({
                error: "Tu cuenta está deshabilitada o ya no existe",
                deshabilitado: true
            });
        }

        req.id_usuario = Number(idUsuario);
        // El rol de la BD, no el del token: así un cambio de rol surte
        // efecto de inmediato.
        req.id_role = Number(cuenta.id_role);
        req.usuario = { ...payload, id_role: req.id_role };

        next();
    } catch (error) {
        console.error("Error al validar la sesión contra la BD:", error);
        return res.status(500).json({
            error: "No se pudo validar la sesión"
        });
    }
};

// ----------------------------------------------------------------------------
// Guards por rol
// ----------------------------------------------------------------------------
// Fábrica de guards: evita repetir la misma comparación cuatro veces.
const guardDeRol = (nivelMinimo, etiqueta) => {
    return (req, res, next) => {
        if (!req.id_role) {
            return res.status(401).json({ error: "Sesión no válida" });
        }

        // Menor número = más privilegios. Admin (1) pasa todos los guards.
        if (req.id_role <= nivelMinimo) {
            return next();
        }

        return res.status(403).json({
            error: `Necesitas permisos de ${etiqueta} para esta acción`
        });
    };
};

export const verifyAdmin       = guardDeRol(ROLES.ADMIN, "administrador");
export const verifyCoordinador = guardDeRol(ROLES.COORDINADOR, "coordinador");
export const verifySupervisor  = guardDeRol(ROLES.SUPERVISOR, "supervisor");
export const verifyOperativo   = guardDeRol(ROLES.OPERATIVO, "operativo");

// ----------------------------------------------------------------------------
// firmarToken — se usa en el login
// ----------------------------------------------------------------------------
// 12 horas cubre un turno completo con margen. Con la validación contra la
// BD, la duración ya no es un riesgo de seguridad: deshabilitar la cuenta
// corta el acceso aunque el token siga vigente.
export const firmarToken = (usuario) => {
    return jwt.sign(
        {
            id_usuario: usuario.id_usuario,
            usuario: usuario.usuario,
            id_role: usuario.id_role
        },
        process.env.JWT_SECRET,
        { expiresIn: "12h" }
    );
};
