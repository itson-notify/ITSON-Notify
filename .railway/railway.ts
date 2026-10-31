// Infraestructura de ITSON Notify en Railway (ITN-25).
// Se aplica con el CLI de Railway: `railway config plan` y `railway config apply`.
// Railway no lee este archivo durante los despliegues. Pasos completos en
// ITSON-Notify/docs/deployment/cron-railway.md.
//
// Es un "partial" con nombre: solo administra el servicio del worker. El
// backend Express (ITN-27) se agregará como otro recurso o partial, y lo
// que no aparezca aquí no se toca.
//
// Las variables NO se declaran aquí: viven solo en Railway (Variables del
// servicio) y nunca en el repo. worker-rpa necesita:
//   Id_User, P_User           cuenta de iVirtual (sealed)
//   RPA_PAUSADO               true detiene las extracciones
//   BACKEND_URL               URL base del backend (ITN-27), obligatoria
//   INTERNAL_API_KEY          llave x-api-key, igual a la del backend (sealed)
//   ALUMNO_EMAIL              correo del alumno para user.email, obligatoria
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   alertas al equipo (opcionales)
// Si falta BACKEND_URL, INTERNAL_API_KEY o ALUMNO_EMAIL el cron sale con 1
// sin consultar iVirtual.
import { defineRailway, github, project, service } from "railway/iac";

export const partial = "worker-rpa";

// Cron en UTC. Por defecto: cada 2 horas de 07:00 a 23:00 hora de Hermosillo
// (UTC-7 todo el año, Sonora no cambia de horario), 9 corridas al día:
//   UTC 14,16,18,20,22,00,02,04,06  =  Hermosillo 07,09,...,23
// Para cambiarlo, edita el valor por defecto o exporta ITN_CRON_SCHEDULE al
// correr `railway config plan/apply`. Railway exige al menos 5 minutos entre
// corridas.
const CRON_SCHEDULE =
  globalThis.process?.env?.ITN_CRON_SCHEDULE ?? "0 0-6/2,14-22/2 * * *";

export default defineRailway(() => {
  const worker = service("worker-rpa", {
    source: github("itson-notify/ITSON-Notify", {
      branch: "main",
      rootDirectory: "ITSON-Notify/automation",
    }),
    deploy: {
      startCommand: "node schedulers/extraccion-cron.js",
      cronSchedule: CRON_SCHEDULE,
      // Sin reinicios automáticos: si la extracción sale con 1 o 2 (p. ej.
      // cambio_password) no se reintenta en bucle; espera al siguiente horario.
      restartPolicyType: "NEVER",
    },
  });

  return project("ITSON Notify", {
    resources: [worker],
  });
});
