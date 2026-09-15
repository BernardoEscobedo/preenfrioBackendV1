import { Router } from "express";
import { authController } from "../controllers/auth.controller.js";
import { verifyToken } from "../middlewares/jwt.middlewares.js";

const router = Router();

// ============================================================================
// AUTENTICACIÓN
// ============================================================================
// Único módulo con una ruta pública (/login). Todo lo demás exige token.
// No lleva guards de rol: cualquier usuario autenticado puede consultar su
// propio perfil y cambiar su propia contraseña.
// ============================================================================

// Pública: es la puerta de entrada
router.post("/login", authController.login);

// Refresca los datos de sesión sin volver a iniciar sesión.
// Útil cuando un admin cambia las cámaras asignadas y el cambio debe
// reflejarse sin cerrar sesión.
router.get("/perfil", verifyToken, authController.getPerfil);

// Cámaras asignadas con sus nombres, para mostrarlas en el dashboard
router.get("/miscamaras", verifyToken, authController.getMisCamaras);

// Cambio de contraseña propia. Restablecer la de OTRO usuario es tarea del
// módulo de Usuarios (solo admin).
router.patch("/cambiarpassword", verifyToken, authController.cambiarPassword);

export default router;
