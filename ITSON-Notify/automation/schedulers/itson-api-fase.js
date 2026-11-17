// ITN-55 - Fase de la API REST de ITSON del cron. Corre aparte de la fase de iVirtual
// (extraccion-cron.js): su propio try/catch, sus conteos y a lo más una alerta.
//
// Por alumno de GET /internal/itson-profiles/active (con ITSON_PROFILES_API_KEY,
// distinta de INTERNAL_API_KEY), en secuencia:
//   1. getAlumnoInscrito: se consulta solo si hoy (hora de Hermosillo) cae en la
//      ventana desde ITSON_API_VENTANA_ANTES_DIAS (7) días antes de fechaInicioSemestre
//      hasta ITSON_API_VENTANA_DESPUES_DIAS (45) días después de fechaFinSemestre: las
//      calificaciones finales suelen salir al cierre o después. `inscrito` no decide:
//      con false, dentro de la ventana se consulta igual. Si las fechas no se pueden
//      leer, se consulta y se cuenta en fechas_ilegibles. Si el endpoint falla, se
//      consulta y se cuenta en inscripcion_fallida.
//   2. getProgress: semestres con semesterKey distinto de "0" y approvedSubjects menor
//      que totalSubjects, en orden, máximo 3.
//   3. getGrades por semestre. Si alguna materia trae un subject.program distinto de
//      la carrera guardada, se descarta esa respuesta (forma_invalida). Con 0 materias
//      no se envía. Si no, POST /internal/grade-snapshots con source "itson_api",
//      period = semesterKey y su propio run_id.
// Cada alumno va en su propio try/catch: una excepción se cuenta y se sigue.
//
// Códigos de salida: 0 sin fallas, sin ITSON_API_BASE_URL (fase deshabilitada), sin
// alumnos o con RPA_PAUSADO=true; 1 con al menos una falla, configuración inválida o
// backend inalcanzable.
//
// Privacidad: los logs llevan la posición del alumno (n/total), el semestre consultado,
// conteos, status HTTP y motivos. Nunca correo, matrícula, carrera, materias,
// calificaciones, las llaves ni la URL de la API. Toda línea pasa por ocultarValores
// con las llaves, la matrícula, la carrera y la URL en curso.
const { leerConfigEntrega, entregarResultados } = require("./entrega-backend");
const { crearClientePerfilesItson } = require("./perfiles-itson-backend");
const { crearClienteItsonApi, leerBaseUrl } = require("../services/itsonApiClient");
const { notificarFalloCritico } = require("../monitors/alertas");

const EXIT_CODES = { ok: 0, error: 1 };
const FUENTE = "itson-api";
const SOURCE = "itson_api";
const LABEL = "Calificación final";
const SIN_CALIFICACION = "-";
// Los demás códigos ("0".."10", "A") van literales en text. El significado de "A" sigue
// sin confirmarse: el worker no la interpreta (ver backend/src/services/itsonGradeCodes.js).
const MAX_SEMESTRES = 3;
const PAUSA_ENTRE_ALUMNOS_MS = 2_000;
const MIN_LONGITUD_API_KEY = 32;
const ZONA = "America/Hermosillo";
const RE_SEMESTRE = /^\d{2}$/;
const VENTANA_ANTES_DIAS = 7;
const VENTANA_DESPUES_DIAS = 45;
const MAX_VENTANA_DIAS = 365;

// Credencial exclusiva para GET /internal/itson-profiles/active (distinta de
// INTERNAL_API_KEY). El error nombra la variable, nunca su valor.
function leerLlavePerfiles(env = process.env) {
  const apiKey = env.ITSON_PROFILES_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "Falta ITSON_PROFILES_API_KEY en las variables del servicio." };
  }
  if (apiKey.length < MIN_LONGITUD_API_KEY) {
    return {
      ok: false,
      error: `ITSON_PROFILES_API_KEY debe tener al menos ${MIN_LONGITUD_API_KEY} caracteres.`,
    };
  }
  const interna = env.INTERNAL_API_KEY?.trim();
  if (interna && apiKey === interna) {
    return {
      ok: false,
      error: "ITSON_PROFILES_API_KEY debe ser distinta de INTERNAL_API_KEY.",
    };
  }
  return { ok: true, apiKey };
}

