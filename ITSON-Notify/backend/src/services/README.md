# Servicios de detección de cambios (ITN-24)

- `gradeDiff.js`: `diffSnapshots(previousItems, currentItems)` es una función pura, sin I/O.
- `gradeChangeService.js`: `detectChanges({ userId, currentSnapshotId }, repo)` obtiene los snapshots, corre el
  diff y guarda en `grade_changes` mediante un **repo inyectado**.

El backend Express (ITN-27) todavía no existe. Este módulo no depende de Express ni de Supabase: el repo real
se conecta cuando ITN-27 se mergee. Las pruebas usan un repo en memoria
(`backend/tests/services/gradeChangeService.test.js`) que sirve de implementación de referencia.

```bash
cd backend && npm test
```

Requiere la migración 003 (`external_item_id`). Hoy está en la rama `Feat-ITN-33-external-item-id` y todavía
no está en `main`.

## Reglas del diff

- Cada ítem se identifica por `(subjectId, externalItemId)`, **nunca por nombre**. El mismo id en otra materia
  es otro ítem.
- Sin snapshot anterior (primera corrida), no se compara: devuelve `{ baseline: true, changes: [] }` y no se
  escribe nada.
- Si el snapshot anterior tiene ítems `legacy:%` (filas viejas que la migración 003 rellenó), también se toma
  como línea base, con `reason: 'snapshot_legacy'`.
- Para un ítem que existe en ambos snapshots, se genera un registro por cada campo que cambió: `grade_value`,
  `grade_text`, `grade_label`. `null → valor` es un `updated` del campo, no un `created` del ítem.
- `grade_value` se compara con tolerancia a 2 decimales (diferencia menor a 0.005). Acepta números o texto
  numérico, como suele devolver Postgres el tipo `numeric`.
- Ítem nuevo: `created`, con un registro por cada campo que tenga valor. Ítem ausente en el actual: `deleted`,
  igual. Si el ítem no tiene ningún valor, se deja un solo registro de `grade_value` con ambos valores `null`.
- Los valores se guardan como texto. Los números se redondean a 2 decimales sin ceros sobrantes (`"85.5"`).
- Un ítem sin `externalItemId` o duplicado dentro de un snapshot lanza un error y no se escribe nada.

## Contrato del repo

Todos los métodos son `async`. Los ids son los `uuid` de la base.

### `getPreviousSnapshotItems(userId, currentSnapshotId)` → `{ snapshotId, items } | null`

Devuelve el snapshot **inmediatamente anterior** a `currentSnapshotId` del mismo `userId`, junto con sus ítems.
Si no hay ninguno, devuelve `null`.

- "Anterior" se define por `grade_snapshots.captured_at`, el más reciente que sea menor al del snapshot actual.
  Para desempatar, usa `id`. Nunca devuelve el mismo `currentSnapshotId`.
- Si el sistema maneja más de una fuente (iVirtual, Classroom), filtra también por la `source` del snapshot
  actual. El estado es por alumno, fuente e id de registro (ver `docs/diagrams/diagram.md`).
- `items` tiene la misma forma que en `getSnapshotItems`.

### `getSnapshotItems(snapshotId)` → `Item[]`

Todas las filas de `snapshot_grades` del snapshot, mapeadas así:

| Campo de `Item`  | Columna de `snapshot_grades` | Nota                                            |
| ---------------- | ---------------------------- | ----------------------------------------------- |
| `subjectId`      | `subject_id`                 | obligatorio                                     |
| `externalItemId` | `external_item_id`           | obligatorio (migración 003, id de Moodle)       |
| `label`          | `grade_label`                | puede ser `null` (el total del curso no tiene nombre) |
| `value`          | `grade_value`                | número, texto numérico o `null`                 |
| `text`           | `grade_text`                 | puede ser `null`                                |

### `insertGradeChanges(rows)` → filas insertadas

Recibe las filas listas para `grade_changes`:

```js
{
  user_id, subject_id, previous_snapshot_id, current_snapshot_id,
  external_item_id,   // migración 003
  field_name,         // 'grade_value' | 'grade_text' | 'grade_label'
  previous_value,     // texto o null
  current_value,      // texto o null
  change_type,        // 'created' | 'updated' | 'deleted'
}
```

