import { createHash } from "node:crypto";
import { aFechaISO, semanaISO } from "./fechas.js";

// ============================================================================
// IMPORTACIÓN DE PRODUCCIÓN · reglas de cada fila del Excel
// ============================================================================
// Funciones PURAS: reciben las filas y los catálogos ya cargados y regresan
// el veredicto de cada fila. No tocan la BD. La vista previa y la
// confirmación aplican exactamente las mismas reglas: la confirmación vuelve
// a evaluar todo y no confía en lo que mandó el navegador.
//
// ESTADOS DE UNA FILA
//   ok       lista para guardar
//   aviso    se puede guardar, pero hay algo que revisar
//   error    no se guarda hasta corregirla
//   omitida  ya se importó antes (misma huella): no se duplica
//
// REGLAS ACORDADAS
//   · Finca "A01 004 La Ceiba" → productor A01, finca 004. Debe coincidir
//     con la columna Productor; si no, es error.
//   · CEDIS + Cliente se resuelven con cedis_equivalencias. Si no hay
//     equivalencia, el usuario elige el destino y queda recordado.
//   · Estiba "Granel" o vacía = 0 tarimas, sin aviso. Con decimales se
//     redondea hacia arriba, con aviso.
//   · El lote lo propone el sistema (misma fórmula que fn_generar_lote). Si
//     el del Excel es distinto, el usuario elige cuál se guarda.
//   · El turno del lote sale del SKU.
//   · Las filas repetidas SÍ son producción: se cargan todas. La huella
//     solo evita volver a cargar lo que ya entró en un archivo anterior.
// ============================================================================

export const MAX_FILAS = 2000;

const ZONAS = {
    1: { letra: "A", nombre: "CHIAPAS" },
    2: { letra: "B", nombre: "COLIMA" },
    3: { letra: "C", nombre: "TABASCO" }
};

// Zona(1) Productor(2) Finca(3) - Semana(2) DDMM(4) - Turno(1)
const PATRON_LOTE = /^[A-Z][0-9A-Z]{2}[0-9A-Z]{3}-\d{6}-\d$/;
const PATRON_PRODUCTOR = /^[A-Z]\d{2}$/;
const PATRON_FINCA = /^[0-9A-Z]{3}$/;

/** Espacios repetidos y orillas fuera. */
export const limpiarTexto = (v) =>
    v === undefined || v === null ? "" : String(v).trim().replace(/\s+/g, " ");

const sinAcentos = (t) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Misma llave que la columna generada cedis_equivalencias.clave */
export const claveDestino = (cedis, cliente) =>
    `${limpiarTexto(cedis).toUpperCase()}|${limpiarTexto(cliente).toUpperCase()}`;

/** Réplica de fn_generar_lote() de la BD. */
export const generarLote = ({ zona, codigo_productor, codigo_finca, semana, fecha_empaque, turno }) => {
    const letra = ZONAS[zona]?.letra ?? "X";
    const prod = String(codigo_productor).slice(-2).padStart(2, "0");
    const finca = String(codigo_finca).slice(-3).padStart(3, "0");
    const [, mes, dia] = fecha_empaque.split("-");
    return `${letra}${prod}${finca}-${String(semana).padStart(2, "0")}${dia}${mes}-${turno ?? 1}`;
};

/** Suma días a 'AAAA-MM-DD' sin depender de la zona horaria del servidor. */
const sumarDias = (iso, dias) => {
    const [a, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
};

const aNumero = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : NaN;
};

/** El lote del Excel puede venir como #N/A, vacío o con espacios. */
const leerLoteExcel = (v) => {
    const t = limpiarTexto(v).toUpperCase();
    if (!t || t.startsWith("#")) return null;
    return t;
};

/** "A01 004 La Ceiba" → ["A01", "004", "LA", "CEIBA"] */
const tokens = (t) => limpiarTexto(t).toUpperCase().split(" ");