// Días de la ventana desde el env. { ok: true, antes, despues } o { ok: false, error }
// (el error nombra la variable, nunca el valor).
function leerVentana(env) {
  const leer = (nombre, defecto) => {
    const crudo = env[nombre]?.trim();
    if (!crudo) return defecto;
    if (!/^\d{1,3}$/.test(crudo) || Number(crudo) > MAX_VENTANA_DIAS) return null;
    return Number(crudo);
  };
  const antes = leer("ITSON_API_VENTANA_ANTES_DIAS", VENTANA_ANTES_DIAS);
  const despues = leer("ITSON_API_VENTANA_DESPUES_DIAS", VENTANA_DESPUES_DIAS);
  const malas = [];
  if (antes === null) malas.push("ITSON_API_VENTANA_ANTES_DIAS");
  if (despues === null) malas.push("ITSON_API_VENTANA_DESPUES_DIAS");
  if (malas.length > 0) return { ok: false, error: `${malas.join(" y ")} debe ser un entero de 0 a ${MAX_VENTANA_DIAS}.` };
  return { ok: true, antes, despues };
}

// "AAAA-MM-DD" más n días (n puede ser negativo).
function sumarDias(dia, n) {
  const [a, m, d] = dia.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

// true, false, o null si las fechas no se pueden leer.
function enVentana({ inicio, fin }, hoy, { antes, despues }) {
  if (!inicio || !fin) return null;
  return sumarDias(inicio, -antes) <= hoy && hoy <= sumarDias(fin, despues);
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fecha de hoy "AAAA-MM-DD" en Hermosillo.
const hoyEnHermosillo = (fecha = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit" }).format(fecha);

// Semestres a consultar: distintos de "0", con materias pendientes, en orden, máximo 3.
function semestresPendientes(semestres) {
  return semestres
    .filter((s) => s.semesterKey !== "0" && RE_SEMESTRE.test(s.semesterKey) && s.approvedSubjects < s.totalSubjects)
    .map((s) => s.semesterKey)
    .sort()
    .slice(0, MAX_SEMESTRES);
}

// Materias de getGrades -> courses del contrato. "-" queda como text null.
// Devuelve null si alguna materia es de otra carrera o si un idCatalog se repite.
function normalizarMaterias(materias, carrera) {
  const vistos = new Set();
  const courses = [];
  for (const m of materias) {
    if (m.program.toUpperCase() !== carrera) return null;
    if (vistos.has(m.idCatalog)) return null;
    vistos.add(m.idCatalog);
    const codigo = typeof m.gradeValue === "string" ? m.gradeValue.trim() : null;
    courses.push({
      externalId: m.idCatalog,
      subject: m.name,
      items: [
        {
          externalItemId: m.idCatalog,
          label: LABEL,
          value: null,
          text: codigo === null || codigo === "" || codigo === SIN_CALIFICACION ? null : codigo,
        },
      ],
    });
  }
  return courses;
}

async function ejecutarItsonApi({
  env = process.env,
  crearClienteApi = crearClienteItsonApi,
  crearClientePerfiles = crearClientePerfilesItson,
  entregar = entregarResultados,
  alertar = notificarFalloCritico,
  ocultar = (texto) => String(texto),
  pausa = esperar,
  pausaMs = PAUSA_ENTRE_ALUMNOS_MS,
  hoy = hoyEnHermosillo,
  log = console.log,
  logError = console.error,
} = {}) {
  // Valores del alumno y llaves en curso: toda línea de log pasa por ocultar con ellos.
  let enCurso = [env?.INTERNAL_API_KEY?.trim(), env?.ITSON_PROFILES_API_KEY?.trim()].filter(Boolean);
  const limpiar = (linea) => enCurso.reduce((t, v) => (v ? t.split(v).join("[oculto]") : t), ocultar(linea));
  const info = (linea) => log(limpiar(linea));
  const falla = (linea) => logError(limpiar(linea));
  const avisar = (evento) => alertar({ ...evento, fuente: FUENTE, fecha: new Date().toISOString() }, { log: falla, env });

  if (env.RPA_PAUSADO === "true") {
    info("RPA pausado (RPA_PAUSADO=true). No se consulta la API de ITSON.");
    return EXIT_CODES.ok;
  }
  if (!env.ITSON_API_BASE_URL?.trim()) {
    info("Fase de la API de ITSON deshabilitada: falta ITSON_API_BASE_URL.");
    return EXIT_CODES.ok;
  }

  const base = leerBaseUrl(env);
  const entrega = leerConfigEntrega(env);
  const llavePerfiles = leerLlavePerfiles(env);
  const ventana = leerVentana(env);
  if (!base.ok || !entrega.ok || !llavePerfiles.ok || !ventana.ok) {
    falla(
      `Fase de la API de ITSON cancelada: ${[base.error, entrega.error, llavePerfiles.error, ventana.error].filter(Boolean).join(" ")}`,
    );
    await avisar({ tipo: "configuracion" });
    return EXIT_CODES.error;
  }
  const secretosBase = [base.baseUrl, llavePerfiles.apiKey, entrega.config.apiKey];
  enCurso = secretosBase;

  const perfiles = await crearClientePerfiles({
    config: { backendUrl: entrega.config.backendUrl, apiKey: llavePerfiles.apiKey },
  }).listarActivos();
  if (!perfiles.ok) {
    falla(`No se pudo leer la lista de perfiles ITSON: status=${perfiles.status}`);
    await avisar({ tipo: "backend" });
    return EXIT_CODES.error;
  }

  const total = perfiles.alumnos.length;
  if (perfiles.descartados > 0) falla(`Perfiles ITSON con forma inválida descartados: ${perfiles.descartados}`);
  if (total === 0) {
    info("Sin perfiles ITSON: 0 alumno(s). Nada que consultar en la API.");
    return perfiles.descartados > 0 ? EXIT_CODES.error : EXIT_CODES.ok;
  }
  info(`Consultando la API de ITSON para ${total} alumno(s)...`);

  const api = crearClienteApi({ baseUrl: base.baseUrl });
  const c = {
    fuera_de_ventana: 0,
    fechas_ilegibles: 0,
    inscripcion_fallida: 0,
    sin_semestres: 0,
    semestres_consultados: 0,
    sin_materias: 0,
    entregadas: 0,
    fallas_api: 0,
    forma_invalida: perfiles.descartados,
    entregas_fallidas: 0,
    excepciones: 0,
  };

  const registrarFallaApi = (r, que, alumno) => {
    if (r.motivo === "forma_invalida") c.forma_invalida += 1;
    else c.fallas_api += 1;
    falla(`${que} fallida (${alumno}): motivo=${r.motivo} status=${r.status ?? "sin_respuesta"}`);
  };

  async function procesarAlumno({ email, matricula, career }, alumno) {
    const inscripcion = await api.getAlumnoInscrito({ matricula, career });
    if (!inscripcion.ok) {
      c.inscripcion_fallida += 1;
      falla(`getAlumnoInscrito fallida (${alumno}): motivo=${inscripcion.motivo}. Se consulta de todos modos.`);
    } else {
      const dentro = enVentana(inscripcion, hoy(), ventana);
      if (dentro === null) {
        c.fechas_ilegibles += 1;
        info(`Fechas del semestre ilegibles (${alumno}): se consulta de todos modos.`);
      } else if (!dentro) {
        c.fuera_de_ventana += 1;
        info(`Fuera de la ventana del semestre (${alumno}): se omite.`);
        return;
      }
    }

    const progreso = await api.getProgress({ matricula, career });
    if (!progreso.ok) return registrarFallaApi(progreso, "getProgress", alumno);

    const semestres = semestresPendientes(progreso.semestres);
    if (semestres.length === 0) {
      c.sin_semestres += 1;
      info(`Sin semestres pendientes (${alumno}).`);
      return;
    }

    for (const semestre of semestres) {
      c.semestres_consultados += 1;
      const grades = await api.getGrades({ matricula, career, semester: semestre });
      if (!grades.ok) {
        registrarFallaApi(grades, `getGrades semestre ${semestre}`, alumno);
        continue;
      }
      const courses = normalizarMaterias(grades.materias, career);
      if (courses === null) {
        c.forma_invalida += 1;
        falla(`Respuesta descartada (${alumno}, semestre ${semestre}): carrera distinta o materia repetida.`);
        continue;
      }
      if (courses.length === 0) {
        c.sin_materias += 1;
        info(`Semestre ${semestre} sin materias (${alumno}): no se envía.`);
        continue;
      }
      const envio = await entregar(
        { courses },
        { config: entrega.config, email, source: SOURCE, period: semestre, log: info, logError: falla },
      );
      if (envio.ok && !envio.omitido) c.entregadas += 1;
      else if (!envio.ok) c.entregas_fallidas += 1;
    }
  }

  for (let i = 0; i < total; i += 1) {
    const perfil = perfiles.alumnos[i];
    const alumno = `alumno ${i + 1}/${total}`;
    if (i > 0) await pausa(pausaMs);
    enCurso = [...secretosBase, perfil.matricula, perfil.matricula.replace(/^0+/, ""), perfil.career, perfil.email];
    try {
      await procesarAlumno(perfil, alumno);
    } catch (error) {
      // Solo el tipo: el mensaje podría traer datos del alumno.
      c.excepciones += 1;
      falla(`Excepción con ${alumno}: ${/^[A-Z][A-Za-z]{0,39}$/.test(error?.name ?? "") ? error.name : "Error"}`);
    } finally {
      enCurso = secretosBase;
    }
  }

  const fallidas = c.inscripcion_fallida + c.fallas_api + c.forma_invalida + c.entregas_fallidas + c.excepciones;
  const resumen =
    `Fase API de ITSON terminada: alumnos=${total} fuera_de_ventana=${c.fuera_de_ventana} ` +
    `fechas_ilegibles=${c.fechas_ilegibles} ` +
    `sin_semestres=${c.sin_semestres} semestres_consultados=${c.semestres_consultados} ` +
    `sin_materias=${c.sin_materias} entregadas=${c.entregadas} inscripcion_fallida=${c.inscripcion_fallida} ` +
    `fallas_api=${c.fallas_api} forma_invalida=${c.forma_invalida} entregas_fallidas=${c.entregas_fallidas} ` +
    `excepciones=${c.excepciones}`;

  if (fallidas > 0) {
    falla(resumen);
    await avisar({
      tipo: "api_itson_con_fallas",
      conteos: {
        cuentas: total,
        fallidas,
        fallas_api: c.fallas_api + c.excepciones,
        forma_invalida: c.forma_invalida,
        inscripcion_fallida: c.inscripcion_fallida,
        entregas_fallidas: c.entregas_fallidas,
      },
    });
    return EXIT_CODES.error;
  }
  info(resumen);
  return EXIT_CODES.ok;
}

module.exports = {
  ejecutarItsonApi,
  semestresPendientes,
  normalizarMaterias,
  leerLlavePerfiles,
  leerVentana,
  enVentana,
  sumarDias,
  VENTANA_ANTES_DIAS,
  VENTANA_DESPUES_DIAS,
  hoyEnHermosillo,
  MAX_SEMESTRES,
  EXIT_CODES,
};
