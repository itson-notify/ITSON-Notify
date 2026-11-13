// ITN-55 - GET /internal/itson-profiles/active, detrás de requireApiKey como el
// resto de /internal. Dice al worker a quién consultar en la API REST de ITSON y
// con qué matrícula y carrera.
//
// Mínimo privilegio (decisión de ITN-51): el worker solo lee. Guardar y borrar los
// hace el alumno en /api/itson-profile; aquí no hay PUT, POST ni DELETE. La matrícula
// descifrada solo sale en la respuesta 200; el log lleva conteos, nunca correos,
// matrículas ni carreras. Riesgo residual documentado en backend/README.md: quien
// tenga INTERNAL_API_KEY puede leer todas las matrículas.
const express = require("express");
const { createItsonProfileRepository } = require("../repositories/itsonProfileRepository");
const { createItsonProfileService } = require("../services/itsonProfileService");

function itsonProfilesInternalRouter({ supabase, logger, now, credentialCrypto }) {
  const router = express.Router();
  const service = createItsonProfileService({
    repo: createItsonProfileRepository(supabase),
    crypto: credentialCrypto,
    now,
  });

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/active", async (req, res) => {
    let lista;
    try {
      lista = await service.listForWorker();
    } catch (error) {
      logger.error("perfiles_itson_no_listados", { step: error.step ?? null, error_code: error.code ?? null });
      return res.status(500).json({ error: "error_interno" });
    }
    const { students, undecryptable } = lista;
    if (undecryptable > 0) {
      // Si no se pudo descifrar ninguno, lo más probable es la llave: no se responde
      // una lista vacía que el worker tomaría como "nadie que consultar".
      logger.error("perfil_itson_no_descifrable", { count: undecryptable });
      if (students.length === 0) return res.status(500).json({ error: "error_interno" });
    }
    logger.info("perfiles_itson_listados", { count: students.length, failed: undecryptable });
    return res.json({ students });
  });

  return router;
}

module.exports = { itsonProfilesInternalRouter };
