# Backend de ITSON Notify (ITN-27)

## Consulta de cursos de Classroom (ITN-42)

`GET /api/classroom/courses` exige la cookie de sesión de Google vigente en
`google_app_sessions`. No acepta identidad del alumno por query ni body. Lee
`google_authorizations` por ambos identificadores de la sesión (`user_id` y
`google_id`), descifra con el propósito `google-refresh` de ITN-41 y obtiene un
access token temporal exclusivamente en backend. No guarda tokens ni cursos.

Respuesta: `{ "courses": [{ "id": "001", "name": "Curso", "section": "A",
"courseState": "ACTIVE" }] }`. Los dos últimos campos son opcionales. Mantiene
los IDs de Google como texto y devuelve todas las páginas mediante el cliente
de ITN-49, con `studentId=me` en cada página para excluir cursos donde solo se es
docente. No expone curso parcial si falla una página. La paginación es interna:
no acepta `pageToken` ni devuelve `nextPageToken` al consumidor.

Respuestas con `Cache-Control: no-store`: 401 sesión ausente/inválida; 409
`classroom_requiere_autorizacion` si falta autorización, falla su descifrado,
Google rechaza el refresh token con `invalid_grant` o Classroom responde 401;
403 `classroom_sin_permisos`; 502 respuesta inválida o error HTTP no recuperable;
503 configuración deshabilitada, red, timeout, 429 o fallo temporal del proveedor;
500 fallo de persistencia. No hay reintentos automáticos. Un 409 requiere volver
a autorizar; un 401 de Classroom no permite distinguir expiración de revocación.
Se conserva el consentimiento existente de solo lectura de cursos.

Pruebas con transportes externos bloqueados (HTTP local permitido a Supertest):

```sh
node --require ./tests/helpers/offlineNetwork.cjs --test
```

La implementación única de ITN-49 vive en `src/services/classroomClient.js`.
El backend puede empaquetarse solo con `backend/`: no importa `automation/`.
La entrada anterior de automation conserva un adaptador a la misma implementación.
`.railway/railway.ts` administra únicamente el worker; no garantiza el contexto
de construcción del backend. Esta integración no necesita cambiar ese contexto.
`tests/packaging/backendArtifact.test.js` copia solo `src/` y `package.json`,
resuelve las dependencias npm instaladas, arranca `src/server.js` con configuración
sintética y verifica `/health` sin red externa. También retira el cliente de esa
copia para comprobar que el arranque detecta `MODULE_NOT_FOUND`.

Servidor Express que recibe cada extracción del worker (ITN-25), la guarda en Supabase, corre el detector de
cambios de ITN-24 y notifica los cambios nuevos (ITN-28).

```bash
cd backend
npm install
cp .env.example .env   # llena los valores
npm run dev            # node --env-file=.env src/server.js
npm test               # node:test, con Supabase simulado
```

Requiere Node 22 o más nuevo (`@supabase/supabase-js` necesita WebSocket nativo). En Railway se usa `npm start` y las variables del servicio, sin archivo `.env`.

**Migraciones requeridas**, en orden, además de 001 y 002: `003_external_item_id.sql`,
`004_grade_changes_unique.sql` (llave natural de `grade_changes`), `005_service_role_grants.sql` (grants
explícitos; obligatoria en entornos creados desde el 30 de octubre de 2026), `007_student_credentials.sql`
(credenciales cifradas; sin ella, solo fallan los endpoints de credenciales), `009_push_subscriptions.sql`
(suscripciones Web Push; sin ella, `/push` falla y el logout no puede revocar el Push del dispositivo),
`010_notifications_read_at.sql` (estado de lectura; sin ella, fallan las notificaciones de `/api`),
`011_google_app_sessions_revoked_at.sql` (marca de revocación de ITN-54),
`012_student_itson_profiles.sql` (perfil ITSON cifrado y `grade_snapshots.period`, ITN-55) y
`013_snapshot_grades_fechas_tarea.sql` (fechas de entrega de las tareas de iVirtual, ITN-56).

La **013 se aplica ANTES de desplegar** el código de ITN-56. Si el código corre sin ella, `POST
/internal/grade-snapshots` recibe `42703` al escribir las fechas, guarda el snapshot sin ellas, registra
`fechas_sin_migracion` y sigue (la extracción de iVirtual no se rompe); los avisos de tarea nueva salen sin la
fecha. Es solo una red de seguridad: sin la 013 no se guarda ninguna fecha.

La **012 se aplica antes de habilitar `itson_api`** (antes de que el worker mande snapshots de la API o de que los
alumnos guarden su perfil), pero no hace falta antes de desplegar el código de ITN-55: el flujo de iVirtual no lee,
no filtra ni escribe `grade_snapshots.period`, así que funciona igual en una base sin la 012. Sin ella, solo fallan
los snapshots `itson_api` (500, sin dejar snapshot), `/api/itson-profile` y `/internal/itson-profiles/active`.

La **011 se aplica ANTES de desplegar** el código de ITN-54. Si el código corre sin ella, el logout recibe
`42703`, registra `session_revocation_column_missing` y vuelve a borrar la sesión como antes, sin marca. Ese
respaldo es solo una red de seguridad para no romper el logout: sin la marca, la mitigación de Push huérfano
de "Cierre de sesión y Web Push" no funciona.

Estado en `itson-notify-dev`: la 010 ya está aplicada (2026-11-06, registrada con el nombre anterior
`009_notifications_read_at`). La `009_push_subscriptions.sql` sigue **pendiente**: mientras tanto, el logout
recibe `42P01` al limpiar Push, lo registra como `push_cleanup_table_missing` y termina igual.

## Variables

| Variable                     | Uso                                                              |
| ---------------------------- | ---------------------------------------------------------------- |
| `PORT`                       | Puerto HTTP                                                      |
| `INTERNAL_API_KEY`           | Llave compartida con el worker (`x-api-key`), mínimo 32 caracteres |
| `SUPABASE_URL`               | URL del proyecto                                                 |
| `SUPABASE_SERVICE_ROLE_KEY`  | Llave `service_role`. **Solo en el backend**                     |
| `CREDENTIALS_ENCRYPTION_KEY` | Llave maestra de las credenciales, 32 bytes en base64. **Solo en el backend** |

Si falta alguna o es inválida, el servidor no arranca y el mensaje nombra la variable (nunca su valor).

Opcionales (notificaciones, ITN-28). Sin ellas el servidor arranca igual y solo usa el canal `log`:

| Variable            | Uso                                                                        |
| ------------------- | -------------------------------------------------------------------------- |
| `RESEND_API_KEY`    | Llave de Resend. Sin ella, el canal `email` se omite                       |
| `NOTIFY_EMAIL_TO`   | **Solo pruebas.** Override opcional: si se define, todos los correos van ahí. Vacía en producción |
| `NOTIFY_EMAIL_FROM` | Remitente. Vacío usa `ITSON Notify <onboarding@resend.dev>`                |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Llaves de Web Push (las dos o ninguna). Sin ellas, el canal `web_push` se omite |
| `VAPID_SUBJECT`     | Contacto VAPID (`mailto:`). Vacío usa `mailto:notificaciones@itson.edu.mx`  |
| `ITSON_PROFILES_API_KEY` | Credencial exclusiva para `GET /internal/itson-profiles/active` (`x-api-key`), mínimo 32 caracteres y distinta de `INTERNAL_API_KEY`. Sin ella, esa ruta responde `401` |

**Correo: va al alumno.** El canal `email` se arma solo con `RESEND_API_KEY` y manda cada aviso al correo del
alumno dueño (`app_users.email`, el de su cuenta de Google), un destinatario por correo. El backend lo lee por
`user_id` con `notificationRepository.getUserEmail` (solo la columna `email`).

- **`NOTIFY_EMAIL_TO` es solo un override de pruebas.** Si está definida, **todos** los correos van a esa
  dirección y no se consulta `app_users` (útil en local y en el ensayo sintético). En producción debe quedar
  **sin definir** para que cada alumno reciba en su correo.
