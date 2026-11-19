// ITN-60 - POST /internal/calendar-events
// Recibe del worker el calendario académico público de ITSON y lo guarda con upsert
// por external_id, en un solo lote (todo o nada). Correrlo dos veces con los mismos
// eventos no crea filas ni cambia updated_at. Hereda de app.js la llave
// INTERNAL_API_KEY y el límite de 1 MB del body. Responde solo conteos.
const express = require("express");
const { parseCalendarEventsPayload } = require("../models/calendarEvent");
const { createCalendarRepository, esTablaFaltante } = require("../repositories/calendarRepository");

function calendarInternalRouter({ supabase, logger, now }) {
  const router = express.Router();
  const repo = createCalendarRepository(supabase);

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.post("/", async (req, res) => {
    const parsed = parseCalendarEventsPayload(req.body);
    if (!parsed.success) {
      logger.warn("calendario_rechazado", { issues: parsed.issues.length });
      return res.status(400).json({ error: "payload_invalido", issues: parsed.issues });
    }
    try {
      const r = await repo.upsertEvents(parsed.data, new Date(now()).toISOString());
      logger.info("calendario_guardado", { received: parsed.data.length, ...r });
      return res.json({ received: parsed.data.length, ...r });
    } catch (error) {
      if (esTablaFaltante(error)) return res.status(503).json({ error: "calendario_migracion_requerida" });
      logger.error("calendario_no_guardado", { step: error.step ?? null, error_code: error.code ?? null });
      return res.status(500).json({ error: "error_interno" });
    }
  });

  return router;
}

module.exports = { calendarInternalRouter };
