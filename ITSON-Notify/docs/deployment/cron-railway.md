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
anterior sigue activa se salta la siguiente
([Railway: Cron Jobs](https://docs.railway.com/cron-jobs#service-execution-requirements); en
`railway cron list` aparece como omitida porque la anterior seguía en curso).

### Intervalo de prueba y latencia (ITN-56)

Para el ensayo y la prueba con el profesor se propone correr **cada 5 minutos**, el mínimo que permite Railway.
Primero revisa el plan; **no** lo apliques hasta decidirlo:

```bash
ITN_CRON_SCHEDULE="*/5 * * * *" railway config plan
```

Para volver al horario normal después de la demo, corre `railway config plan` sin la variable (usa
`0 0-6/2,14-22/2 * * *`) y aplícalo.

**Duración de una corrida.** Cada corrida ejecuta las dos fases en secuencia: iVirtual y después la API de ITSON.
Si una corrida tarda más que el intervalo, Railway **se salta** la siguiente: no se acumulan, pero la latencia
crece en un intervalo. Lo que suma cada fase, según el código (son cotas, no mediciones):

| Paso | Normal | Peor caso por llamada |
|------|--------|-----------------------|
| iVirtual, por cuenta | pausa de 2 s + `get` del token + 2 llamadas fijas + 1 por curso + 1 de tareas (ITN-56) + 1 entrega | Moodle: 15 s × 3 intentos + 1.5 s de espera ≈ 46.5 s; entrega: 30 s × 4 + 7 s ≈ 127 s |
| API de ITSON, por alumno | pausa de 2 s + `getAlumnoInscrito` + `getProgress` + hasta 3 `getGrades` + 1 entrega por semestre | 15 s × 3 intentos por llamada; entrega igual que arriba |

Con las pocas cuentas de la demo, una corrida normal debería durar segundos, muy por debajo de 5 minutos; solo
con iVirtual o el backend caídos (timeouts y reintentos) podría pasar del intervalo. **Hay que medirlo:** en
Railway, **worker-rpa → Deployments** (o `railway cron list`) muestra la hora de inicio y fin de cada corrida.
Anota la duración de varias corridas antes del ensayo:

| Corrida | Inicio (UTC) | Fin (UTC) | Duración | Cuentas iVirtual | Alumnos API |
|---------|--------------|-----------|----------|------------------|-------------|
| _por medir_ | | | | | |

**Latencia del aviso.** Es el tiempo desde que el profesor crea la tarea en iVirtual hasta que llega el aviso:

- **Peor caso** = intervalo del cron + duración de la extracción (hasta que se entrega el snapshot de esa
  cuenta) + entrega y notificación en el backend (incluye Resend y Web Push).
- Con `*/5`: peor caso ≈ 5 min + extracción + entrega. Si la corrida anterior todavía estaba activa cuando tocaba
  la siguiente, suma otro intervalo.
- En promedio, la tarea se crea a la mitad de un intervalo: ≈ 2.5 min + extracción + entrega.

Cómo medirla en el ensayo:

1. Anota la hora exacta en que se crea la tarea en iVirtual (o usa `timecreated`/`timemodified` de la tarea si
   la ves en Moodle).
2. En el SQL Editor del proyecto, toma el snapshot que la detectó y el envío de cada canal:

   ```sql
   -- Avisos de tarea nueva más recientes, con su snapshot y su envío por canal.
   select s.captured_at, gc.detected_at, n.channel, n.status, n.created_at, n.sent_at,
          n.sent_at - s.captured_at as captura_a_envio
   from notifications_log n
   join grade_changes gc on gc.id = n.grade_change_id
   join grade_snapshots s on s.id = gc.current_snapshot_id
   where n.payload->>'subject' = 'ITSON Notify: nueva tarea'
   order by n.created_at desc
   limit 10;
   ```

3. Compara con la hora de recepción del correo (encabezado `Date` del mensaje) y con la hora en que aparece la
   notificación Push en el dispositivo.
4. Latencia total = hora del correo o del Push − hora de creación de la tarea. El tramo `captured_at → sent_at`
   es lo que tarda el sistema una vez que la corrida ya pasó por esa cuenta.

| Medición | Creación de la tarea | `captured_at` | `sent_at` (email) | Correo recibido | Push recibido | Latencia total |
|----------|----------------------|---------------|-------------------|-----------------|---------------|----------------|
| _por medir_ | | | | | | |

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

### Fase de la API REST de ITSON (ITN-55)

Después de la fase de iVirtual, el mismo proceso corre la de la API REST de ITSON
(`automation/schedulers/itson-api-fase.js`). Son independientes: cada una tiene su propio try/catch, sus conteos y
a lo más **una** alerta, así que una corrida puede mandar hasta dos. La de la API corre aunque no haya cuentas de
iVirtual, y el código de salida es 1 si cualquiera de las dos sale con 1.

| Código | Significado de la fase de la API |
|--------|----------------------------------|
| 0 | Sin fallas, sin perfiles, sin `ITSON_API_BASE_URL` (fase deshabilitada) o `RPA_PAUSADO=true` |
| 1 | Al menos una llamada o entrega fallida (alerta `api_itson_con_fallas` con conteos), `ITSON_API_BASE_URL` inválida o el backend no entrega la lista de perfiles |

Por alumno de `GET /internal/itson-profiles/active`: `getAlumnoInscrito`, `getProgress` y `getGrades`. Con las
fechas de `getAlumnoInscrito` (ISO sin zona, en hora de Hermosillo) se arma una **ventana**: se consulta desde
`ITSON_API_VENTANA_ANTES_DIAS` días antes de `fechaInicioSemestre` hasta `ITSON_API_VENTANA_DESPUES_DIAS` días
después de `fechaFinSemestre`, inclusive, porque las calificaciones finales suelen publicarse al cierre o después.
Fuera de la ventana el alumno se omite (`fuera_de_ventana`). `inscrito` no decide: con `false`, dentro de la
ventana se consulta igual. Si las fechas no se pueden leer, se consulta y se cuenta en `fechas_ilegibles` (no es
falla). Si `getAlumnoInscrito` falla, se consulta y se cuenta en `inscripcion_fallida` (sí es falla). Después,
`getGrades` para los semestres distintos de `"0"` con materias pendientes,
máximo 3. Una respuesta con `subject.program` distinto de la carrera guardada se descarta (`forma_invalida`). Un
semestre sin materias no se envía. Cada alumno va en su propio try/catch. Al terminar se loguea
`Fase API de ITSON terminada: alumnos=... entregadas=... fallas_api=...`. Los logs nunca llevan correo, matrícula,
carrera, materias, calificaciones ni la URL de la API.

**Destino restringido.** La matrícula viaja en la query, así que `ITSON_API_BASE_URL` solo puede apuntar a un
host de la lista cerrada `HOSTS_PERMITIDOS` de `automation/services/itsonApiClient.js`, hoy únicamente
`webapi.itson.edu.mx`. Agregar otro es un cambio de código revisado, no de configuración. Se rechazan `http://`,
cualquier otro host (incluido un subdominio parecido como `webapi.itson.edu.mx.otro.dominio`), el host con punto
final (`webapi.itson.edu.mx.`), usuario o contraseña en la URL, un puerto distinto de 443, y cualquier ruta, query
o fragmento. Las mayúsculas se aceptan porque el host se normaliza a minúsculas. Con un valor rechazado la fase no
corre: código 1 y alerta de configuración, con un mensaje que nunca cita la URL ni sus partes. El cliente repite
la validación al crearse, así que ninguna petición sale a otro host.

**Sin redirecciones.** Las llamadas usan `redirect: "manual"`: cualquier respuesta 3xx (301, 302, 303, 307, 308),
en GET o POST, cuenta como falla de la llamada (`motivo=redireccion`, en `fallas_api` o `inscripcion_fallida`) y no
se reintenta. El `Location` no se sigue, no se lee y no se registra.

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
   ITN-55: para habilitar la fase de la API de ITSON, captura `ITSON_API_BASE_URL=https://webapi.itson.edu.mx`
   (solo ese origen: otro host, `http`, credenciales, puerto o ruta cancelan la fase; el worker agrega
   `/api/getGrades` y demás). Sin ella la fase queda deshabilitada. Antes,
   aplica la migración 012 en el backend. Opcionales: `ITSON_API_VENTANA_ANTES_DIAS` (por defecto 7) e
   `ITSON_API_VENTANA_DESPUES_DIAS` (por defecto 45), enteros de 0 a 365; un valor inválido cancela la fase con
   una alerta de configuración.
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

### Correo de los avisos (servicio del backend)

Los avisos que genera cada entrega se mandan por correo **al alumno dueño** (`app_users.email`, el de su cuenta
de Google). En el servicio del **backend** en Railway (no en `worker-rpa`):

- `RESEND_API_KEY` (*sealed*) basta para activar el canal `email`. `NOTIFY_EMAIL_FROM` debe ser de un dominio
  verificado en Resend para que llegue a los alumnos.
- `NOTIFY_EMAIL_TO` es **solo un override de pruebas**: si está definida, todos los correos van a esa dirección.
  En producción **no debe existir**; bórrala del servicio para que cada alumno reciba en su correo.

Detalle en [`backend/README.md`](../../backend/README.md#variables).

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

### Ensayo sintético del aviso de tarea nueva (ITN-56)

No se puede crear antes una tarea real en el curso de prueba, así que el mismo camino se ensaya con datos
inventados. Hay dos niveles:

1. **Con fakes, sin red** (lo que corre `npm test` en `backend/`): `tests/app/ensayoTareaNueva.test.js` manda el
   snapshot A (línea base) y el B (con una tarea nueva sin nota, `text: "-"`, y con `dueAt`) por
   `POST /internal/grade-snapshots` y revisa `grade_changes`, `snapshot_grades.due_at`, `notifications_log`, el
   correo (canal de Resend con `fetch` simulado), el Push (canal real con `web-push` simulado) y
   `GET /api/notifications`. También prueba "sin fecha de entrega", la fecha omitida contra `null`, y el backend
   sin la 013.
2. **Contra el backend local y el Supabase de dev** (`itson-notify-dev`, nunca producción): con el backend
   corriendo (`npm run dev` en `backend/`):

   ```bash
   cd backend && node --env-file=.env scripts/ensayo-tarea-nueva.js
   ```

   El script solo acepta un backend en `localhost`, usa un correo inventado y único por corrida
   (`ensayo.itn56.<hora>@example.test`, así A siempre es línea base) y solo imprime status, conteos y el
   `snapshot_id` de B. Lo que se puede verificar de verdad:
   - `grade_changes` y `notifications_log` en dev (consulta de arriba, o
     `select channel, status, payload->>'text' from notifications_log order by created_at desc limit 5;`).
   - **Correo:** el backend manda cada aviso al correo del alumno (`app_users.email`). El alumno del ensayo tiene
     un correo inventado de dominio reservado (`.test`), así que **la fila `email` queda `failed` a propósito**
     ("Correo del alumno con dominio reservado") sin llamar a Resend; log y Push no se afectan. Para ver el correo
     llegar en el ensayo, define `NOTIFY_EMAIL_TO` en `backend/.env` (override solo de pruebas: todo va ahí) junto
     con `RESEND_API_KEY` (ver [`backend/README.md`](../../backend/README.md#variables): con
     `onboarding@resend.dev` solo entrega al correo de la cuenta de Resend).
   - **Push real:** el usuario inventado no tiene suscripción, así que la fila `web_push` queda `failed` (es lo
     esperado). Para ver un Push real, corre el ensayo con `ENSAYO_EMAIL` igual al correo de una cuenta del equipo
     que haya entrado a la app de dev y aceptado las notificaciones, y con `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`
     en `backend/.env`. Ojo: si esa cuenta ya tenía snapshots de iVirtual en dev, A se compara contra ellos y
     genera avisos de más.
   - **En la app:** con esa misma cuenta, la notificación aparece en `/notifications` con el título "Nueva tarea
     publicada" y la fila `Entrega`.

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

- **Latencia y duración reales (ITN-56):** llenar las tablas de "Intervalo de prueba y latencia" con las
  mediciones del ensayo.
- **Aviso por cambio de fecha de entrega (ITN-56):** hoy no se avisa; ver "Limitaciones conocidas" en
  [`backend/README.md`](../../backend/README.md).

- **Backend en `railway.ts`:** el backend Express (ITN-27) todavía no está en `railway.ts` ni en un partial
  propio.