// ----------------------------------------------------------------------------
// Evaluar UNA fila
// ----------------------------------------------------------------------------
const evaluarFila = (entrada, cat, destinos) => {
    const mensajes = [];
    const error = (codigo, texto) => mensajes.push({ nivel: "error", codigo, texto });
    const aviso = (codigo, texto) => mensajes.push({ nivel: "aviso", codigo, texto });
    const datos = {};

    // ---- Semana ----
    const semana = aNumero(entrada.semana);
    if (semana === null) error("semana", "Falta la semana");
    else if (!Number.isInteger(semana) || semana < 1 || semana > 53)
        error("semana", `Semana inválida: ${entrada.semana}`);
    else datos.semana = semana;

    // ---- Fechas y tránsito ----
    const fechaEmpaque = entrada.fecha_empaque ? aFechaISO(entrada.fecha_empaque) : null;
    if (!entrada.fecha_empaque) error("fechas", "Falta la fecha de empaque");
    else if (!fechaEmpaque) error("fechas", `Fecha de empaque inválida: ${entrada.fecha_empaque}`);
    else datos.fecha_empaque = fechaEmpaque;

    if (datos.semana && datos.fecha_empaque) {
        const calculada = semanaISO(datos.fecha_empaque);
        const dif = Math.abs(calculada - datos.semana);
        if (dif > 1 && dif < 51)
            error("semana", `La semana ${datos.semana} no corresponde al empaque ${datos.fecha_empaque} (semana ${calculada})`);
    }

    const transito = aNumero(entrada.transito);
    datos.transito = null;
    if (Number.isNaN(transito) || (transito !== null && (!Number.isInteger(transito) || transito < 0 || transito > 30)))
        error("fechas", `Tránsito inválido: ${entrada.transito} (entero de 0 a 30 días)`);
    else datos.transito = transito;

    datos.fecha_entrega = null;
    if (entrada.fecha_entrega) {
        const fe = aFechaISO(entrada.fecha_entrega);
        if (!fe) error("fechas", `Fecha de entrega inválida: ${entrada.fecha_entrega}`);
        else datos.fecha_entrega = fe;
    }
    if (datos.fecha_empaque) {
        if (datos.fecha_entrega && datos.fecha_entrega < datos.fecha_empaque)
            error("fechas", "La fecha de entrega es anterior a la de empaque");
        else if (datos.transito !== null) {
            const esperada = sumarDias(datos.fecha_empaque, datos.transito);
            if (!entrada.fecha_entrega) {
                datos.fecha_entrega = esperada;
                aviso("fechas", `Sin fecha de entrega: se calculó ${esperada} (empaque + tránsito)`);
            } else if (datos.fecha_entrega && datos.fecha_entrega !== esperada) {
                aviso("fechas", `Entrega ${datos.fecha_entrega} no coincide con empaque + ${datos.transito} días (${esperada})`);
            }
        }
    }

    // ---- Productor y finca ----
    const [prodFinca, codFinca] = tokens(entrada.finca);
    const [prodColumna] = tokens(entrada.productor);
    let finca = null;
    let productor = null;

    if (!limpiarTexto(entrada.finca)) error("finca", "Falta la finca");
    else if (!PATRON_PRODUCTOR.test(prodFinca ?? "") || !PATRON_FINCA.test(codFinca ?? ""))
        error("finca", `No se reconoce "${limpiarTexto(entrada.finca)}". Formato esperado: "A01 004 Nombre"`);
    else if (!limpiarTexto(entrada.productor)) error("productor", "Falta el productor");
    else if (prodColumna !== prodFinca)
        error("productor", `La finca es de ${prodFinca} pero la columna Productor dice ${prodColumna}`);
    else {
        productor = cat.productores.get(prodFinca);
        if (!productor) error("productor", `El productor ${prodFinca} no existe en el catálogo`);
        else if (Number(productor.estado) !== 1) error("productor", `El productor ${prodFinca} está dado de baja`);
        else {
            const candidatas = cat.fincas.get(`${productor.id_productor}|${codFinca}`) ?? [];
            if (candidatas.length === 0)
                error("finca", `La finca ${codFinca} no está activa para el productor ${prodFinca}`);
            else if (candidatas.length > 1)
                error("finca", `La finca ${codFinca} está duplicada para ${prodFinca}: da de baja las repetidas`);
            else finca = candidatas[0];
        }
    }

    if (finca) {
        datos.id_finca = finca.id_finca;
        datos.id_productor = productor.id_productor;
        datos.finca = `${productor.codigo_productor} ${finca.codigo_finca} ${finca.nombre}`;
        datos.productor = `${productor.codigo_productor} ${productor.nombre}`;
    }

    // ---- Región ----
    const region = limpiarTexto(entrada.region).toUpperCase();
    if (region.length > 60) error("otro", "La región excede 60 caracteres");
    datos.region = region || (finca ? ZONAS[finca.zona]?.nombre ?? null : null);
    if (finca && region && sinAcentos(region) !== ZONAS[finca.zona]?.nombre)
        aviso("otro", `Región "${region}" pero la finca es de ${ZONAS[finca.zona]?.nombre ?? "otra zona"}`);

    // ---- Destino ----
    const cedisExcel = limpiarTexto(entrada.cedis);
    const clienteExcel = limpiarTexto(entrada.cliente);
    const destino = { clave: null, cedis_excel: cedisExcel, cliente_excel: clienteExcel, id_cc: null, origen: null };
    if (!cedisExcel || !clienteExcel) error("destino", "Faltan CEDIS o Cliente");
    else {
        destino.clave = claveDestino(cedisExcel, clienteExcel);
        const elegido = destinos[destino.clave];
        const idCc = elegido ? Number(elegido) : cat.equivalencias.get(destino.clave);
        if (!idCc) error("destino", `"${cedisExcel} / ${clienteExcel}" no tiene destino asignado: elígelo una vez`);
        else {
            const cc = cat.cedis.get(Number(idCc));
            if (!cc) error("destino", "El destino elegido no existe");
            else if (Number(cc.estado) !== 1) error("destino", `El destino ${cc.acronimo} está dado de baja`);
            else {
                destino.id_cc = cc.id_cc;
                destino.origen = elegido ? "seleccion" : "equivalencia";
                datos.id_cc = cc.id_cc;
                datos.destino = `${cc.cliente} · ${cc.cedis}`;
                datos.acronimo_cc = cc.acronimo;
            }
        }
    }

    // ---- SKU ----
    const codigoSku = limpiarTexto(entrada.sku).toUpperCase();
    let sku = null;
    if (!codigoSku) error("sku", "Falta el SKU");
    else {
        sku = cat.skus.get(codigoSku);
        if (!sku) error("sku", `El SKU ${codigoSku} no existe en el catálogo`);
        else if (Number(sku.estado) !== 1) {
            error("sku", `El SKU ${codigoSku} está dado de baja`);
            sku = null;
        } else {
            datos.id_sku = sku.id_sku;
            datos.codigo_sku = sku.codigo_sku;
            datos.calidad = sku.calidad;
        }
    }

    // ---- Cantidades ----
    const cajas = aNumero(entrada.cajas);
    if (cajas === null) error("cantidades", "Faltan las cajas procesadas");
    else if (!Number.isInteger(cajas) || cajas < 0) error("cantidades", `Cajas inválidas: ${entrada.cajas}`);
    else datos.cajas = cajas;

    const estibaTexto = limpiarTexto(entrada.estiba);
    if (!estibaTexto || /^granel$/i.test(estibaTexto)) datos.tarimas = 0;
    else {
        const est = aNumero(entrada.estiba);
        if (Number.isNaN(est) || est < 0) error("cantidades", `Estiba inválida: ${estibaTexto}`);
        else if (!Number.isInteger(est)) {
            datos.tarimas = Math.ceil(est);
            aviso("cantidades", `Estiba ${est} redondeada a ${datos.tarimas} tarimas`);
        } else datos.tarimas = est;
    }

    if (datos.cajas !== undefined && datos.tarimas !== undefined) {
        if (datos.cajas === 0 && datos.tarimas === 0) error("cantidades", "La fila no tiene cajas ni tarimas");
        else if (datos.tarimas > 0 && datos.cajas > 0 && datos.tarimas > datos.cajas)
            error("cantidades", `${datos.tarimas} tarimas con solo ${datos.cajas} cajas no es posible`);
        else if (datos.tarimas > 0 && datos.cajas > datos.tarimas * 60)
            error("cantidades", `${datos.cajas} cajas no caben en ${datos.tarimas} tarimas`);
    }

    // ---- Comentarios ----
    const comentarios = limpiarTexto(entrada.comentarios);
    if (comentarios.length > 250) error("otro", "Los comentarios exceden 250 caracteres");
    datos.comentarios = comentarios || null;

    // ---- Lote ----
    const loteExcel = leerLoteExcel(entrada.lote);
    const lote = {
        excel: loteExcel,
        excel_valido: Boolean(loteExcel && PATRON_LOTE.test(loteExcel)),
        sugerido: null,
        usar: "sugerido"
    };
    if (finca && sku && datos.semana && datos.fecha_empaque) {
        lote.sugerido = generarLote({
            zona: finca.zona,
            codigo_productor: productor.codigo_productor,
            codigo_finca: finca.codigo_finca,
            semana: datos.semana,
            fecha_empaque: datos.fecha_empaque,
            turno: sku.turno
        });
        if (loteExcel && loteExcel !== lote.sugerido) {
            if (!lote.excel_valido)
                aviso("lote", `El lote del Excel "${loteExcel}" no tiene formato válido: se usará ${lote.sugerido}`);
            else {
                if (entrada.usar_lote === "excel") lote.usar = "excel";
                aviso("lote", `El Excel dice ${loteExcel} y el sistema sugiere ${lote.sugerido}: elige cuál guardar`);
            }
        }
    }
    datos.codigo_lote = lote.usar === "excel" ? lote.excel : lote.sugerido;

    const hayError = mensajes.some((m) => m.nivel === "error");
    const resultado = {
        fila: entrada.fila,
        estado: hayError ? "error" : mensajes.length ? "aviso" : "ok",
        mensajes,
        datos,
        destino,
        lote,
        huella: null
    };

    // La huella solo existe para filas completas. Incluye el comentario: dos
    // filas iguales salvo el comentario (MKEXP-3 / MKEXP-4) son distintas.
    if (!hayError) {
        resultado.huella = createHash("sha256")
            .update(JSON.stringify([
                datos.semana, datos.id_finca, datos.id_productor, datos.fecha_empaque,
                datos.transito, datos.fecha_entrega, datos.id_cc, datos.id_sku,
                datos.cajas, datos.tarimas, datos.comentarios
            ]))
            .digest("hex");
    }
    return resultado;
};