- **Correos que no se envían.** Si el alumno no tiene correo, es inválido o es de un dominio reservado (`.test`,
  `.invalid`, `.localhost`, `.example`, `example.com`/`.org`/`.net`), no se llama a Resend: la fila `email` de
  `notifications_log` queda `failed` con un motivo que nunca incluye el correo, y los demás canales siguen.
  Como cualquier `failed`, se reintenta como máximo hasta `MAX_ATTEMPTS` (5) y después se deja.
- **Remitente.** Con el remitente de pruebas `onboarding@resend.dev`, Resend solo entrega al correo de la cuenta
  de Resend y responde `403` a cualquier otro destinatario
  ([Resend: error 403 del dominio resend.dev](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)),
  así que esos avisos quedan `failed`. Para que llegue a los alumnos hay que verificar un dominio propio en
  <https://resend.com/domains> y usar un `NOTIFY_EMAIL_FROM` de ese dominio. Para una demo sin dominio, define
  `NOTIFY_EMAIL_TO` con el correo de la cuenta de Resend.

**Push.** El canal `web_push` solo se arma con las dos llaves VAPID. El aviso llega solo a los dispositivos con
suscripción guardada (`push_subscriptions`, migración 009): el alumno debe entrar a la app y aceptar las
notificaciones. Sin suscripción, la fila de ese canal queda `failed` ("Usuario sin suscripciones Web Push").

Las tablas tienen RLS activado y sin políticas, así que solo la `service_role` puede leer y escribir. Por eso
el cliente de Supabase vive únicamente aquí: el worker y el frontend nunca reciben esa llave.

## Estructura

| Archivo                                      | Qué hace                                                     |
| -------------------------------------------- | ------------------------------------------------------------ |
| `src/app.js`                                 | `createApp({ config, supabase, logger })`, sin escuchar      |
| `src/server.js`                              | Lee la config, crea el cliente de Supabase y escucha         |
| `src/middleware/apiKey.js`                   | `x-api-key` con `crypto.timingSafeEqual`                     |
| `src/models/gradeSnapshotPayload.js`         | Esquema zod del body                                         |
| `src/repositories/snapshotRepository.js`     | Upserts del snapshot                                         |
| `src/repositories/gradeChangeRepository.js`  | Repo real de `detectChanges` (contrato en `src/services/README.md`) |
| `src/repositories/notificationRepository.js` | Repo real de `notifications_log` (ITN-28)                    |
| `src/services/notificationService.js`        | Agrupa cambios por ítem, envía y reintenta pendientes        |
| `src/services/notificationChannels.js`       | Canales `log` y `email` (Resend)                             |
| `src/routes/gradeSnapshots.js`               | `POST /internal/grade-snapshots`                             |
| `src/routes/credentials.js`                  | `/internal/credentials` (ITN-36): solo `get` y `needs-relink` |
| `src/routes/studentCredentials.js`           | `/api/credentials/ivirtual` (ITN-51) y límite de intentos     |
| `src/models/credentialPayload.js`            | Esquemas zod de los bodies de credenciales                   |
| `src/services/credentialCrypto.js`           | Cifrado AES-256-GCM con AAD y versiones de llave             |
| `src/services/credentialService.js`          | Cifra y guarda (por `user_id`), lee y descifra               |
| `src/services/ivirtualToken.js`              | Cliente de `login/token.php` y puerto `exchangeToken` (ITN-52) |
| `src/repositories/credentialRepository.js`   | Repo de `student_credentials` (solo datos cifrados)          |
| `src/services/itsonGradeCodes.js`            | Códigos de `gradeValue` de la API de ITSON (ITN-55)          |
| `src/models/itsonProfile.js`                 | Validación del perfil ITSON y regla del correo institucional |
| `src/repositories/itsonProfileRepository.js` | Repo de `student_itson_profiles` (matrícula cifrada)         |
| `src/services/itsonProfileService.js`        | Cifra, descifra y arma la pista de la matrícula              |
| `src/routes/itsonProfile.js`                 | `/api/itson-profile` (ITN-55)                                |
| `src/routes/itsonProfilesInternal.js`        | `GET /internal/itson-profiles/active` (ITN-55)               |
| `src/utils/logger.js`                        | Logs JSON con lista blanca de campos                         |
| `src/utils/fechaHermosillo.js`               | Fecha de entrega en hora de Hermosillo para los avisos (ITN-56) |
| `scripts/ensayo-tarea-nueva.js`              | Ensayo sintético del aviso de tarea nueva contra el backend local (ITN-56) |

## Endpoints

### `GET /health`

Sin autenticación. Responde `200 {"status":"ok"}` y no revela configuración ni estado de Supabase.

### `POST /internal/grade-snapshots`

Header `x-api-key: <INTERNAL_API_KEY>` y `Content-Type: application/json`, cuerpo de 1 MB como máximo. Sin
llave o con una llave incorrecta responde `401 {"error":"no_autorizado"}`, sin detalles. La llave se revisa
antes de leer el body.

#### Body

Es la salida de `extractGrades()` (ITN-23) cuando `status` es `"ok"`: se toma `courses` tal cual. El worker
le agrega los datos de la corrida.

```json
{
  "run_id": "2f0c3a8e-6d1b-4c55-9b0e-0d8d6a1f7c42",
  "captured_at": "2026-10-21T21:00:00.000Z",
  "source": "ivirtual",
  "user": { "email": "alumno@example.test" },
  "courses": [
    {
      "externalId": "501",
      "subject": "Materia de prueba A",
      "items": [
        {
          "externalItemId": "9001", "label": "Tarea 1", "type": "mod",
          "value": 85.5, "text": "85.50", "min": 0, "max": 100,
          "percentage": "85.50 %", "categoryId": 70, "cmid": 3001, "hidden": false
        },
        {
          "externalItemId": "9006", "label": null, "type": "course",
          "value": 78.25, "text": "78.25", "min": 0, "max": 100,
          "percentage": "78.25 %", "categoryId": null, "cmid": null, "hidden": false
        }
      ]
    }
  ]
}
```

| Campo                         | Regla                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `run_id`                      | **Obligatorio.** UUID que el worker genera una vez por corrida (`crypto.randomUUID()`). Se usa como `grade_snapshots.id`. Si se reintenta el envío de la misma corrida, debe ir el **mismo** `run_id` |
| `captured_at`                 | **Obligatorio.** ISO 8601 con zona (`Z` o `±hh:mm`). Momento de la extracción. Si está más de 5 minutos en el futuro respecto al reloj del backend, se rechaza: el snapshot previo se elige por esta fecha |
| `source`                      | Opcional: `"ivirtual"` (valor por defecto) o `"itson_api"` (ITN-55, ver abajo)           |
| `period`                      | Solo `itson_api`, obligatorio ahí: clave de semestre consultada (`"01"`..`"08"`). En iVirtual debe faltar o ser `null` |
| `user.email`                  | **Obligatorio.** Correo del alumno. Desde ITN-52 el worker manda el de cada cuenta de `/internal/credentials/active` (antes era `ALUMNO_EMAIL`). Se guarda en minúsculas. **Nunca la matrícula** |
| `courses`                     | **Obligatorio.** Al menos 1 curso y a lo más 200. Vacío se rechaza, porque haría ver como borradas todas las calificaciones |
| `courses[].externalId`        | **Obligatorio.** Id del curso en Moodle (texto o número). No se puede repetir en el body |
| `courses[].subject`           | **Obligatorio.** Nombre del curso                                                        |
| `courses[].items`             | Arreglo de hasta 2000 ítems (puede ir vacío)                                             |
| `items[].externalItemId`      | **Obligatorio** (NOT NULL en `snapshot_grades`, migración 003). Id del grade item de Moodle. No se puede repetir en el curso ni empezar con `legacy:` |
| `items[].label`               | Texto o `null` (el total del curso no tiene nombre)                                      |
| `items[].value`               | Número o `null`. Debe caber en `numeric(5,2)` (±999.99)                                  |
| `items[].text`                | Texto o `null`. `"-"` cuando no hay calificación                                         |
| `type`, `min`, `max`, `percentage`, `categoryId`, `cmid`, `hidden` | Opcionales. Se guardan en `snapshot_grades.raw_payload` |
| `items[].dueAt`, `opensAt`, `closesAt` | Opcionales, solo iVirtual (ITN-56). ISO 8601 con zona o `null`. Entrega, apertura y cierre de la tarea (columnas `due_at`, `opens_at`, `closes_at`, migración 013). **Omitida significa "desconocida"**: el backend copia la fecha del snapshot anterior del mismo ítem (o `null` si no había). **`null` significa "sin fecha"** y se guarda así. En `itson_api` se descartan |

