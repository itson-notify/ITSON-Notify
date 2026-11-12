# Backend de ITSON Notify (ITN-27)

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
(suscripciones Web Push; sin ella, `/push` falla y el logout no puede revocar el Push del dispositivo) y
`010_notifications_read_at.sql` (estado de lectura; sin ella, fallan las notificaciones de `/api`).

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
| `NOTIFY_EMAIL_TO`   | Destinatario de prueba. Sin él, el canal `email` se omite                  |
| `NOTIFY_EMAIL_FROM` | Remitente. Vacío usa `ITSON Notify <onboarding@resend.dev>`                |

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
| `src/utils/logger.js`                        | Logs JSON con lista blanca de campos                         |

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
| `source`                      | Opcional, por ahora solo `"ivirtual"` (valor por defecto)                                |
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
| `GET /api/notifications`               | Hasta 100 notificaciones con forma `Notif`, de la más reciente a la más antigua |
| `POST /api/notifications/:id/read`     | 204. 400 `id_invalido` si no es uuid; 404 si no existe o es de otro alumno  |
| `POST /api/notifications/read-all`     | 204                                                                         |
| `GET /api/credentials/ivirtual`        | `{ available, linked, status, lastValidatedAt }` (ITN-51)                   |
| `PUT /api/credentials/ivirtual`        | Vincula iVirtual (ITN-51, ver abajo)                                        |
| `DELETE /api/credentials/ivirtual`     | 204. 404 `no_encontrado` si no había vinculación (ITN-51)                   |

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

### Cierre de sesión y Web Push

`POST /auth/google/logout` responde 204 si cierra la sesión, 403 sin `Origin` válido y 500 si no puede invalidar
la sesión en `google_app_sessions`; en ese caso no borra cookies. Una vez invalidada la sesión, borra de
`push_subscriptions` la suscripción de esta sesión y, si el body trae `endpoint`, la de ese endpoint. Si alguno de
esos borrados falla, registra `push_cleanup_failed` (solo `error_code` y `target`) y el logout termina igual.

Riesgo residual: el envío de Web Push elige destinatarios solo por `user_id`, sin mirar la sesión. Si la limpieza
falla, el dispositivo puede seguir recibiendo avisos privados del alumno hasta que el endpoint responda 404/410. El
frontend revoca el Push del navegador antes de llamar al logout, así que esto solo ocurre si fallan las dos
limpiezas, la del frontend y la del backend. La mitigación va en un ticket aparte.

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

Variables del servicio `worker-rpa`: **solo** `BACKEND_URL`, `INTERNAL_API_KEY` y, para las alertas,
`TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` (más `RPA_PAUSADO` para pausar). Desde ITN-52 `Id_User`, `P_User` y
`ALUMNO_EMAIL` ya no se usan en el cron (siguen solo en `cli.js` y `login-demo.js`, que son herramientas locales).
Nunca `SUPABASE_SERVICE_ROLE_KEY`, `CREDENTIALS_ENCRYPTION_KEY` ni la matrícula en el body. Detalles de despliegue,
códigos de salida y alertas en [`docs/deployment/cron-railway.md`](../docs/deployment/cron-railway.md).
