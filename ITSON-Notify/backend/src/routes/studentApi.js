// ITN-53 - /api: lo que el frontend lee del alumno con sesión de Google. Todo se
// filtra por req.student.userId, nunca por un id que mande el cliente. Un fallo
// llega al manejador de errores de app.js: respuesta genérica, sin err.message, y
// el log solo lleva el código.
const express = require("express");
const { createSessionReader, requireStudentSession } = require("../middleware/studentSession");
const { parseNotificationId, parseCourseId } = require("../models/studentApi");
const { createStudentRepository } = require("../repositories/studentRepository");
const { listStudentNotifications } = require("../services/studentNotifications");
const { listStudentCourses, listStudentCourseItems } = require("../services/studentCourses");
const { studentCredentialsRouter } = require("./studentCredentials");
const { itsonProfileRouter } = require("./itsonProfile");
const { createCoursesService, CoursesError } = require("../services/classroomCourses");

const ITSON_STATUS_ERROR = "needs_relink";

// ITN-51 - Todos los métodos que cambian estado exigen el Origin exacto.
const METODOS_CON_ESCRITURA = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function studentApiRouter({
  config, supabase, now = Date.now, logger, credentialCrypto, exchangeToken, linkLimiter, itsonProfileLimiter, classroomFetch,
}) {
  const router = express.Router();
  const frontendOrigin = new URL(config.frontendUrl || "http://localhost:5173").origin;
  const repo = createStudentRepository(supabase);
  const listCourses = createCoursesService({ config, supabase, fetchImpl: classroomFetch });
  const nowIso = () => new Date(now()).toISOString();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // Igual que DELETE /auth/google/session: una escritura sin el Origin exacto no
  // pasa. Va antes de la sesión y antes de parsear cualquier body.
  router.use((req, res, next) => {
    if (METODOS_CON_ESCRITURA.has(req.method) && req.get("origin") !== frontendOrigin) {
      return res.status(403).json({ error: "origen_no_permitido" });
    }
    return next();
  });

  router.use(requireStudentSession({
    readSession: createSessionReader({ secret: config.googleAuthSecret, supabase, now }),
  }));

  router.get('/classroom/courses', async (req, res) => {
    try {
      return res.json(await listCourses(req.student));
    } catch (error) {
      if (error instanceof CoursesError) return res.status(error.status).json({ error: error.code });
      throw error;
    }
  });

  router.get("/me", async (req, res) => {
    const { userId, googleId } = req.student;
    const profile = await repo.getProfile(userId);
    if (!profile) return res.status(401).json({ error: "no_autenticado" });
    return res.json({
      email: profile.email,
      classroomConnected: profile.googleId === googleId,
      // Sin registro no hay nada que reparar: se muestra como ok.
      itsonStatus: profile.credentialStatuses.includes(ITSON_STATUS_ERROR) ? "error" : "ok",
    });
  });

  // ITN-57 - Materias del alumno (iVirtual, Classroom e ITSON API) y sus
  // actividades o tareas por materia.
  router.get("/courses", async (req, res) => {
    return res.json(await listStudentCourses(req.student.userId, repo));
  });

  router.get("/courses/:id/items", async (req, res) => {
    const id = parseCourseId(req.params.id);
    if (!id) return res.status(400).json({ error: "id_invalido" });
    const resultado = await listStudentCourseItems(req.student.userId, id, repo);
    if (!resultado) return res.status(404).json({ error: "no_encontrado" });
    return res.json(resultado);
  });

  router.get("/notifications", async (req, res) => {
    res.json(await listStudentNotifications(req.student.userId, repo));
  });

  router.post("/notifications/read-all", async (req, res) => {
    await repo.markAllRead(req.student.userId, nowIso());
    res.sendStatus(204);
  });

  router.post("/notifications/:id/read", async (req, res) => {
    const id = parseNotificationId(req.params.id);
    if (!id) return res.status(400).json({ error: "id_invalido" });
    const found = await repo.markRead(req.student.userId, id, nowIso());
    if (!found) return res.status(404).json({ error: "no_encontrado" });
    return res.sendStatus(204);
  });

  // ITN-51 - Vinculación de iVirtual. Hereda Origin y sesión de arriba; el router
  // parsea su propio body (8 KB).
  router.use(
    "/credentials",
    studentCredentialsRouter({ supabase, logger, now, credentialCrypto, exchangeToken, limiter: linkLimiter }),
  );

  // ITN-55 - Matrícula y carrera para la API REST de ITSON. Hereda Origin y sesión
  // de arriba; el router parsea su propio body (4 KB).
  router.use(
    "/itson-profile",
    itsonProfileRouter({ supabase, logger, now, credentialCrypto, limiter: itsonProfileLimiter }),
  );

  return router;
}

module.exports = { studentApiRouter };
