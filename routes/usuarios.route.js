import { Router } from "express";
import { usuariosController } from "../controllers/usuarios.controller.js";
import {
    validarUsuarioNuevo,
    validarUsuarioEdicion,
    validarIdUsuario
} from "../middlewares/usuarios.middleware.js";
import { validarMotivoBaja } from "../middlewares/bajas.middleware.js";
import { verifyToken, verifyAdmin, verifyCoordinador } from "../middlewares/jwt.middleware.js";

const router = Router();

// ============================================================================
// USUARIOS  ·  todo reservado al ADMINISTRADOR
// ============================================================================
// Excepción: /roles queda en coordinador+ (catálogo de solo lectura).
//
// DESHABILITAR ES LA VÍA NORMAL DE BAJA y exige motivo: queda en el
// historial (GET /bajas/historial). El borrado físico solo prospera con
// cuentas creadas por error, sin registros.
// ============================================================================

// ---- Consultas ----
router.get("/usuarios", verifyToken, verifyAdmin, usuariosController.getUsuarios);

router.get("/roles", verifyToken, verifyCoordinador, usuariosController.getRoles);

// Supervisores y operativos habilitados SIN zona de trabajo
router.get("/sincamaras", verifyToken, verifyAdmin, usuariosController.getSinCamaras);

router.get("/usuario/:id", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.getUsuarioById);

// ---- Alta y edición ----
router.post("/registrarusuario", verifyToken, verifyAdmin, validarUsuarioNuevo, usuariosController.createUsuario);

router.put("/actualizarusuario/:id", verifyToken, verifyAdmin, validarIdUsuario, validarUsuarioEdicion, usuariosController.updateUsuario);

// ---- Habilitar / deshabilitar (quedan en el historial) ----
// body: { motivo }  obligatorio al deshabilitar, opcional al habilitar
router.patch("/deshabilitar/:id", verifyToken, verifyAdmin, validarIdUsuario, validarMotivoBaja(), usuariosController.deshabilitarUsuario);

router.patch("/habilitar/:id", verifyToken, verifyAdmin, validarIdUsuario, validarMotivoBaja(false), usuariosController.habilitarUsuario);

router.patch("/resetpassword/:id", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.resetPassword);

// Borrado físico: solo altas por error sin registros asociados
router.delete("/eliminarusuario/:id", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.deleteUsuario);

// ============================================================================
// ZONA DE TRABAJO — qué cámaras ve cada usuario
// ============================================================================
router.get("/zonatrabajo/:id", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.getZonaTrabajo);

router.post("/zonatrabajo/:id", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.guardarZonaTrabajo);

router.post("/zonatrabajo/:id/camara", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.asignarCamara);

router.delete("/zonatrabajo/:id/camara/:id_camara", verifyToken, verifyAdmin, validarIdUsuario, usuariosController.quitarCamara);

export default router;
