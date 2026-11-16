// ITN-56 - Ensayo sintético del aviso de tarea nueva contra el backend LOCAL
// (conectado al Supabase de desarrollo itson-notify-dev). Nunca contra producción.
//
//   cd backend
//   npm run dev                                   # en otra terminal
//   node --env-file=.env scripts/ensayo-tarea-nueva.js
//
// Manda dos snapshots de iVirtual por POST /internal/grade-snapshots con x-api-key:
//   A  línea base, sin la tarea (el primer snapshot de un usuario no notifica)
//   B  la misma materia con una tarea nueva sin nota ("-") y con fecha de entrega
// con run_id distintos, captured_at crecientes, source "ivirtual" y sin period.
//
// Variables:
//   INTERNAL_API_KEY   la misma del backend (obligatoria)
//   ENSAYO_BACKEND_URL por defecto http://localhost:${PORT:-3000}; solo localhost
//   ENSAYO_EMAIL       por defecto un correo inventado y único por corrida
//                      (ensayo.itn56.<hora>@example.test), así A siempre es línea base.
//                      Para probar el Push de verdad hace falta un usuario con
//                      suscripción: ver docs/deployment/cron-railway.md.
//   ENSAYO_DUE_AT      fecha de entrega ISO; por defecto mañana 23:59 en Hermosillo
//
// Solo imprime status HTTP, conteos y los snapshot_id (run_id aleatorios) para
// revisar la base. Nunca la API key ni el correo.
const crypto = require("crypto");

const HORA_MS = 60 * 60 * 1000;
const HERMOSILLO_MS = 7 * HORA_MS; // UTC-7 todo el año

function backendUrl(env) {
  const url = new URL(env.ENSAYO_BACKEND_URL || `http://localhost:${env.PORT || 3000}`);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("El ensayo solo corre contra un backend local (localhost).");
  }
  return url.origin;
}

// Mañana a las 23:59 en Hermosillo, en UTC.
function mananaAlCierre(ahora) {
  const local = new Date(ahora - HERMOSILLO_MS);
  const cierre = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 23, 59);
  return new Date(cierre + HERMOSILLO_MS).toISOString();
}

function cursos({ conTarea, dueAt }) {
  const items = [
    { externalItemId: "ensayo-1", label: "Tarea de ensayo ya calificada", type: "mod", value: 90, text: "90.00", min: 0, max: 100, cmid: 70001, hidden: false, dueAt: null, opensAt: null, closesAt: null },
  ];
  if (conTarea) {
    items.push({ externalItemId: "ensayo-2", label: "Tarea nueva de ensayo", type: "mod", value: null, text: "-", min: 0, max: 100, cmid: 70002, hidden: false, dueAt, opensAt: null, closesAt: null });
  }
  return [{ externalId: "ensayo-curso", subject: "Curso de ensayo ITN-56", items }];
}

async function enviar(base, apiKey, body) {
  const res = await fetch(`${base}/internal/grade-snapshots`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function resumen(paso, { status, data }) {
  const campos = ["snapshot_id", "baseline", "changes_detected", "changes_inserted", "notified", "failed"];
  console.log(`${paso}: status=${status} ${campos.map((c) => `${c}=${data[c] ?? "?"}`).join(" ")}`);
}

async function main(env = process.env) {
  if (env.NODE_ENV === "production") throw new Error("El ensayo no corre con NODE_ENV=production.");
  if (!env.INTERNAL_API_KEY) throw new Error("Falta INTERNAL_API_KEY.");
  const base = backendUrl(env);
  const ahora = Date.now();
  const email = env.ENSAYO_EMAIL || `ensayo.itn56.${ahora}@example.test`;
  const dueAt = env.ENSAYO_DUE_AT || mananaAlCierre(ahora);

  const a = await enviar(base, env.INTERNAL_API_KEY, {
    run_id: crypto.randomUUID(),
    captured_at: new Date(ahora - 2 * 60_000).toISOString(),
    source: "ivirtual",
    user: { email },
    courses: cursos({ conTarea: false, dueAt }),
  });
  resumen("Snapshot A (línea base)", a);
  if (a.status !== 200) throw new Error("El snapshot A no se guardó.");

  const b = await enviar(base, env.INTERNAL_API_KEY, {
    run_id: crypto.randomUUID(),
    captured_at: new Date(ahora - 60_000).toISOString(),
    source: "ivirtual",
    user: { email },
    courses: cursos({ conTarea: true, dueAt }),
  });
  resumen("Snapshot B (tarea nueva)", b);
  if (b.status !== 200) throw new Error("El snapshot B no se guardó.");

  console.log(`\nFecha de entrega enviada (UTC): ${dueAt}`);
  console.log("Revisa en el SQL Editor de itson-notify-dev (consultas en docs/deployment/cron-railway.md):");
  console.log(`  snapshot B = ${b.data.snapshot_id}`);
  console.log(
    b.data.baseline === false && b.data.changes_inserted > 0
      ? "Esperado: grade_changes 'created' de ensayo-2 y notifications_log con 'Nueva tarea publicada'."
      : "OJO: B no generó cambios. ¿ENSAYO_EMAIL ya tenía snapshots con la tarea?",
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Ensayo fallido: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, backendUrl, mananaAlCierre, cursos };
