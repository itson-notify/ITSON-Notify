const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "..", ".env"),
  quiet: true,
});
const { extractGradesWithToken } = require("../rpa/ivirtual-api");
const { notificarFalloCritico, nombreErrorSeguro } = require("../monitors/alertas");
const { entregarResultados, leerConfigEntrega } = require("./entrega-backend");
const { crearClienteCredenciales } = require("./credenciales-backend");

// Punto de entrada del cron de Railway (ITN-25). Railway lo arranca según el
// cronSchedule de .railway/railway.ts; corre UNA pasada y termina.
// La política de reinicio del servicio es NEVER: un código distinto de 0 no
// provoca reintentos, la siguiente corrida es la del próximo horario.
//
// ITN-52 - Multi-alumno con el token de la base. Ya no usa Id_User, P_User ni
// ALUMNO_EMAIL: pide al backend las cuentas activas y, una por una (con una pausa
// corta entre cuentas), pide el token, extrae y entrega con el correo de esa cuenta.
//
//   - token_invalido (solo el errorcode invalidtoken): se marca needs_relink con
//     reason "credenciales" al final de la corrida. Esa cuenta deja de salir en
//     /active, así que no se reintenta hasta que el alumno vuelva a vincular. No
//     alerta al equipo: es normal y el equipo no lo puede arreglar.
//   - Protección: si se procesaron 3 o más cuentas y TODAS dieron invalidtoken, se
//     sospecha de iVirtual y no de los alumnos: no se marca ninguna, se alerta una
//     vez ("tokens rechazados en bloque") y se sale con 1.
//   - get con 404 (la desvincularon durante la corrida) o 409 (ya en needs_relink):
//     se omite en silencio. Un 401 cancela toda la corrida.
//   - Cualquier otro error de una cuenta (iVirtual, backend, entrega) se cuenta y
//     la corrida sigue con las demás.
//
// Códigos de salida:
//   0  todo bien, sin cuentas activas, solo tokens rechazados, o RPA_PAUSADO=true
//   1  falla de infraestructura o de iVirtual en al menos una cuenta, configuración
//      incompleta, backend inalcanzable, 401, tokens en bloque o excepción
//
// Alertas (ITN-39): a lo más UNA por corrida, solo con conteos y nunca con datos de
// un alumno. Se espera el envío antes de terminar.
//
// Railway marca como error todo lo que sale por stderr: lo informativo va por
// log (stdout) y las fallas por logError (stderr). Los logs solo llevan conteos,
// posición de la cuenta (n/total), status HTTP y errorcode: nunca correo, usuario,
// contraseña ni token.
const EXIT_CODES = { ok: 0, error: 1 };

const PAUSA_ENTRE_CUENTAS_MS = 2_000;
const MINIMO_PARA_BLOQUE = 3;

const VARIABLES_SECRETAS = ["INTERNAL_API_KEY", "TELEGRAM_BOT_TOKEN"];

