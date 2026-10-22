# Backend de ITSON Notify (ITN-27)

Servidor Express que recibe cada extracción del worker (ITN-25), la guarda en Supabase y corre el detector de
cambios de ITN-24. No envía notificaciones: ese acople es de ITN-28.

```bash
cd backend
npm install
cp .env.example .env   # llena los valores
npm run dev            # node --env-file=.env src/server.js
npm test               # node:test, con Supabase simulado
```

Requiere Node 20 o más nuevo. En Railway se usa `npm start` y las variables del servicio, sin archivo `.env`.

## Variables

| Variable                    | Uso                                                              |
| --------------------------- | ---------------------------------------------------------------- |
| `PORT`                      | Puerto HTTP                                                      |
| `INTERNAL_API_KEY`          | Llave compartida con el worker (`x-api-key`), mínimo 32 caracteres |
| `SUPABASE_URL`              | URL del proyecto                                                 |
| `SUPABASE_SERVICE_ROLE_KEY` | Llave `service_role`. **Solo en el backend**                     |

Si falta alguna o es inválida, el servidor no arranca y el mensaje nombra la variable (nunca su valor).

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
| `src/routes/gradeSnapshots.js`               | `POST /internal/grade-snapshots`                             |
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
| `user.email`                  | **Obligatorio.** Correo del alumno (`ALUMNO_EMAIL` del worker). Se guarda en minúsculas. **Nunca la matrícula** |
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
  "changes_inserted": 2
}
```

- `snapshot_created`: `false` si el `run_id` ya existía (reenvío).
- `baseline` y `reason`: los de `detectChanges` (`primera_corrida`, `snapshot_legacy` o `null`).
- `changes_detected`: cambios calculados contra el snapshot anterior. `changes_inserted`: filas nuevas en
  `grade_changes` en esta llamada (0 en un reenvío).

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

## Privacidad de los logs

Los logs son una línea JSON por evento y solo llevan ids (`snapshot_id`, `user_id`), conteos y códigos de error
(`step`, `error_code`). El logger descarta cualquier otro campo. Nunca se registran calificaciones, nombres de
materias, correos, matrículas, llaves ni el body.

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
  automático de la `service_role`. En un entorno nuevo hace falta la migración 005 (grants explícitos,
  rama de ITN-28).

## Lo que necesita ITN-25 para llamar a este endpoint

En `automation/schedulers/extraccion-cron.js`, `entregarResultados(result, { log })` debe:

1. Enviar solo si `result.status === "ok"`.
2. Generar un `run_id` por corrida con `crypto.randomUUID()` y usar el mismo en cada reintento de esa corrida.
3. Tomar `captured_at` al terminar la extracción (`new Date().toISOString()`).
4. Mandar `POST ${BACKEND_URL}/internal/grade-snapshots` con `x-api-key: INTERNAL_API_KEY` y el body
   `{ run_id, captured_at, source: "ivirtual", user: { email: ALUMNO_EMAIL }, courses: result.courses }`.
5. Reintentar solo en errores de red o `5xx`. No reintentar en `400`, `401` ni `409`.
6. Loguear solo el status HTTP y los conteos de la respuesta.

Variables del servicio `worker-rpa`: `BACKEND_URL`, `INTERNAL_API_KEY` y **`ALUMNO_EMAIL` (nueva)**. Nunca
`SUPABASE_SERVICE_ROLE_KEY` ni la matrícula en el body.
