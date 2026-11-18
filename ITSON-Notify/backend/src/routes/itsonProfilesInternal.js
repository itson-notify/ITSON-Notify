// ITN-55 - GET /internal/itson-profiles/active. Dice al worker a quién consultar
// en la API REST de ITSON y con qué matrícula y carrera.
//
// Mínimo privilegio (ITN-51): el worker solo lee. Guardar y borrar los hace el
// alumno en /api/itson-profile; aquí no hay PUT, POST ni DELETE.
//
// Credencial separada: esta ruta exige su propia llave (ITSON_PROFILES_API_KEY,
// distinta de INTERNAL_API_KEY), comparada en tiempo constante. La llave general
// del resto de /internal no puede leer matrículas, y esta llave no abre ninguna
// otra ruta interna. La matrícula descifrada solo sale en la respuesta 200; el
// log lleva conteos, nunca correos, matrículas, carreras ni llaves.
const express = require("express");
const { requireApiKey, sameApiKey } = require("../middleware/apiKey");
const { MIN_API_KEY_LENGTH } = require("../config/env");
const { createItsonProfileRepository } = require("../repositories/itsonProfileRepository");
const { createItsonProfileService } = require("../services/itsonProfileService");

function requireItsonProfilesKey(apiKey, internalApiKey) {
  if (apiKey === undefined || apiKey === null || apiKey === "") {
    return (req, res) => res.status(401).json({ error: "no_autorizado" });
  }
  if (typeof apiKey !== "string" || apiKey.length < MIN_API_KEY_LENGTH) {
    throw new Error(`itsonProfilesInternalRouter requiere una llave de al menos ${MIN_API_KEY_LENGTH} caracteres`);
  }
  if (internalApiKey && sameApiKey(apiKey, internalApiKey)) {
    throw new Error("itsonProfilesInternalRouter requiere una llave distinta de internalApiKey");
  }
  return requireApiKey(apiKey);
}

function itsonProfilesInternalRouter({ supabase, logger, now, credentialCrypto, apiKey, internalApiKey }) {
  const router = express.Router();
  const checkKey = requireItsonProfilesKey(apiKey, internalApiKey);
  const service = createItsonProfileService({
    repo: createItsonProfileRepository(supabase),
    crypto: credentialCrypto,
    now,
  });

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.use(checkKey);

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

  router.use((req, res) => {
    res.status(404).json({ error: "no_encontrado" });
  });

  return router;
}

module.exports = { itsonProfilesInternalRouter };