#### `source = "itson_api"` (ITN-55)

Snapshot de un semestre de la API REST de ITSON (`getGrades`). Cada materia es un curso con **un solo ítem** cuyo
`externalItemId` es el mismo `idCatalog` que `externalId`, `value: null` y el código de `gradeValue` en `text`.

- `"-"` (sin calificación) se guarda como `null`; los demás códigos (`"0"`..`"10"`, `"A"`) se guardan tal cual,
  como texto. Un código que no cumpla `^[0-9A-Z]{1,3}$` responde 400. El tratamiento de los códigos vive solo en
  `src/services/itsonGradeCodes.js`.
- **El significado de `"A"` sigue sin confirmarse.** No se interpreta: se guarda, se compara y se muestra como el
  texto literal `"A"` (en el aviso, en `/api/notifications` y en la app), sin convertirla a número ni a otra
  palabra.
- `period` también va a `subjects.period` (columna de la 001).
- El detector compara cada snapshot con el anterior del mismo `user_id` y `source`; en `itson_api`, además del
  **mismo `period`**, así cada semestre de la API se compara solo consigo mismo. iVirtual nunca toca `period`. El
  primero de cada uno es baseline.
- `period` va a `grade_snapshots.period` solo en `itson_api`; iVirtual no manda la columna.

Los campos desconocidos se ignoran. Un body inválido responde `400`:

```json
{ "error": "cuerpo_invalido", "detalles": [{ "path": "courses.0.items.1.externalItemId", "code": "invalid_union" }] }
```

`detalles` solo trae la ruta y el código de cada problema (hasta 20), nunca el valor recibido. Un JSON mal
formado responde `400 {"error":"cuerpo_invalido"}` y un body de más de 1 MB, `413`.

#### Respuesta `200`

```json
{
  "snapshot_id": "2f0c3a8e-6d1b-4c55-9b0e-0d8d6a1f7c42",
  "snapshot_created": true,
  "courses": 2,
  "items": 5,
  "baseline": false,
  "reason": null,
  "changes_detected": 2,
  "changes_inserted": 2,
  "notified": 2,
  "failed": 0
}
```

- `snapshot_created`: `false` si el `run_id` ya existía (reenvío).
- `baseline` y `reason`: los de `detectChanges` (`primera_corrida`, `snapshot_legacy` o `null`).
- `changes_detected`: cambios calculados contra el snapshot anterior. `changes_inserted`: filas nuevas en
  `grade_changes` en esta llamada (0 en un reenvío).
- `notified` y `failed`: envíos por canal que quedaron `sent` o `failed` en esta llamada, contando los
  reintentos de pendientes. Un fallo de notificación nunca cambia el `200`.

#### Errores

| Código | Body                                   | Cuándo                                                  |
| ------ | -------------------------------------- | ------------------------------------------------------- |
| 400    | `{"error":"cuerpo_invalido", ...}`     | Body inválido                                           |
| 401    | `{"error":"no_autorizado"}`            | Sin `x-api-key` o incorrecta                            |
| 409    | `{"error":"snapshot_de_otro_usuario"}` | El `run_id` ya existe y es de otro alumno               |
| 413    | `{"error":"cuerpo_demasiado_grande"}`  | Más de 1 MB                                             |
| 500    | `{"error":"error_interno"}`            | Falló Supabase o la detección. Se puede reintentar con el mismo `run_id` |

Ninguna respuesta de error incluye mensajes de Supabase ni datos del body.

## Persistencia

Cada paso es un upsert con la llave de conflicto exacta de las migraciones:

| Orden | Tabla             | `onConflict`                                   | Origen                       |
| ----- | ----------------- | ---------------------------------------------- | ---------------------------- |
| 1     | `app_users`       | `email`                                        | 001                          |
| 2     | `subjects`        | `user_id, external_subject_id, name, period`   | 002 (`nulls not distinct`)   |
| 3     | `grade_snapshots` | `id` (= `run_id`), `ignoreDuplicates`          | llave primaria               |
| 4     | `snapshot_grades` | `snapshot_id, subject_id, external_item_id`    | 003 (`nulls not distinct`)   |

Después corre `detectChanges({ userId, currentSnapshotId }, repo)`, que inserta en `grade_changes` con
`onConflict` en `previous_snapshot_id, current_snapshot_id, subject_id, external_item_id, field_name`
(`grade_changes_natural_key`, migración 004), `ignoreDuplicates` y `.select()`.

- `period` y `partial_period` van en `null`: la extracción de iVirtual no los trae.
- `grade_snapshots.raw_payload` va en `null`: el body completo incluye el correo.
- Antes del primer upsert se consulta si el `run_id` ya existe. Si es de otro usuario, responde 409 sin
  escribir el snapshot.
- Si falla `snapshot_grades` y **esta llamada creó** el snapshot, se borra (el cascade se lleva sus
  calificaciones) para no dejar un snapshot incompleto. Si el `run_id` ya existía (reenvío), no se borra:
  destruiría una corrida que ya estaba completa.

- **Fechas de la tarea (ITN-56).** En iVirtual, antes de escribir `snapshot_grades` se leen las fechas del
  snapshot anterior del mismo alumno (el de `captured_at` más reciente menor al actual) para copiar las que
  llegan omitidas. Así una falla de `mod_assign_get_assignments` en el worker no borra fechas ya guardadas. Sin
  la 013 (`42703`) el snapshot se guarda sin columnas de fecha y se registra `fechas_sin_migracion`. Las fechas
  **no** se comparan en el detector: un cambio de fecha de entrega no genera `grade_changes` ni aviso (pendiente).

Así, enviar dos veces el mismo payload no duplica filas ni cambios.

## Notificaciones (ITN-28)

Después de `detectChanges`, en cada llamada:

1. **Reintenta pendientes** del mismo usuario: filas de `notifications_log` en `pending` o `failed`, con
   `attempts < 5` y `grade_change_id` no nulo (hasta 100 por corrida). Reenvía el `payload` guardado. Corre
   también en baseline.
2. Si `baseline` es `false`, **notifica `inserted` agrupado por `(subject_id, external_item_id)`**: un aviso por
   ítem y canal, p. ej. `"Tarea 3 en Cálculo: calificación de 8 a 9."`. El cambio de `grade_value` y
   `grade_text` de una misma nota sale en un solo mensaje; si solo cambió `grade_text`, también se notifica.
3. Cada grupo se reclama en `notifications_log` con el **`grade_change_id` menor del grupo** (unique
   `(grade_change_id, channel)` de la 002). `payload` guarda `subject`, `text` y `grade_change_ids` (todos los
   ids del grupo). Lo que ya quedó `sent` no se vuelve a enviar.

**Avisos de `itson_api` (ITN-55).** Solo se avisa cuando la calificación de una materia que ya existía pasa de
`null` a un valor o de un valor a otro. No se avisa por materia nueva (con o sin nota), materia que desaparece,
calificación que vuelve a `null` ni cambio de nombre: esos cambios quedan en `grade_changes` sin fila en
`notifications_log`. El asunto es `ITSON Notify: calificación final` y el texto
`"Calificación final: 9 en <materia>."`; el código va literal, así que `"A"` se avisa como
`"Calificación final: A en <materia>."` (de `null` a `"A"` sí avisa). El `payload` guarda `source: "itson_api"`;
`/api/notifications` lo usa para el título ("Calificación final" o "Calificación final actualizada"). Los avisos de
iVirtual no cambian y su `payload` no lleva `source`.