// Última red para cualquier texto que vaya a los logs: quita los valores secretos
// del env y, desde ITN-52, el token de la cuenta en curso (y cualquier otro valor
// que se pase en `extras`).
function ocultarValores(texto, env, extras = []) {
  const valores = [...VARIABLES_SECRETAS.map((nombre) => env?.[nombre]?.trim()), ...extras];
  return valores.reduce(
    (limpio, valor) => (typeof valor === "string" && valor ? limpio.split(valor).join("[oculto]") : limpio),
    String(texto),
  );
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ejecutar({
  env = process.env,
  extract = extractGradesWithToken,
  alertar = notificarFalloCritico,
  entregar = entregarResultados,
  crearCliente = crearClienteCredenciales,
  pausa = esperar,
  pausaMs = PAUSA_ENTRE_CUENTAS_MS,
  log = console.log,
  logError = console.error,
} = {}) {
  // Token de la cuenta en curso: toda línea de log pasa por ocultarValores con él.
  let tokenEnCurso = null;
  const info = (linea) => log(ocultarValores(linea, env, [tokenEnCurso]));
  const falla = (linea) => logError(ocultarValores(linea, env, [tokenEnCurso]));
  // El env de la corrida también decide a qué chat de Telegram se avisa.
  const avisar = (evento) => alertar({ ...evento, fecha: new Date().toISOString() }, { log: falla, env });

  if (env.RPA_PAUSADO === "true") {
    info("RPA pausado (RPA_PAUSADO=true). No se consulta iVirtual.");
    return EXIT_CODES.ok;
  }

  const entrega = leerConfigEntrega(env);
  if (!entrega.ok) {
    falla(entrega.error);
    await avisar({ tipo: "configuracion", fuente: "worker-rpa" });
    return EXIT_CODES.error;
  }

  const cliente = crearCliente({ config: entrega.config });
  const activas = await cliente.listarActivas();
  if (!activas.ok) {
    falla(`No se pudo leer la lista de cuentas activas: status=${activas.status}`);
    await avisar({ tipo: "backend", fuente: "worker-rpa" });
    return EXIT_CODES.error;
  }

  const total = activas.emails.length;
  if (total === 0) {
    info("Sin cuentas activas de iVirtual: 0 cuenta(s). Nada que consultar.");
    return EXIT_CODES.ok;
  }
  info(`Consultando iVirtual (API de Moodle) para ${total} cuenta(s)...`);

  const c = {
    procesadas: 0, // cuentas con token leído y extracción intentada
    entregadas: 0,
    sin_cursos: 0,
    omitidas: 0,
    token_invalido: 0,
    fallas_ivirtual: 0,
    fallas_backend: 0,
    entregas_fallidas: 0,
  };
  const porMarcar = [];

  for (let i = 0; i < total; i += 1) {
    const email = activas.emails[i];
    const cuenta = `cuenta ${i + 1}/${total}`;
    if (i > 0) await pausa(pausaMs);

    const lectura = await cliente.leerToken(email);
    if (!lectura.ok) {
      if (lectura.status === 404 || lectura.status === 409) {
        c.omitidas += 1;
        continue;
      }
      if (lectura.status === 401) {
        falla(`Lectura de token rechazada por el backend (${cuenta}): status=401. Corrida cancelada.`);
        await avisar({ tipo: "backend", fuente: "worker-rpa", conteos: { cuentas: total - i } });
        return EXIT_CODES.error;
      }
      c.fallas_backend += 1;
      falla(`Lectura de token fallida (${cuenta}): status=${lectura.status}`);
      continue;
    }

    // El token vive hasta terminar con esta cuenta (extracción y entrega) y se
    // suelta en el finally, aunque algo lance.
    tokenEnCurso = lectura.token;
    try {
      c.procesadas += 1;
      const result = await extract(tokenEnCurso);
      await procesarResultado(result, email, cuenta);
    } finally {
      tokenEnCurso = null;
    }
  }

  async function procesarResultado(result, email, cuenta) {
    if (result.status === "ok") {
      const items = result.courses.reduce((n, curso) => n + curso.items.length, 0);
      info(`Extracción correcta (${cuenta}): ${result.courses.length} curso(s), ${items} ítem(s).`);
      const envio = await entregar(result, {
        config: entrega.config,
        email,
        capturedAt: new Date().toISOString(),
        log: info,
        logError: falla,
      });
      if (!envio.ok) c.entregas_fallidas += 1;
      else if (envio.omitido) c.sin_cursos += 1;
      else c.entregadas += 1;
      return;
    }

    if (result.status === "token_invalido") {
      c.token_invalido += 1;
      porMarcar.push(email);
      info(`Token rechazado por iVirtual (${cuenta}): se marcará para revincular.`);
      return;
    }

    // Falla pasajera o de permisos: ya hubo reintentos dentro del cliente; la
    // siguiente corrida lo vuelve a intentar. Solo el errorcode llega al log.
    c.fallas_ivirtual += 1;
    const codigo = /^[a-z_]{1,40}$/.test(result.errorcode ?? "") ? result.errorcode : "sin_codigo";
    falla(`Extracción fallida (${cuenta}): errorcode=${codigo}`);
  }

  // Protección contra rechazos en bloque: probablemente es iVirtual, no los alumnos.
  const enBloque = c.procesadas >= MINIMO_PARA_BLOQUE && c.token_invalido === c.procesadas;
  let marcadas = 0;
  if (enBloque) {
    falla(
      `Tokens rechazados en bloque: ${c.token_invalido} de ${c.procesadas} cuenta(s) procesadas. ` +
        "No se marca ninguna para revincular.",
    );
  } else {
    for (const email of porMarcar) {
      const marca = await cliente.marcarRevinculacion(email, "credenciales");
      if (marca.ok) marcadas += 1;
      else {
        c.fallas_backend += 1;
        falla(`No se pudo marcar una cuenta para revincular: status=${marca.status}`);
      }
    }
  }

  const resumen =
    `Corrida terminada: cuentas=${total} procesadas=${c.procesadas} entregadas=${c.entregadas} ` +
    `sin_cursos=${c.sin_cursos} omitidas=${c.omitidas} token_invalido=${c.token_invalido} ` +
    `marcadas_revinculacion=${marcadas} fallas_ivirtual=${c.fallas_ivirtual} ` +
    `fallas_backend=${c.fallas_backend} entregas_fallidas=${c.entregas_fallidas}`;
  const fallidas = c.fallas_ivirtual + c.fallas_backend + c.entregas_fallidas;

  if (enBloque) {
    falla(resumen);
    await avisar({
      tipo: "tokens_en_bloque",
      fuente: "ivirtual-api",
      conteos: { cuentas: c.procesadas, token_invalido: c.token_invalido },
    });
    return EXIT_CODES.error;
  }
  if (fallidas > 0) {
    falla(resumen);
    await avisar({
      tipo: "corrida_con_fallas",
      fuente: "worker-rpa",
      conteos: {
        cuentas: total,
        fallidas,
        fallas_ivirtual: c.fallas_ivirtual,
        fallas_backend: c.fallas_backend,
        entregas_fallidas: c.entregas_fallidas,
      },
    });
    return EXIT_CODES.error;
  }
  info(resumen);
  return EXIT_CODES.ok;
}

// Última red del proceso. Solo el nombre del error, ni en logs ni en la alerta
// va error.message: podría traer valores de la configuración o de la respuesta.
async function arrancar({
  correr = ejecutar,
  alertar = notificarFalloCritico,
  logError = console.error,
} = {}) {
  try {
    return await correr();
  } catch (error) {
    const nombre = nombreErrorSeguro(error?.name) ?? "Error";
    logError(`Error durante la extracción programada: ${nombre}`);
    await alertar(
      {
        tipo: "excepcion",
        fuente: "worker-rpa",
        nombre_error: nombre,
        fecha: new Date().toISOString(),
      },
      { log: logError },
    );
    return EXIT_CODES.error;
  }
}

if (require.main === module) {
  arrancar().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { ejecutar, arrancar, ocultarValores, EXIT_CODES, PAUSA_ENTRE_CUENTAS_MS, MINIMO_PARA_BLOQUE };