Debe **insertar ignorando duplicados** según la llave natural
`(previous_snapshot_id, current_snapshot_id, subject_id, external_item_id, field_name)`, y devolver **solo las
filas que realmente se insertaron**, con su `id`. De esto depende la idempotencia: si `detectChanges` corre dos
veces sobre el mismo par de snapshots, la segunda vez no duplica filas y devuelve `inserted: []`.

`detectChanges` no llama a este método cuando no hay cambios.

## Resultado de `detectChanges` (para ITN-28)

```js
{
  baseline: boolean,          // true: no hubo comparación
  reason: 'primera_corrida' | 'snapshot_legacy' | null,
  changes: [...],             // todos los cambios calculados (formato de diffSnapshots)
  inserted: [...],            // filas de grade_changes insertadas en ESTA llamada, con id
}
```

El servicio de notificación debe usar `inserted`, no `changes`. Cada fila trae el `id` que necesita
`notifications_log.grade_change_id`. Así una segunda corrida no vuelve a notificar.

Varias filas de `inserted` pueden ser del mismo ítem (una por campo). Conviene agruparlas por
`(subject_id, external_item_id)` para mandar un solo aviso por ítem. Además, el total del curso llega con
`grade_label` `null`. Decidir si se notifica o cómo se nombra ("Total del curso") le toca a ITN-28; el `type`
del ítem viene en la extracción de ITN-23, pero hoy no se guarda en `snapshot_grades`.

# Notificación de prueba (ITN-28)

- `notificationService.js`: `notifyGradeChange(gradeChange, { repo, channels, context })` envía el aviso de una
  fila de `grade_changes` por cada canal y registra cada envío en `notifications_log` (tabla de la migración 002,
  no hace falta migración nueva).
- `notificationChannels.js`: `buildChannels({ env, logger })` arma los canales:
  - `log`: siempre.
  - `email` (Resend, por HTTP, sin dependencias): solo si existen `RESEND_API_KEY` y `NOTIFY_EMAIL_TO`. Si falta
    alguna, el canal se omite con un aviso en el log y no falla nada. Remitente: `NOTIFY_EMAIL_FROM`.
  - FCM y Telegram están fuera de alcance.

```js
const { inserted } = await detectChanges({ userId, currentSnapshotId }, gradeRepo);
const channels = buildChannels();
for (const cambio of inserted) {
  await notifyGradeChange(cambio, { repo: notificationsRepo, channels, context: { subjectName, itemLabel } });
}
```

## Mensaje

Solo lleva la actividad, la materia y los valores (`"Tarea 2 en Cálculo cambió de 70 a 75 (calificación)."`).
Nunca email, nombre, matrícula, ids ni credenciales. `itemLabel: null` se muestra como "Total del curso".

## Idempotencia y reintentos

- Un registro por `(grade_change_id, channel)` (unique de la migración 002).
- Si el canal ya quedó `sent`, no se reenvía: el resultado es `duplicate`.
- Si quedó `pending` o `failed`, se reintenta sobre la misma fila (`attempts + 1`), hasta `MAX_ATTEMPTS` (5).
- Un canal que falla queda `failed` con el error (sin la llave) y no detiene a los demás.

## Contrato del repo de `notifications_log`

### `claimNotification({ user_id, grade_change_id, channel, payload })` → fila

Inserta la fila con `status = 'pending'` y `attempts = 0` **ignorando el conflicto** en
`(grade_change_id, channel)`. Si ya existía, devuelve la fila existente sin modificarla. Siempre devuelve
`{ id, status, attempts, ... }`. Con supabase-js (service_role, solo backend):

```js
const { data } = await db.from("notifications_log")
  .upsert(row, { onConflict: "grade_change_id,channel", ignoreDuplicates: true })
  .select();
// si data está vacío, ya existía: leerla con .eq("grade_change_id", ...).eq("channel", ...).single()
```

### `updateNotification(id, patch)`

Actualiza `status`, `attempts`, `error` y `sent_at`.

## Pruebas

`backend/tests/services/notificationService.test.js` simula con un usuario de prueba (datos inventados) un
cambio 70 → 75 y verifica: el registro en `notifications_log`, que un segundo envío no se duplica y que sin
`RESEND_API_KEY` solo funciona el canal `log`. Usa repos en memoria y un `fetch` falso, así que no toca Supabase
ni Resend.
