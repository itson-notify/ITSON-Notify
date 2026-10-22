# Servicios de detección de cambios (ITN-24)

- `gradeDiff.js`: `diffSnapshots(previousItems, currentItems)` es una función pura, sin I/O.
- `gradeChangeService.js`: `detectChanges({ userId, currentSnapshotId }, repo)` obtiene los snapshots, corre el
  diff y guarda en `grade_changes` mediante un **repo inyectado**.

Este módulo no depende de Express ni de Supabase. El repo real sobre Supabase es
`backend/src/repositories/gradeChangeRepository.js` (ITN-27). Las pruebas del servicio usan un repo en memoria
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
