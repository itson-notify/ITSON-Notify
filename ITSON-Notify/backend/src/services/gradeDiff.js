// ITN-24 - Diff puro entre dos snapshots de calificaciones.
// Sin I/O: recibe listas de ítems y devuelve los cambios. La persistencia vive
// en gradeChangeService.js detrás de un repo inyectado.
//
// Forma de cada ítem (lo que devuelve el repo, ver README.md):
//   { subjectId, externalItemId, label, value, text }
// Cada ítem se identifica por (subjectId, externalItemId), NUNCA por nombre:
// en Moodle itemname puede repetirse dentro de un curso.

// Campos comparados, en el orden en que se reportan. La clave es el nombre de
// la columna en snapshot_grades / grade_changes.field_name.
const FIELDS = [
  { fieldName: "grade_value", key: "value", numeric: true },
  { fieldName: "grade_text", key: "text" },
  { fieldName: "grade_label", key: "label" },
];

// Dos números son iguales si difieren en menos de media centésima
// (tolerancia a 2 decimales, igual que numeric(5,2) en la base).
const TOLERANCIA = 0.005;

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalize(value, numeric) {
  if (numeric) return toNumberOrNull(value);
  return value === undefined ? null : value;
}

function sameValue(a, b, numeric) {
  if (a === null || b === null) return a === b;
  if (numeric) return Math.abs(a - b) < TOLERANCIA;
  return String(a) === String(b);
}

// previous_value / current_value se guardan como texto. Los números se
// redondean a 2 decimales y sin ceros sobrantes ("85.5", no "85.50").
function toText(value, numeric) {
  if (value === null) return null;
  if (numeric) return String(Number(value.toFixed(2)));
  return String(value);
}

function itemKey(item) {
  if (item.subjectId === null || item.subjectId === undefined) {
    throw new Error("Ítem sin subjectId: no se puede comparar");
  }
  if (item.externalItemId === null || item.externalItemId === undefined || item.externalItemId === "") {
    throw new Error(`Ítem sin externalItemId en la materia ${item.subjectId}: no se puede comparar`);
  }
  return `${item.subjectId}\u0000${item.externalItemId}`;
}

function indexItems(items, nombre) {
  const map = new Map();
  for (const item of items) {
    const key = itemKey(item);
    if (map.has(key)) {
      throw new Error(
        `Ítem duplicado en el snapshot ${nombre}: materia ${item.subjectId}, ítem ${item.externalItemId}`,
      );
    }
    map.set(key, item);
  }
  return map;
}

function change(changeType, field, item, previous, current) {
  return {
    changeType,
    fieldName: field.fieldName,
    previousValue: toText(previous, field.numeric),
    currentValue: toText(current, field.numeric),
    externalItemId: String(item.externalItemId),
    subjectId: item.subjectId,
  };
}

// Ítem nuevo o eliminado: un registro por cada campo con valor. Si el ítem no
// tiene ningún valor (p. ej. una actividad sin calificar), se deja un solo
// registro de grade_value para que la alta o la baja quede registrada.
function wholeItemChanges(changeType, item) {
  const conValor = FIELDS.filter((f) => normalize(item[f.key], f.numeric) !== null);
  const campos = conValor.length > 0 ? conValor : [FIELDS[0]];
  return campos.map((field) => {
    const value = normalize(item[field.key], field.numeric);
    return changeType === "created"
      ? change("created", field, item, null, value)
      : change("deleted", field, item, value, null);
  });
}

// Compara dos snapshots.
//   previousItems: arreglo de ítems del snapshot anterior, o null/undefined si
//                  no hay snapshot anterior (primera corrida).
//   currentItems:  arreglo de ítems del snapshot actual.
// Devuelve { baseline, changes }. En la primera corrida devuelve
// { baseline: true, changes: [] }: el snapshot actual se vuelve la línea base y
// no se generan 'created' masivos.
function diffSnapshots(previousItems, currentItems) {
  if (previousItems === null || previousItems === undefined) {
    return { baseline: true, changes: [] };
  }

  const previous = indexItems(previousItems, "anterior");
  const current = indexItems(currentItems ?? [], "actual");
  const changes = [];

  for (const [key, item] of current) {
    const before = previous.get(key);
    if (!before) {
      changes.push(...wholeItemChanges("created", item));
      continue;
    }
    // Mismo ítem: un registro por campo que cambió. null -> valor es un
    // 'updated' del campo, no un 'created' del ítem.
    for (const field of FIELDS) {
      const a = normalize(before[field.key], field.numeric);
      const b = normalize(item[field.key], field.numeric);
      if (!sameValue(a, b, field.numeric)) {
        changes.push(change("updated", field, item, a, b));
      }
    }
  }

  for (const [key, item] of previous) {
    if (!current.has(key)) {
      changes.push(...wholeItemChanges("deleted", item));
    }
  }

  // Orden estable para pruebas y para que dos corridas generen lo mismo.
  const orden = (f) => FIELDS.findIndex((x) => x.fieldName === f);
  changes.sort(
    (x, y) =>
      String(x.subjectId).localeCompare(String(y.subjectId)) ||
      x.externalItemId.localeCompare(y.externalItemId, undefined, { numeric: true }) ||
      orden(x.fieldName) - orden(y.fieldName),
  );

  return { baseline: false, changes };
}

module.exports = { diffSnapshots, FIELDS, TOLERANCIA };