/** Evalúa todas las filas con los catálogos y destinos elegidos. */
export const evaluarFilas = (filas, catalogos, destinos = {}) =>
    filas.map((f) => evaluarFila(f, catalogos, destinos));

/**
 * Marca como omitidas las filas que ya se importaron.
 * Cuenta por huella: si el archivo trae 2 iguales y ya hay 1 guardada,
 * se omite la primera y se carga la segunda.
 */
export const marcarYaImportadas = (resultados, conteoBD) => {
    const vistas = new Map();
    for (const r of resultados) {
        if (!r.huella) continue;
        const n = vistas.get(r.huella) ?? 0;
        vistas.set(r.huella, n + 1);
        if (n < (conteoBD.get(r.huella) ?? 0)) {
            r.estado = "omitida";
            r.mensajes.unshift({
                nivel: "aviso",
                codigo: "duplicado",
                texto: "Ya se importó en un archivo anterior: no se vuelve a cargar"
            });
        }
    }
    return resultados;
};

/** Totales y destinos sin resolver para la pantalla. */
export const resumir = (resultados) => {
    const resumen = { total: resultados.length, ok: 0, aviso: 0, error: 0, omitida: 0, cajas: 0, tarimas: 0 };
    const pendientes = new Map();
    for (const r of resultados) {
        resumen[r.estado] += 1;
        if (r.estado === "ok" || r.estado === "aviso") {
            resumen.cajas += r.datos.cajas ?? 0;
            resumen.tarimas += r.datos.tarimas ?? 0;
        }
        if (r.destino.clave && !r.destino.id_cc) {
            const p = pendientes.get(r.destino.clave) ?? {
                clave: r.destino.clave,
                cedis_excel: r.destino.cedis_excel,
                cliente_excel: r.destino.cliente_excel,
                filas: 0
            };
            p.filas += 1;
            pendientes.set(r.destino.clave, p);
        }
    }
    return { resumen, destinos_pendientes: [...pendientes.values()] };
};
