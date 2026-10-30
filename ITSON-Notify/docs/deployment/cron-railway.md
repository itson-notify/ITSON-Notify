# Cron del RPA en Railway (ITN-25)

El worker (`automation/`) corre como un servicio **separado** del backend, llamado `worker-rpa`. Railway lo
arranca según un horario, el worker hace una extracción por la API de Moodle de iVirtual y termina. Entre
corridas no hay contenedor encendido, así que tampoco hay consumo.

| Pieza | Archivo |
|-------|---------|
| Servicio, horario y política de reinicio | [`.railway/railway.ts`](../../../.railway/railway.ts) (raíz del repo) |
| Punto de entrada del cron | [`automation/schedulers/extraccion-cron.js`](../../automation/schedulers/extraccion-cron.js) |
| Entrega al backend (ITN-27) | [`automation/schedulers/entrega-backend.js`](../../automation/schedulers/entrega-backend.js) |
| Enganche de alertas (Telegram en ITN-38/39) | [`automation/monitors/alertas.js`](../../automation/monitors/alertas.js) |
| Nombres de variables | [`.env.example`](../../.env.example) |

> **Por qué no `railway.json`:** Railway deprecó Config as Code (`railway.json` / `railway.toml`). Los
> servicios nuevos ya no pueden usarlo y Railway deja de leerlo el **2026-12-01**. Su reemplazo es
> Infrastructure as Code (`.railway/railway.ts`), que se aplica con el CLI y no durante el deploy.

## Horario

Por defecto: `0 0-6/2,14-22/2 * * *`, es decir, cada 2 horas de 07:00 a 23:00 hora de Hermosillo (9 corridas al
día). Railway evalúa el cron en **UTC** y Sonora está en UTC-7 todo el año. De noche no corre porque las
calificaciones casi no cambian a esa hora, y así se reducen las consultas a iVirtual.

Para cambiarlo, edita el valor por defecto en `railway.ts` o exporta `ITN_CRON_SCHEDULE` al hacer el plan:

```bash
ITN_CRON_SCHEDULE="0 * * * *" railway config plan
```

Reglas de Railway: al menos 5 minutos entre corridas, la hora exacta puede variar unos minutos, y si la corrida
anterior sigue activa se salta la siguiente.

## Códigos de salida

| Código | Significado | Qué pasa |
|--------|-------------|----------|
| 0 | Extracción correcta, o `RPA_PAUSADO=true` | Nada. |
| 1 | Error pasajero (red, 5xx, Moodle) o falta configuración | Se registra. La siguiente corrida lo vuelve a intentar. |
| 1 | Entrega al backend fallida tras los reintentos | Se registra con `run_id` y se manda alerta al equipo por Telegram. |
| 1 | Credenciales rechazadas | Se registra `ALERTA_RPA` y se llama al enganche de alertas. |
| 2 | iVirtual pide **cambio de contraseña** | Se registra `ALERTA_RPA` y se llama al enganche de alertas. |

El servicio usa `restartPolicyType: "NEVER"`, así que **ningún** código distinto de 0 provoca reintentos: la
corrida queda marcada como fallida en Railway y espera al siguiente horario. Los logs solo traen conteos, nunca
calificaciones, usuario, contraseña ni token.

El código 2 sale cuando `login/token.php` responde `forcepasswordchangenotice` o `passwordisexpired`. Esos
errorcodes salen del código fuente de Moodle; todavía no se han visto en iVirtual.

**Si llega una alerta de cambio de contraseña o credenciales:**

1. En Railway, en el servicio `worker-rpa`, pon `RPA_PAUSADO=true`. Así las siguientes corridas no suman
   intentos fallidos a la cuenta.
2. Cambia la contraseña en el portal de iVirtual.
3. Actualiza `P_User` en las Variables del servicio y regresa `RPA_PAUSADO=false`.
4. Opcional: lanza una corrida a mano con `railway cron run` para confirmar.

## Despliegue (pasos manuales)

Requisitos: CLI de Railway 5.42.1 o más nuevo y Node 22 o más nuevo (lo pide el SDK `railway`).

1. Instala el SDK que usa el CLI para leer `railway.ts`, desde la raíz del repo:

   ```bash
   npm --prefix .railway install
   ```

2. Inicia sesión y vincula el proyecto y el ambiente (`production`):

   ```bash
   railway login
   railway link
   ```

3. Revisa el plan. Debe decir `+ Create service worker-rpa` y nada más:

   ```bash
   railway config plan
   ```

4. Aplica después de revisar el plan:

   ```bash
   railway config apply
   ```

5. En el dashboard, en **worker-rpa → Variables**, captura `Id_User`, `P_User` e `INTERNAL_API_KEY` (márcalas
   como *sealed*), `BACKEND_URL`, `ALUMNO_EMAIL` y `RPA_PAUSADO=false`. `INTERNAL_API_KEY` debe ser la misma
   que la del backend. **Nunca** pongas `SUPABASE_SERVICE_ROLE_KEY` en este servicio.
