import { Router } from "express";
import { usuariosController } from "../controllers/usuarios.controller.js";
import {
    validarUsuarioNuevo,
    validarUsuarioEdicion,
    validarIdUsuario
} from "../middlewares/usuarios.middleware.js";
import { verifyToken, verifyAdmin, verifyCoordinador } from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// USUARIOS  ·  todo reservado al ADMINISTRADOR
// ============================================================================
// Crear cuentas implica repartir accesos y definir qué cámaras ve cada
// quien. Es la llave del sistema, así que no se delega.
//
// Excepción: /roles queda en coordinador+ porque es un catálogo de solo
// lectura que otros módulos podrían necesitar para mostrar etiquetas.

// ---- Consultas ----
router.get("/usuarios", verifyToken, verifyAdmin, usuariosController.getUsuarios);

// Catálogo de roles (solo lectura)
router.get("/roles", verifyToken, verifyCoordinador, usuariosController.getRoles);

// ⚠️ Supervisores y operativos SIN zona de trabajo: no verán ningún dato.
// Conviene revisarlo después de dar de alta personal nuevo.
router.get("/sincamaras", verifyToken, verifyAdmin, usuariosController.getSinCamaras);

router.get("/usuario/:id", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.getUsuarioById);

// ---- Alta y edición ----
router.post("/registrarusuario", verifyToken, verifyAdmin, validarUsuarioNuevo, usuariosController.createUsuario);

// No toca contraseña ni zona de trabajo: cada una tiene su endpoint
router.put("/actualizarusuario/:id", verifyToken, verifyAdmin, validarIdUsuario, validarUsuarioEdicion, usuariosController.updateUsuario);

// Restablecer contraseña de OTRO usuario (no pide la anterior).
// El cambio propio vive en /auth/cambiarpassword y sí la exige.
router.patch("/resetpassword/:id", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.resetPassword);

router.delete("/eliminarusuario/:id", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.deleteUsuario);

// ============================================================================
// ZONA DE TRABAJO — qué cámaras ve cada usuario
// ============================================================================
// Se administra APARTE del formulario de usuario, a propósito:
// usuarios_camaras conserva el histórico con fecha_fin, y eso se maneja mal
// dentro de un multi-select (al deseleccionar, ¿borra o cierra?).

// Asignaciones vigentes + histórico
router.get("/zonatrabajo/:id", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.getZonaTrabajo);

// Reemplaza la zona completa: llega la lista final y el modelo cierra las
// que sobran y abre las que faltan (en transacción).
router.post("/zonatrabajo/:id", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.guardarZonaTrabajo);

// Agregar UNA cámara sin tocar las demás
router.post("/zonatrabajo/:id/camara", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.asignarCamara);

// Dar de baja una asignación (marca fecha_fin, no borra el registro)
router.delete("/zonatrabajo/:id/camara/:id_camara", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.quitarCamara);

export default router;
