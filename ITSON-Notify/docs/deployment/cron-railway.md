# Cron del RPA en Railway (ITN-25)

El worker (`automation/`) corre como un servicio **separado** del backend, llamado `worker-rpa`. Railway lo
arranca según un horario, el worker hace una extracción por la API de Moodle de iVirtual y termina. Entre
corridas no hay contenedor encendido, así que tampoco hay consumo.

Desde ITN-52 la corrida es **multi-alumno**: el worker pide al backend las cuentas de iVirtual activas
(`GET /internal/credentials/active`), y por cada una, en secuencia y con una pausa de 2 s, pide su token
(`POST /internal/credentials/get`), extrae y entrega con el correo de esa cuenta. Ya no usa `Id_User`, `P_User`
ni `ALUMNO_EMAIL`.

| Pieza | Archivo |
|-------|---------|
| Servicio, horario y política de reinicio | [`.railway/railway.ts`](../../../.railway/railway.ts) (raíz del repo) |
| Punto de entrada del cron | [`automation/schedulers/extraccion-cron.js`](../../automation/schedulers/extraccion-cron.js) |
| Entrega al backend (ITN-27) | [`automation/schedulers/entrega-backend.js`](../../automation/schedulers/entrega-backend.js) |
| Cuentas activas y tokens (ITN-52) | [`automation/schedulers/credenciales-backend.js`](../../automation/schedulers/credenciales-backend.js) |
| Alertas de fallos por Telegram (ITN-39) | [`automation/monitors/alertas.js`](../../automation/monitors/alertas.js) |
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
| 0 | Todas las cuentas bien, sin cuentas activas, solo tokens rechazados de alumnos, o `RPA_PAUSADO=true` | Nada. Un token rechazado solo se cuenta en el log final. |
| 1 | Al menos una cuenta con falla de iVirtual (red, 5xx, error de Moodle) o del backend (`get` con 5xx, entrega fallida, `needs-relink` fallido) | **Una** alerta por corrida con los conteos. Las demás cuentas se procesan igual. |
| 1 | Backend inalcanzable al listar las cuentas, o `401` en `get` | La corrida se cancela con **una** alerta. |
| 1 | Tokens rechazados en bloque (3 o más cuentas procesadas y todas con `invalidtoken`) | No se marca ninguna; **una** alerta. |
| 1 | Falta configuración o excepción no controlada | Se registra `ALERTA_RPA` y se manda alerta. |

**Tokens rechazados.** Solo el errorcode `invalidtoken` cuenta como token rechazado. Al final de la corrida el
worker llama a `POST /internal/credentials/needs-relink` con `reason: "credenciales"`: la cuenta pasa a
`needs_relink`, deja de salir en `/active` y no se vuelve a consultar hasta que el alumno vincule de nuevo desde
Ajustes. No se alerta al equipo, porque es normal y solo el alumno lo puede arreglar. `nopermissions`,
`accessexception`, un servicio deshabilitado o cualquier otro error **no** invalidan la cuenta: cuentan como falla
de iVirtual.

**Rechazo en bloque.** Si todas las cuentas procesadas (3 o más) devuelven `invalidtoken`, lo probable es un
cambio en iVirtual y no en los alumnos. El worker no marca ninguna, alerta "tokens rechazados en bloque" y sale
con 1. Revisa iVirtual antes de la siguiente corrida; si el problema sigue, pon `RPA_PAUSADO=true`.

**Cuentas omitidas.** Un `get` con 404 (el alumno desvinculó durante la corrida) o 409 (ya está en
`needs_relink`) se omite en silencio.

Un fallo que persiste alerta en **cada** corrida, pero a lo más una vez por corrida: el worker no guarda estado
para deduplicar. Para detener los avisos, pon `RPA_PAUSADO=true`. La tabla con cada texto está en
[`telegram-alertas.md`](../telegram-alertas.md#7-qué-fallos-del-rpa-alertan).

El servicio usa `restartPolicyType: "NEVER"`, así que **ningún** código distinto de 0 provoca reintentos: la
corrida queda marcada como fallida en Railway y espera al siguiente horario. Los logs solo traen conteos, la
posición de la cuenta (`cuenta 2/5`), status HTTP y errorcode: nunca calificaciones, correo, usuario, contraseña
ni token. Al terminar se loguea una línea `Corrida terminada: cuentas=... procesadas=... token_invalido=...`.

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

5. En el dashboard, en **worker-rpa → Variables**, captura `INTERNAL_API_KEY` (márcala como *sealed*),
   `BACKEND_URL` y `RPA_PAUSADO=false`. `INTERNAL_API_KEY` debe ser la misma que la del backend. Desde ITN-52
   `Id_User`, `P_User` y `ALUMNO_EMAIL` ya no se usan: bórralas del servicio. **Nunca** pongas `SUPABASE_SERVICE_ROLE_KEY` ni `CREDENTIALS_ENCRYPTION_KEY` en este servicio.
   Para recibir alertas, captura también `TELEGRAM_BOT_TOKEN` (*sealed*) y `TELEGRAM_CHAT_ID`
   ([`telegram-alertas.md`](../telegram-alertas.md)); sin ellas los fallos solo quedan en los logs.
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
worker toma `courses` tal cual sale de `extractGradesWithToken()` y agrega `run_id`, `captured_at`, `source` y
`user.email`, que desde ITN-52 es el correo de cada cuenta (viene de `/internal/credentials/active`).

| Variable | Uso |
|----------|-----|
| `BACKEND_URL` | URL base del backend, sin la ruta (p. ej. la URL privada de Railway) |
| `INTERNAL_API_KEY` | La misma llave que el backend, mínimo 32 caracteres |

Las dos son obligatorias. Si falta alguna o es inválida, el cron sale con 1 **antes** de consultar al backend y
el log nombra la variable, nunca su valor.

- **run_id:** un UUID por entrega (una por alumno). Los reintentos reusan el mismo; el backend es idempotente
  por `run_id`.
- **Timeout:** 30 s por intento.
- **Reintentos:** hasta 3 (4 intentos en total) con espera de 1, 2 y 4 s, solo ante error de red, timeout o
  `5xx`. `400`, `401`, `409` y `413` no se reintentan.
- **Fallo:** el log lleva `run_id`, status e intento. La entrega ya no alerta por su cuenta: el cron cuenta las
  entregas fallidas y manda una sola alerta por corrida; el proceso sale con 1.
- **Éxito:** el log lleva `run_id`, `baseline` y `changes_detected`.
- **Sin cursos:** si la extracción no trae cursos no se envía nada (el backend rechaza `courses` vacío) y sale
  con 0.

Nunca se loguea ni se manda en alertas el body, las calificaciones, el correo, la URL ni la llave.

### Probar contra el backend local

1. En `ITSON-Notify/.env` llena `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` del proyecto de **dev**,
   `INTERNAL_API_KEY` (32+ caracteres, p. ej. `openssl rand -hex 32`) y `BACKEND_URL=http://localhost:3000`.
   Vincula al menos una cuenta de iVirtual desde Ajustes del frontend: el cron solo consulta cuentas activas.
2. Copia esas variables al backend (`backend/.env`, ver `backend/README.md`) y arráncalo con `npm run dev`.
3. Corre el cron una vez desde la raíz de `ITSON-Notify/`: `npm run cron:extraccion`.
4. Debe salir con 0 y loguear `Entrega al backend correcta: run_id=... baseline=true` la primera vez
   (`baseline=false` en las siguientes).
5. Para probar el fallo, detén el backend y vuelve a correr el cron: no podrá leer las cuentas activas y saldrá
   con 1.

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