6. Si Railway pide conectar el repo, autoriza la Railway GitHub App para `itson-notify/ITSON-Notify`.
7. Prueba una corrida y revisa los logs:

   ```bash
   railway cron run
   railway cron list
   ```

Si un `railway config plan` posterior marca como destructivo el borrado de variables, **no lo apliques**:
declara esas variables en `railway.ts` con `preserve()` para que el valor siga viviendo solo en Railway.

Notas de build: el servicio usa `automation/` como directorio raíz, con `node` ≥ 20 según `engines`. El paquete
`playwright` 1.63 no descarga navegadores al instalarse, así que la imagen queda ligera. El respaldo con
Playwright (`fallback.js`) **no** se usa en el cron.

## Entrega al backend

Después de una extracción correcta, el worker manda `POST ${BACKEND_URL}/internal/grade-snapshots` con
`x-api-key: INTERNAL_API_KEY`. El contrato del body está en [`backend/README.md`](../../backend/README.md): el
worker toma `courses` tal cual sale de `extractGrades()` y agrega `run_id`, `captured_at`, `source` y
`user.email` (`ALUMNO_EMAIL`).

| Variable | Uso |
|----------|-----|
| `BACKEND_URL` | URL base del backend, sin la ruta (p. ej. la URL privada de Railway) |
| `INTERNAL_API_KEY` | La misma llave que el backend, mínimo 32 caracteres |
| `ALUMNO_EMAIL` | Correo del alumno. Nunca la matrícula |

Las tres son obligatorias. Si falta alguna o es inválida, el cron sale con 1 **antes** de consultar iVirtual y
el log nombra la variable, nunca su valor.

- **run_id:** un UUID por corrida. Los reintentos de esa corrida reusan el mismo; el backend es idempotente
  por `run_id`.
- **Timeout:** 30 s por intento.
- **Reintentos:** hasta 3 (4 intentos en total) con espera de 1, 2 y 4 s, solo ante error de red, timeout o
  `5xx`. `400`, `401`, `409` y `413` no se reintentan.
- **Fallo:** el log lleva `run_id`, status e intento; se manda una alerta con `sendTeamAlert` (sin `run_id`,
  porque el filtro de Telegram rechaza cadenas largas) y el proceso sale con 1.
- **Éxito:** el log lleva `run_id`, `baseline` y `changes_detected`.
- **Sin cursos:** si la extracción no trae cursos no se envía nada (el backend rechaza `courses` vacío) y sale
  con 0.

Nunca se loguea ni se manda en alertas el body, las calificaciones, el correo, la URL ni la llave.

### Probar contra el backend local

1. En `ITSON-Notify/.env` llena `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` del proyecto de **dev**,
   `INTERNAL_API_KEY` (32+ caracteres, p. ej. `openssl rand -hex 32`), `BACKEND_URL=http://localhost:3000`,
   `ALUMNO_EMAIL` y las credenciales de iVirtual.
2. Copia esas variables al backend (`backend/.env`, ver `backend/README.md`) y arráncalo con `npm run dev`.
3. Corre el cron una vez desde la raíz de `ITSON-Notify/`: `npm run cron:extraccion`.
4. Debe salir con 0 y loguear `Entrega al backend correcta: run_id=... baseline=true` la primera vez
   (`baseline=false` en las siguientes).
5. Para probar el fallo, detén el backend y vuelve a correr el cron: verás 4 intentos y código de salida 1.

## Límite de gasto (usage limit)

Railway cobra por uso. Con 9 corridas cortas al día el worker gasta muy poco, pero conviene ponerle un tope al
workspace:

1. Abre **Workspace → Usage** (<https://railway.com/workspace/usage>). Si el proyecto está en un workspace de
   equipo, cámbialo con el selector de arriba a la izquierda. Necesitas ser admin.
2. Da clic en **Set Usage Limits** y, en **Compute Usage**:
   - **Custom email alert** (límite suave): por ejemplo `5`. Solo manda correo.
   - **Hard limit**: el mínimo es `10` USD. Al llegar al tope, Railway **apaga todos los servicios del
     workspace**, backend incluido, hasta que subas el límite o empiece el siguiente ciclo. Avisa por correo al
     75 %, 90 % y 100 %.
3. También se puede hacer desde el CLI:

   ```bash
   railway usage limit set --target workspace --soft 5 --hard 10
   railway usage limit status
   ```

4. Opcional: en **worker-rpa → Settings → Deploy → Replica Limits**, limita CPU y memoria (por ejemplo 0.5 vCPU
   y 512 MB). Si el límite queda muy bajo, el worker se cae.

## Pendiente

- **Backend en `railway.ts`:** el backend Express (ITN-27) todavía no está en `railway.ts` ni en un partial
  propio.
- **ITN-38/ITN-39 (Telegram):** reemplazar el log de `notificarFalloCritico` en `automation/monitors/alertas.js`
  por el envío real.
