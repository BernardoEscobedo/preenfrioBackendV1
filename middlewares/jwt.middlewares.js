import jwt from "jsonwebtoken";
import dotenv from "dotenv";

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
export const verifyToken = (req, res, next) => {
    try {
        const header = req.headers.authorization;

        if (!header || !header.startsWith("Bearer ")) {
            return res.status(401).json({
                error: "No se envió el token de sesión"
            });
        }

        const token = header.split(" ")[1];
        const payload = jwt.verify(token, process.env.JWT_SECRET);

        // Se aceptan varias formas del campo de rol porque el login pudo
        // firmarlo como 'role' o 'id_role' según la versión.
        req.id_usuario = payload.id_usuario ?? payload.id ?? null;
        req.id_role = Number(payload.id_role ?? payload.role ?? 0);
        req.usuario = payload;

        if (!req.id_usuario || !req.id_role) {
            return res.status(401).json({
                error: "El token no contiene los datos de sesión esperados"
            });
        }

        next();
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
// 12 horas cubre un turno completo con margen. Más tiempo sería cómodo pero
// deja sesiones vivas en dispositivos compartidos de planta.
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
