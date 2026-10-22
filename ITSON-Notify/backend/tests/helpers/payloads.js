// Datos de prueba inventados con la forma de la salida de extractGrades()
// (ITN-23, ver automation/rpa/ivirtual-api/test/fixtures) más los campos del
// worker. Ninguno es real.
const crypto = require("crypto");

// Armadas en tiempo de ejecución para que no parezcan secretos en el repo.
const API_KEY = ["llave", "de", "prueba", "x".repeat(32)].join("-");
const OTRA_API_KEY = ["llave", "de", "prueba", "y".repeat(32)].join("-");

const EMAIL = "alumna.prueba@example.test";
const OTRO_EMAIL = "otro.alumno@example.test";
const MATERIA_A = "Materia de prueba A";
const MATERIA_B = "Materia de prueba B";

function cursos({ tarea2 = 70 } = {}) {
  return [
    {
      externalId: "501",
      subject: MATERIA_A,
      items: [
        { externalItemId: "9001", label: "Tarea 1", type: "mod", value: 85.5, text: "85.50", min: 0, max: 100, percentage: "85.50 %", categoryId: 70, cmid: 3001, hidden: false },
        // Mismo nombre que 9001, otro ítem de Moodle.
        { externalItemId: "9002", label: "Tarea 1", type: "mod", value: tarea2, text: tarea2 === null ? "-" : tarea2.toFixed(2), min: 0, max: 100, percentage: null, categoryId: 71, cmid: 3002, hidden: false },
        { externalItemId: "9003", label: "Examen parcial 1", type: "mod", value: null, text: "-", min: 0, max: 10, percentage: "-", categoryId: 70, cmid: 3003, hidden: false },
        // Total del curso: sin nombre.
        { externalItemId: "9006", label: null, type: "course", value: 78.25, text: "78.25", min: 0, max: 100, percentage: "78.25 %", categoryId: null, cmid: null, hidden: false },
      ],
    },
    {
      externalId: "502",
      subject: MATERIA_B,
      items: [
        { externalItemId: "9101", label: "Proyecto final", type: "mod", value: 95, text: "95.00", min: 0, max: 100, percentage: "95.00 %", categoryId: 80, cmid: 3101, hidden: false },
      ],
    },
  ];
}

function payload({ runId = crypto.randomUUID(), capturedAt, email = EMAIL, tarea2 } = {}) {
  return {
    run_id: runId,
    captured_at: capturedAt ?? new Date().toISOString(),
    source: "ivirtual",
    user: { email },
    courses: cursos({ tarea2 }),
  };
}

// Textos que nunca deben aparecer en logs.
const SENSIBLES = [EMAIL, OTRO_EMAIL, MATERIA_A, MATERIA_B, "Tarea 1", "Proyecto final", "85.5", "78.25", "95.00", API_KEY, OTRA_API_KEY];

module.exports = { API_KEY, OTRA_API_KEY, EMAIL, OTRO_EMAIL, MATERIA_A, payload, SENSIBLES };
