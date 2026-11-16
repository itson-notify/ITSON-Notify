// ITN-56 - Verificación de la API de Moodle (iVirtual) con la cuenta de un
// integrante del equipo. Lo corre el integrante en su máquina; no se usa en el cron.
//
// Uso (desde ITSON-Notify/):
//   node automation/scripts/verificar-ivirtual-fechas.js
//   node automation/scripts/verificar-ivirtual-fechas.js --nombres
//   node automation/scripts/verificar-ivirtual-fechas.js --curso 12345
//
// Lee Id_User y P_User de ITSON-Notify/.env (igual que cli.js) y pide el token a
// token.php. El token solo vive en memoria: no se imprime, no se guarda y los
// mensajes de error pasan por redact().
//
// La salida no trae datos personales: ni usuario, ni userid, ni nombre del
// alumno, ni calificaciones. Solo conteos, ids de curso y sí/no.
//   --nombres     agrega el nombre de cada curso (sirve para ubicar el curso de prueba)
//   --curso ID    detalle por actividad de ese curso: nombre de la actividad, tipo,
//                 si tiene nota (sí/no, sin el valor), si está oculta y su fecha de
//                 entrega en hora de Hermosillo
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "..", ".env"),
  quiet: true,
});
const { getToken, callWs, redact } = require("../rpa/ivirtual-api/client");
const { mapItem, mapAssignments } = require("../rpa/ivirtual-api/grades");

const FUNCIONES = [
  "core_enrol_get_users_courses",
  "gradereport_user_get_grade_items",
  "mod_assign_get_assignments",
  "core_calendar_get_action_events_by_timesort",
  "core_calendar_get_calendar_upcoming_view",
];

// Hermosillo: UTC-7 todo el año (Sonora no tiene horario de verano).
function enHermosillo(iso) {
  if (!iso) return "sin fecha";
  const d = new Date(Date.parse(iso) - 7 * 60 * 60 * 1000);
  const dos = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${dos(d.getUTCMonth() + 1)}-${dos(d.getUTCDate())} ${dos(d.getUTCHours())}:${dos(d.getUTCMinutes())} (UTC-7)`;
}

function argValor(argv, nombre) {
  const i = argv.indexOf(nombre);
  return i === -1 ? null : argv[i + 1] ?? null;
}

async function main() {
  const argv = process.argv.slice(2);
  const conNombres = argv.includes("--nombres");
  const cursoDetalle = argValor(argv, "--curso");

  if (!process.env.Id_User || !process.env.P_User) {
    console.error("Faltan Id_User o P_User en ITSON-Notify/.env");
    process.exitCode = 1;
    return;
  }

  let token = null;
  try {
    token = await getToken({ usuario: process.env.Id_User, password: process.env.P_User });
    console.log("token.php: ok (el token no se imprime)");

    const siteInfo = await callWs(token, "core_webservice_get_site_info");
    const permitidas = new Set((siteInfo.functions ?? []).map((f) => f.name));
    console.log("\nFunciones del servicio moodle_mobile_app:");
    for (const nombre of FUNCIONES) {
      console.log(`  ${nombre}: ${permitidas.has(nombre) ? "permitida" : "NO aparece"}`);
    }

    const cursos = (await callWs(token, "core_enrol_get_users_courses", { userid: siteInfo.userid })) ?? [];
    console.log(`\ncore_enrol_get_users_courses: ${cursos.length} curso(s)`);

    // Tareas en una sola llamada, como el worker.
    let porCurso = null;
    try {
      const resp = await callWs(token, "mod_assign_get_assignments", { courseids: cursos.map((c) => c.id) });
      porCurso = mapAssignments(resp);
      const total = [...porCurso.values()].reduce((n, m) => n + m.size, 0);
      console.log(
        `mod_assign_get_assignments: ok, ${total} tarea(s) en ${porCurso.size} curso(s), ` +
          `${(resp?.warnings ?? []).length} warning(s)`,
      );
    } catch (error) {
      console.log(`mod_assign_get_assignments: FALLÓ errorcode=${error.errorcode ?? error.status ?? "sin_codigo"}`);
      // Alternativa: eventos del calendario (solo conteo, para decidir).
      try {
        const desde = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
        const ev = await callWs(token, "core_calendar_get_action_events_by_timesort", { timesortfrom: desde, limitnum: 50 });
        const assign = (ev?.events ?? []).filter((e) => e.modulename === "assign");
        console.log(`core_calendar_get_action_events_by_timesort: ok, ${assign.length} evento(s) de tareas`);
      } catch (e2) {
        console.log(`core_calendar_get_action_events_by_timesort: FALLÓ errorcode=${e2.errorcode ?? e2.status ?? "sin_codigo"}`);
      }
    }

    console.log("\nPor curso (n/total):");
    for (let i = 0; i < cursos.length; i += 1) {
      const curso = cursos[i];
      const resp = await callWs(token, "gradereport_user_get_grade_items", {
        courseid: curso.id,
        userid: siteInfo.userid,
      });
      const items = (resp?.usergrades ?? []).flatMap((ug) => ug.gradeitems ?? []).map(mapItem);
      const tareas = porCurso?.get(String(curso.id)) ?? null;
      const unidas = tareas ? items.filter((it) => it.cmid !== null && tareas.has(String(it.cmid))) : [];
      const conFecha = unidas.filter((it) => tareas.get(String(it.cmid)).dueAt);
      const nombre = conNombres ? ` "${curso.fullname}"` : "";
      console.log(
        `  curso ${i + 1}/${cursos.length} id=${curso.id}${nombre}: items=${items.length} ` +
          `sin_nota=${items.filter((it) => it.value === null).length} ` +
          `hidden=${items.filter((it) => it.hidden).length} ` +
          `actividades(mod)=${items.filter((it) => it.type === "mod").length} ` +
          `tareas_unidas_por_cmid=${tareas ? unidas.length : "n/d"} con_fecha_entrega=${tareas ? conFecha.length : "n/d"}`,
      );

      if (cursoDetalle && String(curso.id) === String(cursoDetalle)) {
        for (const it of items) {
          const fechas = tareas?.get(String(it.cmid));
          console.log(
            `      - ${it.label ?? "(total del curso)"} | tipo=${it.type} | ` +
              `nota=${it.value === null ? "no" : "sí"} | hidden=${it.hidden ? "sí" : "no"} | ` +
              `entrega=${fechas ? enHermosillo(fechas.dueAt) : "no es tarea o sin dato"}`,
          );
        }
      }
    }
    console.log("\nListo. Revisa que la salida no tenga datos personales antes de compartirla.");
  } catch (error) {
    const limpio = redact(redact(redact(error.message, token), process.env.P_User), process.env.Id_User);
    console.error(`Verificación fallida: ${limpio} (errorcode=${error.errorcode ?? "sin_codigo"})`);
    process.exitCode = 1;
  } finally {
    token = null;
  }
}

main();