**Tarea nueva de iVirtual (ITN-28, ITN-56).** Un ítem nuevo (todas sus filas `created`) sin nota se avisa con el
asunto `ITSON Notify: nueva tarea` y el texto
`"Nueva tarea publicada: <actividad> en <materia>. Fecha de entrega: viernes 20 de noviembre de 2026, 23:59 (hora de Hermosillo)."`.
Moodle manda `"-"` en `gradeformatted` cuando no hay nota, así que `grade_text` `"-"` (o vacío) cuenta como sin
nota; antes salía `"calificación nueva: -"`. La fecha sale de `snapshot_grades.due_at` en hora de Hermosillo
(UTC-7 todo el año): con `null` el texto dice `"Sin fecha de entrega."`; si la fecha es desconocida (sin la 013)
queda el texto de antes, sin fecha. El `payload` de esos avisos guarda además `due_at` (ISO o `null`), y
`/api/notifications` lo muestra como la fila `Entrega` y usa el título "Nueva tarea publicada". El mismo texto
va por log, correo y Push. `itson_api` no cambia.

El nombre de la materia sale de `subjects` y el de la actividad de `snapshot_grades` (del snapshot anterior si
el ítem se borró). Si no se encuentran, el mensaje usa "Una actividad" y omite la materia. El total del curso
(`grade_label` `null`) se notifica como "Total del curso".

Todo esto corre dentro de `try/catch`: el snapshot y los cambios ya están guardados, así que un fallo de canal
o de Supabase solo se refleja en `failed` y en el log, y la fila queda `failed` (o `pending`) para la siguiente
corrida.

## Credenciales de los estudiantes (ITN-36)

Se guarda el **token** del servicio `moodle_mobile_app` de iVirtual y el **refresh token** de Classroom, no
contraseñas. `ivirtual_password` solo existe en el esquema como último recurso para el fallback de Playwright, y
la API lo rechaza.

### Flujo

1. **Captura (ITN-51, ITN-52):** el alumno, con su sesión de Google, manda usuario y contraseña a
   `PUT /api/credentials/ivirtual`. El backend los cambia por un token con `login/token.php` (puerto
   `exchangeToken`, `src/services/ivirtualToken.js`), guarda solo el token cifrado con `last_validated_at` y descarta
   la contraseña.
2. **Cifrado:** el servicio cifra el token con AES-256-GCM, con un nonce aleatorio de 12 bytes por cifrado y
   AAD `user_id:portal:kind`. Una fila copiada a otro estudiante o tipo no se puede descifrar.
3. **Almacenamiento:** `student_credentials` (migración 007) guarda `ciphertext`, `nonce`, `auth_tag` y
   `key_version`. Tiene RLS sin políticas y permisos solo para `service_role`.
4. **Uso por el worker (ITN-52):** `GET /internal/credentials/active` dice a quién consultar y
   `POST /internal/credentials/get` devuelve el token descifrado por HTTPS. Si iVirtual responde `invalidtoken`, el
   worker llama a `POST /internal/credentials/needs-relink` con `reason: "credenciales"`; la cuenta deja de salir en
   `/active` y no se reintenta hasta que el alumno vuelva a vincular.

### Endpoints

Desde ITN-51 el worker solo lee y marca: `PUT` y `DELETE` se quitaron y responden 404. Guardar y borrar los hace el
alumno en `/api/credentials/ivirtual`. Todos van detrás de `x-api-key` y responden con `Cache-Control: no-store`. El cuerpo base es:

```json
{ "user": { "email": "alumno@example.test" }, "portal": "ivirtual", "kind": "ivirtual_token" }
```

Las combinaciones válidas son `ivirtual` con `ivirtual_token` y `google_classroom` con `google_refresh_token`.

| Ruta                                      | Body extra                                 | Respuesta `200`                              |
| ----------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| `POST /internal/credentials/get`          | Ninguno                                    | `{ portal, kind, secret }`                   |
| `POST /internal/credentials/needs-relink` | `reason` opcional: `credenciales` o `cambio_password` | `{ portal, kind, status: "needs_relink" }` |

Estas rutas nunca crean estudiantes.

#### `GET /internal/itson-profiles/active` (ITN-55)

Sin body. Devuelve a quién debe consultar el worker en la API REST de ITSON:

```json
{ "students": [{ "email": "alumno@example.test", "matricula": "00000123456", "career": "INSOF" }] }
```

- **Credencial propia (`ITSON_PROFILES_API_KEY`):** exige `x-api-key: ITSON_PROFILES_API_KEY` (comparada en tiempo
  constante con `crypto.timingSafeEqual` sobre SHA-256), **distinta** de `INTERNAL_API_KEY`. La llave general
  (`INTERNAL_API_KEY`) responde `401`, y `ITSON_PROFILES_API_KEY` responde `401` en el resto de `/internal/*`. Si
  `ITSON_PROFILES_API_KEY` no está configurada, responde `401` cerrado.
- Solo lectura, siguiendo la decisión de mínimo privilegio de ITN-51: no hay `PUT`, `POST` ni `DELETE` (responden
  404). El alumno guarda y borra en `/api/itson-profile`.
- Ordenada por correo. Un perfil que no se puede descifrar se omite y se registra `perfil_itson_no_descifrable` con
  `count`; si no se descifra ninguno (llave equivocada), responde 500 en lugar de una lista vacía.
- El log `perfiles_itson_listados` lleva `count` y `failed`, nunca correos, matrículas, carreras ni llaves.
- Mismos `401` y `500` que las demás rutas internas, y `Cache-Control: no-store`.

#### `GET /internal/credentials/active?portal=ivirtual` (ITN-52)

Sin body. Devuelve a quién debe consultar el worker:

```json
{ "students": [{ "email": "alumno@example.test" }] }
```

- Solo cuentas `ivirtual` con `kind = ivirtual_token` y `status = active`. Excluye `needs_relink` y otros portales.
- Nunca devuelve secretos ni campos cifrados: lee `user_id` de `student_credentials` y el correo de `app_users`.
- Ordenada por correo. Sin cuentas activas, `{ "students": [] }`.
- `portal` es obligatorio y por ahora solo admite `ivirtual`; otro valor responde `400 cuerpo_invalido`.
- El log `credenciales_activas_listadas` lleva `portal`, `kind` y `count`, nunca los correos.
- Mismos `401` y `500` que las demás rutas internas.

| Código | Body                                 | Cuándo                                                   |
| ------ | ------------------------------------ | -------------------------------------------------------- |
| 400    | `{"error":"cuerpo_invalido", ...}`   | Body inválido. `detalles` solo trae ruta y código        |
| 401    | `{"error":"no_autorizado"}`          | Sin `x-api-key` o incorrecta                             |
| 404    | `{"error":"no_encontrado"}`          | No existe el estudiante o la credencial                  |
| 409    | `{"error":"requiere_revinculacion"}` | `get` de una cuenta en `needs_relink`. No reintentar     |
| 413    | `{"error":"cuerpo_demasiado_grande"}` | Más de 1 MB                                             |
| 500    | `{"error":"error_interno"}`          | Falló Supabase o el descifrado                           |

Si falla el descifrado no se marca `needs_relink`: una llave mal configurada marcaría a todos los estudiantes. El
log registra `credencial_no_descifrable`.

### La llave maestra

Vive solo en `CREDENTIALS_ENCRYPTION_KEY`, en las Variables del servicio backend de Railway (márcala como *sealed*).
El worker nunca la recibe ni accede a la base. Usa una distinta por entorno y guarda una copia en un gestor de
secretos: si se pierde, todos los estudiantes deben volver a vincular sus cuentas.

```bash
openssl rand -base64 32
```

El backend no arranca sin ella. **Captúrala en Railway antes de desplegar esta versión.**

