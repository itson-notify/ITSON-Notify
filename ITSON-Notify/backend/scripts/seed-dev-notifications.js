// ITN-53 - Siembra notificaciones de ejemplo para probar el frontend en dev.
//
//   SEED_ALUMNO_EMAIL=<correo> npm run seed:dev
//
// El alumno debe existir en app_users (entrar una vez con Google lo crea) y la
// migración 009 debe estar aplicada. Se puede repetir: no duplica filas y vuelve
// a dejar las notificaciones como al inicio. Las filas quedan en 'sent' y solo en
// el canal log, así que el reintento del backend nunca las envía a nadie.
//
// Para borrarlas, en el SQL Editor de dev:
//   delete from notifications_log where grade_change_id in
//     (select id from grade_changes where external_item_id like 'seed:%');
//   delete from grade_changes where external_item_id like 'seed:%';
//   delete from subjects where external_subject_id like 'seed:%';
const { createSupabaseClient } = require("../src/config/supabase");
const { check } = require("../src/utils/errors");
const { GRADE_CHANGES_ON_CONFLICT } = require("../src/repositories/gradeChangeRepository");
const { NOTIFICATIONS_ON_CONFLICT } = require("../src/repositories/notificationRepository");
const { buildGroupedMessage } = require("../src/services/notificationService");

const HORA = 60 * 60 * 1000;
const PERIODO = "seed";

const EJEMPLOS = [
  { clave: "seed:1", materia: "Materia de ejemplo A", actividad: "Tarea 1", changeType: "created", antes: null, ahora: "92", horas: 2, leida: false },
  { clave: "seed:2", materia: "Materia de ejemplo B", actividad: "Examen parcial", changeType: "updated", antes: "80", ahora: "85", horas: 5, leida: false },
  { clave: "seed:3", materia: "Materia de ejemplo A", actividad: "Práctica 2", changeType: "created", antes: null, ahora: "78", horas: 48, leida: true },
];

function assertNotProduction(env) {
  if (env.NODE_ENV === "production") throw new Error("El script de siembra no corre con NODE_ENV=production.");
}

async function sembrarUno(supabase, userId, ejemplo, ahora) {
  const fecha = new Date(ahora - ejemplo.horas * HORA).toISOString();
  const subject = check(
    "subjects",
    await supabase
      .from("subjects")
      .upsert(
        { user_id: userId, external_subject_id: `seed:${ejemplo.materia}`, name: ejemplo.materia, period: PERIODO },
        { onConflict: "user_id,external_subject_id,name,period" },
      )
      .select("id")
      .single(),
  );
  const fila = {
    user_id: userId,
    subject_id: subject.id,
    previous_snapshot_id: null,
    current_snapshot_id: null,
    external_item_id: ejemplo.clave,
    field_name: "grade_value",
    previous_value: ejemplo.antes,
    current_value: ejemplo.ahora,
    change_type: ejemplo.changeType,
    detected_at: fecha,
  };
  const cambio = check(
    "grade_changes",
    await supabase
      .from("grade_changes")
      .upsert(fila, { onConflict: GRADE_CHANGES_ON_CONFLICT })
      .select("id")
      .single(),
  );
  const mensaje = buildGroupedMessage([fila], { subjectName: ejemplo.materia, itemLabel: ejemplo.actividad });
  check(
    "notifications_log",
    await supabase.from("notifications_log").upsert(
      {
        user_id: userId,
        grade_change_id: cambio.id,
        channel: "log",
        payload: { ...mensaje, grade_change_ids: [cambio.id] },
        status: "sent",
        attempts: 1,
        sent_at: fecha,
        created_at: fecha,
        read_at: ejemplo.leida ? fecha : null,
      },
      { onConflict: NOTIFICATIONS_ON_CONFLICT },
    ),
  );
}

// Devuelve cuántas notificaciones sembró. Lanza si el alumno no existe: crearlo
// aquí dejaría un app_users sin relación con su sesión de Google.
async function seedNotifications({ supabase, email, env = process.env, now = Date.now }) {
  assertNotProduction(env);
  const user = check(
    "app_users",
    await supabase.from("app_users").select("id").eq("email", email).maybeSingle(),
  );
  if (!user) throw new Error("No existe ese alumno en app_users. Entra una vez con Google y vuelve a correrlo.");
  for (const ejemplo of EJEMPLOS) await sembrarUno(supabase, user.id, ejemplo, now());
  return EJEMPLOS.length;
}

async function main(env = process.env) {
  assertNotProduction(env);
  const email = (env.SEED_ALUMNO_EMAIL ?? "").trim().toLowerCase();
  const faltan = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((name) => !env[name]);
  if (!email) faltan.push("SEED_ALUMNO_EMAIL");
  if (faltan.length > 0) throw new Error(`Faltan variables de entorno: ${faltan.join(", ")}`);

  const supabase = createSupabaseClient({
    supabaseUrl: env.SUPABASE_URL,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  const total = await seedNotifications({ supabase, email, env });
  console.log(`${total} notificaciones de ejemplo listas en ${new URL(env.SUPABASE_URL).host}.`);
}

if (require.main === module) {
  main().catch((error) => {
    // Nunca el mensaje de Supabase: puede traer valores de las filas.
    const detalle = error.step ? `Falló ${error.step} (código ${error.code ?? "desconocido"}).` : error.message;
    console.error(`Siembra detenida. ${detalle}`);
    process.exit(1);
  });
}

module.exports = { seedNotifications, assertNotProduction, EJEMPLOS };