### Rotar la llave

La versión de cada fila está en `key_version`, y el código ya descifra con la llave de esa versión.

1. Genera una llave nueva y agrégala como `CREDENTIALS_ENCRYPTION_KEY_V2`, con su validación y exposición no
   enumerable en `config/env.js`.
2. En `services/credentialCrypto.js`, agrégala al mapa de `credentialCryptoFromConfig` y sube `CURRENT_KEY_VERSION`
   a 2. Despliega: lo nuevo se cifra con la v2 y lo anterior se sigue leyendo con la v1.
3. Migra las filas viejas: pide volver a vincular o vuelve a cifrarlas. El script para hacerlo todavía no existe.
4. Cuando `select count(*) from student_credentials where key_version < 2` dé 0, quita la v1.

### Si la llave se compromete

Una llave filtrada junto con una copia de la base revela todos los tokens. Rotar no basta: siguen siendo válidos en
cada portal hasta revocarlos. Si lo filtrado es `INTERNAL_API_KEY`, sigue la sección
[`INTERNAL_API_KEY`](#internal_api_key-mínimo-privilegio-itn-51).

1. Invalida todas las credenciales. Desde ese momento, `get` responde 409:
   ```sql
   update student_credentials set status = 'needs_relink', updated_at = now();
   ```
2. Reemplaza `CREDENTIALS_ENCRYPTION_KEY` por una nueva y vuelve a desplegar. No reutilices la anterior.
3. Revoca lo que se pueda en el origen: los refresh tokens en Google y los tokens en iVirtual. Hay que confirmar con
   el administrador de Moodle cómo invalidarlos, porque cambiar la contraseña podría no bastar.
4. Pide a cada estudiante que vuelva a vincular su cuenta. `PUT /api/credentials/ivirtual` cifra con la llave nueva
   y reactiva la fila.

### `INTERNAL_API_KEY`: mínimo privilegio (ITN-51)

**Decisión.** Las escrituras de credenciales ya solo vienen de la sesión del alumno, así que la llave del worker
perdió `PUT` y `DELETE` de `/internal/credentials`. Se confirmó con grep que ningún worker de `automation/` los
usaba. Desde ITN-52 el worker llama a `GET /internal/credentials/active`, `POST /internal/credentials/get`,
`POST /internal/credentials/needs-relink` y `POST /internal/grade-snapshots`. El refresh token de Google lo guarda
`googleAuthService.js` directamente, sin pasar por HTTP.

**Riesgo residual.** Quien tenga la llave todavía puede:

- listar los correos de las cuentas activas con `GET /internal/credentials/active` (ITN-52),
- leer el token descifrado de cualquier estudiante con `POST /internal/credentials/get`, y
- marcar cualquier cuenta como `needs_relink`, lo que detiene sus avisos hasta que vuelva a vincular.

`INTERNAL_API_KEY` **ya no puede leer matrículas**: `GET /internal/itson-profiles/active` exige su propia credencial
separada (`ITSON_PROFILES_API_KEY`). Quien tenga `ITSON_PROFILES_API_KEY` solo puede leer esa ruta (no tokens de
iVirtual ni entregar snapshots), pero con las matrículas se pueden consultar calificaciones en la API de ITSON, que
no autentica. Si se sospecha una fuga de `ITSON_PROFILES_API_KEY`, rótale el valor en backend y `worker-rpa`
(`openssl rand -base64 48`), revisa las líneas `perfiles_itson_listados` y avisa a los alumnos.

Ya no puede plantar un token propio en la cuenta de otro ni borrar credenciales. Cifrar en la base protege contra una
fuga de la base, no contra una fuga del worker o de esta llave.

**Rotación** (de rutina o si se sospecha una fuga):

1. Genera una llave nueva de al menos 32 caracteres (`openssl rand -base64 48`).
2. Actualiza `INTERNAL_API_KEY` en el servicio del backend y en `worker-rpa` de Railway con el mismo valor, y
   despliega los dos. Mientras uno tenga la llave vieja, el worker recibe 401: hazlo fuera del horario del cron.
3. Revisa en los logs del backend las líneas `credencial_leida` y `credencial_marcada_revinculacion` del periodo
   sospechoso: llevan `user_id`, `portal` y `kind`.
4. Si hubo lecturas que no son del worker, trata esos tokens como comprometidos: márcalos `needs_relink`, revócalos
   en el portal si se puede y pide a esos alumnos que vuelvan a vincular.

## Autorización de Google Classroom (ITN-41)

### Variables

| Variable                  | Uso                                                                               |
| ------------------------- | --------------------------------------------------------------------------------- |
| `GOOGLE_AUTH_SECRET`      | Solo backend. Mínimo 32 caracteres. Debe mantenerse estable y fuera del repo      |
| `FRONTEND_URL`            | URL de retorno del frontend. Su origen autoriza CORS y los cambios de sesión      |
| `GOOGLE_COOKIE_SAME_SITE` | `lax` o `none`. `none` exige HTTPS en backend y frontend                          |
| `VITE_BACKEND_URL`        | Solo frontend. Origen del backend, sin `/auth/google`                             |

`GOOGLE_AUTH_SECRET` es distinta de `CREDENTIALS_ENCRYPTION_KEY` (ITN-36), y ambas van solo en el backend.

### Migración

`008_google_classroom_authorization.sql` crea `google_authorizations` y `google_app_sessions`. Hay que aplicarla
manualmente en dev, después de `007_student_credentials.sql` (ITN-36).

### Con OAuth desactivado

Con `GOOGLE_OAUTH_ENABLED=false`, `GET /auth/google` responde 503 (`{"error":"google_oauth_no_configurado"}`). Es lo
esperado.

## API del alumno (ITN-53)

Rutas que usa el frontend con la cookie de sesión de Google (`itn41_google_session`, con `Path=/`). Todo se filtra por el
`user_id` de la sesión, nunca por un id del cliente. Las respuestas llevan `Cache-Control: no-store` y CORS solo para el
origen exacto de `FRONTEND_URL`.

| Ruta                                   | Respuesta                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/me`                          | `{ email, classroomConnected, itsonStatus }`                                |
| `GET /api/courses`                     | `{ courses: [{ id, name, source, period, finalGrade, updatedAt }] }` (ITN-57) |
| `GET /api/courses/:id/items`           | `{ items: [{ id, label, grade, maxGrade, dueAt, kind }] }` (ITN-57)         |
| `GET /api/notifications`               | Hasta 100 notificaciones con forma `Notif`, de la más reciente a la más antigua |
| `POST /api/notifications/:id/read`     | 204. 400 `id_invalido` si no es uuid; 404 si no existe o es de otro alumno  |
| `POST /api/notifications/read-all`     | 204                                                                         |
| `GET /api/credentials/ivirtual`        | `{ available, linked, status, lastValidatedAt }` (ITN-51)                   |
| `PUT /api/credentials/ivirtual`        | Vincula iVirtual (ITN-51, ver abajo)                                        |
| `DELETE /api/credentials/ivirtual`     | 204. 404 `no_encontrado` si no había vinculación (ITN-51)                   |
| `GET /api/itson-profile`               | `{ configured, matriculaHint, career, updatedAt }` (ITN-55)                 |
| `PUT /api/itson-profile`               | Guarda matrícula y carrera (ITN-55, ver abajo)                              |
| `DELETE /api/itson-profile`            | 204. 404 `no_encontrado` si no había perfil (ITN-55)                        |

Sin sesión vigente responden 401 `{"error":"no_autenticado"}`. POST, PUT, PATCH y DELETE exigen que `Origin` sea
exactamente el del frontend; si no, responden 403 `{"error":"origen_no_permitido"}`. El Origin se revisa antes que la
sesión y antes de leer el body.

- **Origen de los datos:** `notifications_log` con `channel = 'log'`, que da una fila por aviso; `read_at` (migración
  010) indica si está leída. Materia y valores salen de `grade_changes` y `subjects`.
- **`itsonStatus`:** sale de `student_credentials` del portal `ivirtual`: `needs_relink` es `error`; `active` o sin
  registro es `ok`.
- **`type`:** siempre `calificaciones`, porque `notifications_log` solo registra cambios de calificación y no tiene
  columna de tipo.
- **No hay endpoint para marcar como no leída.** "Marcar como no leída" y "Deshacer" son locales en el frontend
  por diseño del ticket: el cambio no se guarda en el backend y, al recargar, la notificación vuelve a mostrarse como leída.

### Materias, calificaciones y tareas del alumno (ITN-57)

Permiten mostrar la situación actual del alumno aunque todavía no existan cambios notificados (la primera corrida de
cada fuente solo guarda la línea base). Siempre filtran por `req.student.userId` y llevan `Cache-Control: no-store`.

#### `GET /api/courses`

Devuelve las materias actuales del alumno combinando las tres fuentes:

```json
{
  "courses": [
    {
      "id": "uuid",
      "name": "Ingeniería de Software",
      "source": "ivirtual",
      "period": null,
      "finalGrade": "95.5",
      "updatedAt": "2026-11-16T18:00:00.000Z"
    }
  ]
}
```

- **`ivirtual`:** sale del último snapshot de `grade_snapshots` con `source = 'ivirtual'`. `finalGrade` es la nota del
  ítem de total del curso (`raw_payload.type === 'course'` o `grade_label` null), o `null` si aún no tiene calificación
  (`"-"` en Moodle). `period` es `null` y `updatedAt` es `captured_at`.
- **`itson_api`:** sale del último snapshot por semestre (`period`, `"01"`..`"08"`) con `source = 'itson_api'`.
  `finalGrade` es el código guardado en `grade_text` (`"9"`, `"10"`, `"A"`, o `null` si no hay calificación).
- **`classroom`:** sale de `classroom_courses` (migración 006). `period` es `section` (o `null`), `finalGrade` es
  `null` y `updatedAt` es `last_seen_at`.

#### `GET /api/courses/:id/items`

Devuelve las actividades de iVirtual o tareas de Classroom de la materia `:id` del alumno:

```json
{
  "items": [
    {
      "id": "uuid",
      "label": "Asignación 1",
      "grade": 95,
      "maxGrade": 100,
      "dueAt": "2026-11-20T06:59:00.000Z",
      "kind": "ivirtual"
    }
  ]
}
```

- Si `:id` no es un UUID válido, responde `400 {"error":"id_invalido"}` sin tocar la base.
- Si el curso no existe o pertenece a otro alumno, responde `404 {"error":"no_encontrado"}`.
- En materias de **`ivirtual`** (`kind: "ivirtual"`), lee `snapshot_grades` del último snapshot `ivirtual` del alumno
  excluyendo los renglones de resumen (`course` y `category`). `grade` es numérico (o `null` si no está calificada),
  `maxGrade` sale de `raw_payload.max` y `dueAt` de `snapshot_grades.due_at` (migración 013; `null` si no tiene fecha o
  si falta la 013).
- En cursos de **`classroom`** (`kind: "classroom"`), lee `classroom_coursework` del alumno: `label` es `title`,
  `grade` es `null`, `maxGrade` es `max_points` y `dueAt` es `due_at`.
- En materias de **`itson_api`**, responde `200 {"items":[]}` (solo reportan calificación final en `/api/courses`).

### Cierre de sesión y Web Push

`POST /auth/google/logout` responde 204 si cierra la sesión, 403 sin `Origin` válido y 500 si no puede invalidar
la sesión en `google_app_sessions`; en ese caso no borra cookies. Una vez invalidada la sesión, borra de
`push_subscriptions` la suscripción de esta sesión y, si el body trae `endpoint`, la de ese endpoint. Si alguno de
esos borrados falla, registra `push_cleanup_failed` (solo `error_code` y `target`) y el logout termina igual.

**Push huérfano (ITN-54).** El logout no borra la sesión: la marca con `revoked_at` (migración 011) en la misma
escritura que decide el 204 o el 500, así que la marca existe siempre que el logout responde 204. Si la limpieza Push
de la sesión sale bien, borra también la fila marcada. Si falla, la fila queda marcada y la purga borra después
las suscripciones de esa sesión y la propia fila:

- **Antes de cada envío Web Push.** El canal purga el Push de las sesiones marcadas del alumno y luego elige
  destinatarios. La purga **falla cerrado**: si no puede leer las marcas o borrar las suscripciones, ese aviso no
  se envía a **ningún** dispositivo del alumno, queda `failed` en `notifications_log` y se reintenta en la
  siguiente corrida (hasta 5 intentos). Nunca se envía a una suscripción huérfana.
- **En Desconectar.** Borrar la autorización arrastra en cascada las sesiones (migración 008), incluidas las
  marcadas, así que primero se purgan. Si la purga falla, Desconectar responde 500 sin borrar nada
  (`push_orphan_purge_failed`) y se puede reintentar.

Todos los lectores de `google_app_sessions` pasan por `createSessionReader`, que trata una sesión con
`revoked_at` como cerrada: `/auth/google/session`, Desconectar, logout, `/api/*` (incluido
`/api/credentials`) y `/push/subscriptions`. `/internal/credentials` usa `x-api-key` y no lee sesiones.

La purga solo toca sesiones marcadas: Desconectar borra sesiones sin marcarlas y conserva el Push de todos los
dispositivos, y las filas con `session_id` null no coinciden nunca. Los logs solo llevan códigos y conteos
(`push_orphans_purged` con `count`, `push_orphan_purge_failed` con `error_code`).

Riesgo residual: la marca cubre el borrado por sesión, no el borrado por `endpoint` del body. Una suscripción
ligada a otra sesión del mismo navegador, o con `session_id` null, puede quedar huérfana si fallan la baja del
frontend y el borrado por `endpoint` del backend. Recibe avisos hasta que el endpoint responda 404/410 o el
navegador se suscriba de nuevo.

Con una cookie emitida antes de ITN-53 (`Path=/auth/google`), `/api` responde 401 hasta volver a entrar con Google.

### Vinculación de iVirtual (ITN-51)

El alumno siempre es el de la sesión (`req.student.userId`). Un `userId`, `email` o `user` en el body se descarta.

- **`GET`** nunca devuelve el token ni campos cifrados: solo lee `status` y `last_validated_at`. `available` es
  `true` desde ITN-52, porque `server.js` inyecta el puerto real; sin puerto (solo en pruebas) es `false` y el
  frontend no pide la contraseña. `status` es `active`, `needs_relink` o `null` si no hay vinculación.
  `lastValidatedAt` es la hora en que iVirtual aceptó el token; con ella Ajustes dice "Validada".
- **`PUT`** recibe `{ "username": "...", "password": "..." }` (máximo 8 KB de body). `username` se recorta y admite
  hasta 64 caracteres; `password` se manda tal cual, no vacía y hasta 256. El backend llama a
  `exchangeToken({ username, password })`, que se inyecta en `createApp`; si devuelve un token, se guarda cifrado
  como `ivirtual_token` con `status: "active"` y `last_validated_at` en la hora actual, y se responde
  `{ available, linked: true, status: "active", lastValidatedAt: "<ISO>" }`. Volver a vincular una cuenta en
  `needs_relink` la reactiva con fecha nueva y vuelve a salir en `/internal/credentials/active`. La contraseña no se
  guarda: solo vive en memoria durante la petición. Si iVirtual rechaza, no se guarda nada y una vinculación previa
  queda intacta.

  | Código | Body                                   | Cuándo                                                     |
  | ------ | -------------------------------------- | ---------------------------------------------------------- |
  | 400    | `{"error":"cuerpo_invalido", ...}`     | JSON mal formado o campos inválidos (sin citar el valor)   |
  | 409    | `{"error":"cambio_password"}`          | iVirtual respondió `forcepasswordchangenotice` o `passwordisexpired` (ITN-52) |
  | 413    | `{"error":"cuerpo_demasiado_grande"}`  | Más de 8 KB                                                |
  | 422    | `{"error":"vinculacion_fallida"}`      | iVirtual respondió `invalidlogin` (ITN-52; antes `credenciales_rechazadas`) |
  | 429    | `{"error":"demasiados_intentos"}`      | Más de 5 intentos en 15 minutos. Trae `Retry-After`        |
  | 501    | `{"error":"vinculacion_no_disponible"}` | Sin puerto (solo en pruebas)                              |
  | 502    | `{"error":"portal_no_disponible"}`     | Red, timeout, 5xx tras los reintentos, otro errorcode o una respuesta que no es token |

- **Contrato del puerto (ampliado en ITN-52, compatible con ITN-51):**
  - resuelve con el token (texto) si el portal aceptó;
  - resuelve con `null` o con `{ ok: false, reason: "credenciales" }` si rechazó las credenciales (422);
  - resuelve con `{ ok: false, reason: "cambio_password" }` si el portal pide cambiar la contraseña (409);
  - lanza ante fallas técnicas (502). Un `reason` desconocido también responde 502.

  Nada de su error llega a los logs.
- **Puerto real (`src/services/ivirtualToken.js`):** `POST https://ivirtual.itson.edu.mx/login/token.php` con
  `service=moodle_mobile_app` y el cuerpo form-urlencoded (usuario y contraseña nunca van en la URL), `fetch` nativo,
  timeout de 15 s por intento y hasta 2 reintentos solo en red, timeout o 5xx. Es una copia mínima de `getToken` de
  `automation/rpa/ivirtual-api/client.js`, duplicada a propósito porque son servicios distintos en Railway: si cambia
  la forma de pedir el token, hay que cambiar los dos.
- **Límite de intentos:** 5 por alumno cada 15 minutos; cuentan los `PUT` que llegan al puerto, incluidos los 422,
  409 y 502 (no los 400 ni el 501). Una vinculación exitosa reinicia el contador. Vive en memoria: se reinicia con el proceso y no se comparte
  entre instancias. Con más de una réplica hará falta moverlo a la base o a Redis.

### Perfil ITSON (ITN-55)

La API REST de ITSON devuelve las calificaciones de cualquier matrícula sin autenticar, así que la matrícula funciona
como credencial. El alumno siempre es el de la sesión; `userId`, `email` o `user` en el body se descartan.

- **Almacenamiento:** `student_itson_profiles` (migración 012), una fila por alumno. La matrícula va cifrada con
  `credentialCrypto` (AES-256-GCM, AAD `user_id:itson_api:matricula`, misma llave y rotación que las credenciales).
  La carrera va en claro.
- **`GET`** nunca devuelve la matrícula: `matriculaHint` trae solo los últimos 4 dígitos. Sin perfil responde
  `{ configured: false, matriculaHint: null, career: null, updatedAt: null }`.
- **`PUT`** recibe `{ "matricula": "00000123456", "career": "INSOF" }` (máximo 4 KB). `matricula` cumple
  `^00000\d{6}$`; `career` se recorta, se pasa a mayúsculas y cumple `^[A-Z]{2,8}$`. Responde lo mismo que `GET`.
- **Regla del correo:** el correo de la sesión debe ser de `potros.itson.edu.mx` y su parte local debe terminar con
  al menos 6 dígitos iguales a los últimos 6 de la matrícula (`nombre.apellido252587@...` con `00000252587`). Un
  correo de Gmail no sirve aunque termine con esos dígitos: cualquiera puede crear uno. La lista de dominios está en
  `src/models/itsonProfile.js`. En `itson-notify-dev` (2026-11-13) el único correo institucional cumple el patrón;
  la muestra es de 1, así que la regla falta confirmarla con más alumnos.

  | Código | Body                                    | Cuándo                                                  |
  | ------ | --------------------------------------- | ------------------------------------------------------- |
  | 400    | `{"error":"cuerpo_invalido", ...}`      | Formato inválido. `detalles` solo trae ruta y código     |
  | 400    | `{"error":"correo_no_institucional"}`   | El correo de la sesión no es de un dominio institucional |
  | 400    | `{"error":"correo_sin_matricula"}`      | La parte local no termina con al menos 6 dígitos         |
  | 400    | `{"error":"matricula_no_coincide"}`     | Los últimos 6 dígitos no son los del correo              |
  | 413    | `{"error":"cuerpo_demasiado_grande"}`   | Más de 4 KB                                              |
  | 429    | `{"error":"demasiados_intentos"}`       | Más de 10 `PUT` en 15 minutos (cuentan los 400). Trae `Retry-After` |

  El límite vive en memoria, como el de iVirtual. Un guardado exitoso reinicia el contador.
- **Logs:** `perfil_itson_guardado`, `perfil_itson_rechazado` (con `reason`, el código), `perfil_itson_limitado` y
  `perfil_itson_borrado`, solo con `user_id`. Nunca la matrícula, la carrera ni el correo.

### Notificaciones de ejemplo en dev

Una corrida real no genera avisos hasta que cambia una calificación. Para probar el frontend antes de eso:

```bash
SEED_ALUMNO_EMAIL=<correo-del-alumno> npm run seed:dev
```

Lee `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` de `backend/.env` y se niega a correr con `NODE_ENV=production`. Ese
candado depende de la variable: antes de correrlo, revisa que `SUPABASE_URL` sea el proyecto de dev. El alumno debe existir
en `app_users` y la migración 010 debe estar aplicada. Para borrar lo sembrado, usa el SQL del encabezado de
`scripts/seed-dev-notifications.js`.

## Privacidad de los logs

Los eventos de credenciales solo llevan `user_id`, `portal`, `kind`, `key_version`, `status`, `reason`, `count`
(ITN-52, solo en `credenciales_activas_listadas`) y códigos de error. Nunca el secreto, el correo, el body ni los datos cifrados. En la vinculación (ITN-51) tampoco el usuario ni la
contraseña de iVirtual, ni el mensaje o código de error del puerto `exchangeToken`. El manejador de errores de `app.js`
no imprime `err.message` ni `err.body`, donde body-parser deja el JSON mal formado.

Los logs son una línea JSON por evento y solo llevan ids (`snapshot_id`, `user_id`), conteos y códigos de error
(`step`, `error_code`). El logger descarta cualquier otro campo. Nunca se registran calificaciones, nombres de
materias, correos, matrículas, llaves ni el body.

Los eventos de notificación (`notificacion_enviada`, `notificacion_fallida`,
`reintento_notificaciones_fallido`, `notificacion_no_procesada`) solo llevan `grade_change_id`,
`grade_change_ids`, `channel`, `attempts` y conteos. Nunca el texto del mensaje, el error del proveedor
(puede traer el correo) ni el `user_id`. El error del proveedor solo se guarda en `notifications_log.error`.

## Limitaciones conocidas

- **Sin transacción.** supabase-js no permite agrupar los upserts en una transacción. El borrado compensatorio
  cubre las fallas que Supabase reporta, pero si el proceso se cae entre pasos (p. ej. después de insertar
  `grade_snapshots` y antes de terminar `snapshot_grades`), puede quedar un snapshot incompleto. La siguiente
  corrida lo tomaría como "anterior" y vería ítems borrados y creados. Mientras tanto, si el worker reintenta
  con el mismo `run_id`, el snapshot se completa. La solución robusta es una función RPC
  `save_grade_snapshot(payload jsonb)` que haga todo en una transacción, con una migración 006 y
  `grant execute` a `service_role`. **Queda como ticket de seguimiento.**
- **Cambio de nombre de una materia.** `name` forma parte del unique de `subjects`. Si Moodle cambia el nombre
  de un curso, se crea un `subject` nuevo, y el detector ve sus ítems como borrados en la materia vieja y
  creados en la nueva.
- **Reenvío con ítems distintos.** Un reenvío con el mismo `run_id` agrega o actualiza ítems, pero no borra
  los que ya no vienen. El worker debe reenviar exactamente la misma extracción.
- **Grants.** Las tablas de dev existen desde antes del 30 de octubre de 2026 y conservan el acceso
  automático de la `service_role`. En un entorno nuevo hace falta la migración 005 (grants explícitos).
- **Grupo sin reclamar.** Si falla el reclamo en `notifications_log` (Supabase caído justo en ese paso), ese
  grupo no queda registrado y la siguiente corrida no lo ve: `inserted` ya no lo trae y el reintento solo lee
  `notifications_log`. Queda contado en `failed`. Recuperarlo requiere buscar `grade_changes` sin fila en
  `notifications_log`.
- **Corridas simultáneas del mismo alumno.** Dos peticiones al mismo tiempo podrían reintentar la misma fila
  `pending` y enviarla dos veces. El worker corre una vez por intervalo, así que no se esperan.
- **`INTERNAL_API_KEY` todavía lee todos los tokens.** Desde ITN-51 ya no guarda ni borra, pero sigue leyendo y
  marcando cualquier cuenta. Riesgo residual y rotación en
  [`INTERNAL_API_KEY`: mínimo privilegio](#internal_api_key-mínimo-privilegio-itn-51).
- **Pendiente: aviso por cambio de fecha de entrega (ITN-56).** Las fechas se guardan pero no se comparan: si el
  maestro mueve la fecha de una tarea que ya existía, no hay aviso. Para avisarlo habría que agregar `due_at` al
  diff (`grade_changes.field_name = 'due_at'` no choca con la llave de la 004) y leerlo en `getSnapshotItems`,
  que hoy funciona sin la 013. **Ticket aparte.**
- **Pendiente: alertas al equipo desde el backend.** `sendTeamAlert` (Telegram) vive en
  `automation/monitors/telegram.js` y el backend no puede importarlo. Para avisar al equipo de notificaciones
  fallidas hay que sacar ese módulo a algo compartido. **Ticket aparte.** Mientras tanto, los fallos solo
  quedan en el log estructurado y en `notifications_log`.

## Lo que hace el worker con estos endpoints (ITN-25, ITN-52)

En `automation/schedulers/extraccion-cron.js`, cada corrida:

1. Pide `GET ${BACKEND_URL}/internal/credentials/active?portal=ivirtual`. Sin cuentas activas termina con 0.
2. Por cada correo, en secuencia y con una pausa corta, pide el token con `POST /internal/credentials/get`. Un 404
   (desvinculada durante la corrida) o 409 (`needs_relink`) se omite; un 401 cancela la corrida.
3. Extrae con `extractGradesWithToken(token)`. Si iVirtual responde `invalidtoken`, al final de la corrida llama a
   `POST /internal/credentials/needs-relink` con `reason: "credenciales"`, salvo que 3 o más cuentas procesadas
   hayan dado `invalidtoken` todas (rechazo en bloque: no marca ninguna y alerta).
4. Con una extracción correcta manda `POST /internal/grade-snapshots` con
   `{ run_id, captured_at, source: "ivirtual", user: { email: <correo de la cuenta> }, courses: result.courses }`.
   Es el único cambio al contrato de este endpoint: el correo sale de cada cuenta y no de `ALUMNO_EMAIL`.
5. Reintenta solo en errores de red o `5xx`. No reintenta en `400`, `401` ni `409`.
6. Loguea solo conteos, la posición de la cuenta, status HTTP y errorcode. Alerta al equipo a lo más una vez por
   corrida, solo con conteos.

**Fechas de entrega (ITN-56).** Después de leer las notas de todos los cursos, `fetchGradesDetalle` (en
`automation/rpa/ivirtual-api/grades.js`) hace **una** llamada a `mod_assign_get_assignments` con todos los
`courseids` y une cada tarea con su grade item por `cmid`. Moodle manda las fechas en segundos Unix con `0` cuando
no hay: se convierten a ISO 8601 y `0` queda `null`. Por ítem van `dueAt` (`duedate`), `opensAt`
(`allowsubmissionsfromdate`) y `closesAt` (`cutoffdate`); un ítem que no es tarea va con las tres en `null`.

- **Si la llamada de tareas falla** (permiso, `5xx` tras los reintentos de `callWs`, red), la extracción **no**
  falla: se entregan las notas **sin** campos de fecha (`fechas: "no_disponibles"`), el backend conserva las
  fechas anteriores y el cron loguea `Fechas de entrega no disponibles (cuenta n/total): errorcode=...` por stdout
  (no cuenta como falla ni alerta). Un curso que Moodle omite de la respuesta (con un `warning`) también va sin
  campos de fecha. Si fallan las notas, falla como antes y no se llama a tareas.
- **Ítems ocultos (`shouldKeep`).** Un ítem con la nota oculta (`gradeishidden`) y sin valor se sigue omitiendo,
  **salvo** que `mod_assign_get_assignments` lo devuelva: entonces la tarea es visible para el alumno y se
  conserva para no perder el aviso de tarea nueva (una tarea recién publicada puede llegar así). Sin fechas
  (la llamada falló) se aplica la regla de antes. **Riesgo de la primera corrida tras el despliegue:** las tareas
  con la nota oculta que ya existían y antes se omitían aparecerán **una vez** como tareas nuevas y generarán su
  aviso. Por eso el despliegue y esa primera corrida deben hacerse **antes** del ensayo con el profesor.
- **Verificación con una cuenta real:** `node automation/scripts/verificar-ivirtual-fechas.js` (desde
  `ITSON-Notify/`, con `Id_User` y `P_User` del `.env`) imprime solo conteos y sí/no: si `moodle_mobile_app`
  permite cada función, cursos, ítems sin nota, ítems con `hidden`, tareas unidas por `cmid` y con fecha. Con
  `--curso <id>` da el detalle por actividad (nombre, tipo, nota sí/no, oculta, entrega en hora de Hermosillo).
  El token no se imprime. Para ver la salida completa con fechas: `npm run extract:grades`.

**Fase de la API REST de ITSON (ITN-55).** Después de la de iVirtual, en su propio try/catch, el worker pide
`GET /internal/itson-profiles/active` con `x-api-key: ITSON_PROFILES_API_KEY` (credencial separada de `INTERNAL_API_KEY`) y, por alumno, consulta `getAlumnoInscrito`, `getProgress` y `getGrades` (hasta
3 semestres pendientes), solo dentro de la ventana de fechas del semestre (7 días antes del inicio a 45 después del
fin, configurable). Por cada semestre con materias manda `POST /internal/grade-snapshots` con
`source: "itson_api"`, `period` (la clave del semestre) y su propio `run_id`. Detalle en
[`docs/deployment/cron-railway.md`](../docs/deployment/cron-railway.md).

Variables del servicio `worker-rpa`: **solo** `BACKEND_URL`, `INTERNAL_API_KEY` y, para las alertas,
`TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` (más `RPA_PAUSADO` para pausar). ITN-55: `ITSON_API_BASE_URL` habilita la
fase de la API de ITSON; sin ella, esa fase no corre. Solo acepta `https://webapi.itson.edu.mx` (lista cerrada en
`automation/services/itsonApiClient.js`): otro host, `http`, credenciales, puerto distinto de 443, punto final o
ruta cancelan la fase con alerta de configuración, y las redirecciones 3xx nunca se siguen. `ITSON_API_VENTANA_ANTES_DIAS` (7) e
`ITSON_API_VENTANA_DESPUES_DIAS` (45) ajustan la ventana. Desde ITN-52 `Id_User`, `P_User` y
`ALUMNO_EMAIL` ya no se usan en el cron (siguen solo en `cli.js` y `login-demo.js`, que son herramientas locales).
Nunca `SUPABASE_SERVICE_ROLE_KEY`, `CREDENTIALS_ENCRYPTION_KEY` ni la matrícula en el body. Detalles de despliegue,
códigos de salida y alertas en [`docs/deployment/cron-railway.md`](../docs/deployment/cron-railway.md).
# ITN-59

Contrato interno Classroom, configuración y preparación de usuarios de prueba:
[ITN-59.md](ITN-59.md).
