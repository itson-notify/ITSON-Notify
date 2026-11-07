// Supabase simulado en memoria para las pruebas de ITN-27. Imita solo lo que
// usa el backend del query builder de supabase-js (select, upsert, update,
// delete, eq/neq/lt/in/not is null, order, limit, range, single, maybeSingle) y
// las reglas de las migraciones 001 a 004, 006 y 007 que importan aquí:
//   - upsert exige que onConflict sea el id o un unique real de la tabla
//     (Postgres responde 42P10 si no), así las pruebas detectan llaves mal
//     escritas;
//   - unique nulls not distinct (NULL = NULL al comparar llaves);
//   - external_item_id NOT NULL en snapshot_grades;
//   - borrar un grade_snapshot borra sus snapshot_grades (cascade);
//   - student_credentials: checks de la 007, llave foránea a app_users y borrado
//     en cascada. Los bytea solo se aceptan como texto `\x...`, igual que los
//     devuelve PostgREST.
// Nunca se conecta a nada.
const crypto = require("crypto");

// Texto hexadecimal `\x...` y, si se pide, con un largo exacto en bytes.
const esBytea = (bytes) => (v) =>
  typeof v === "string" &&
  /^\\x([0-9a-f]{2})+$/.test(v) &&
  (bytes === undefined || (v.length - 2) / 2 === bytes);

const KINDS_POR_PORTAL = {
  ivirtual: ["ivirtual_token", "ivirtual_password"],
  google_classroom: ["google_refresh_token"],
};

const TABLES = {
  app_users: { uniques: [["email"]] },
  subjects: { uniques: [["user_id", "external_subject_id", "name", "period"]], notNull: ["user_id", "name"] },
  grade_snapshots: { uniques: [], notNull: ["user_id"], defaults: { source: "ivirtual" } },
  snapshot_grades: {
    uniques: [["snapshot_id", "subject_id", "external_item_id"]],
    notNull: ["snapshot_id", "subject_id", "external_item_id"],
  },
  grade_changes: {
    uniques: [["previous_snapshot_id", "current_snapshot_id", "subject_id", "external_item_id", "field_name"]],
    notNull: ["user_id", "field_name", "change_type"],
  },
  // 002: unique (grade_change_id, channel); status y attempts con default.
  notifications_log: {
    uniques: [["grade_change_id", "channel"]],
    notNull: ["user_id", "channel", "status", "attempts"],
    defaults: { status: "pending", attempts: 0, error: null, sent_at: null, payload: null },
  },
  // 006: defaultNow son las columnas con default now(), que solo aplica al insertar.
  classroom_courses: {
    uniques: [["user_id", "external_course_id"]],
    notNull: ["user_id", "external_course_id", "name"],
    defaultNow: ["first_seen_at", "last_seen_at", "updated_at"],
  },
  classroom_coursework: {
    uniques: [["course_id", "external_coursework_id"]],
    notNull: ["user_id", "course_id", "external_coursework_id", "title"],
    defaultNow: ["first_seen_at", "last_seen_at", "updated_at"],
  },
  // 007: checks por columna y el que amarra kind con portal.
  student_credentials: {
    uniques: [["user_id", "portal", "kind"]],
    notNull: ["user_id", "portal", "kind", "ciphertext", "nonce", "auth_tag"],
    defaults: { key_version: 1, status: "active", last_validated_at: null },
    defaultNow: ["updated_at"],
    checks: {
      portal: (v) => v in KINDS_POR_PORTAL,
      kind: (v) => Object.values(KINDS_POR_PORTAL).flat().includes(v),
      status: (v) => ["active", "needs_relink"].includes(v),
      ciphertext: esBytea(),
      nonce: esBytea(12),
      auth_tag: esBytea(16),
    },
    rowCheck: (r) => KINDS_POR_PORTAL[r.portal]?.includes(r.kind),
  },
  // 008 y 009: Autorización con Google Classroom y Suscripciones Web Push.
  push_subscriptions: {
    uniques: [["user_id", "endpoint"]],
    notNull: ["user_id", "endpoint", "p256dh", "auth"]
  },
  google_app_sessions: {
    uniques: [["id"]],
    notNull: ["user_id", "google_id", "expires_at"]
  },
  google_authorizations: {
    uniques: [["user_id", "google_id"]],
    notNull: ["user_id", "google_id", "email"]
  }
};

// Primer check que la fila (o el cambio de un update) no cumple.
function checkViolado(def, row) {
  for (const [columna, cumple] of Object.entries(def.checks ?? {})) {
    if (columna in row && !cumple(row[columna])) return columna;
  }
  return null;
}

const TIMESTAMPS = new Set(["captured_at", "created_at", "first_seen_at", "last_seen_at"]);

const norm = (v) => (v === undefined ? null : v);
const keyOf = (row, cols) => JSON.stringify(cols.map((c) => norm(row[c])));
const sameCols = (a, b) => a.length === b.length && a.every((c) => b.includes(c));

function compare(column, a, b) {
  if (TIMESTAMPS.has(column)) return Date.parse(a) - Date.parse(b);
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function project(row, columns) {
  if (!columns || columns.trim() === "*") return { ...row };
  const out = {};
  for (const c of columns.split(",").map((s) => s.trim())) out[c] = norm(row[c]);
  return out;
}

const pgError = (code, message) => ({ data: null, error: { code, message } });

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.op = "select";
    this.columns = "*";
    this.returning = false;
    this.filters = [];
    this.orders = [];
    this.limitN = null;
    this.rangeAB = null;
    this.mode = "many";
  }

  select(columns = "*") {
    this.columns = columns;
    this.returning = true;
    return this;
  }
  upsert(rows, options = {}) {
    this.op = "upsert";
    this.rows = Array.isArray(rows) ? rows : [rows];
    this.options = options;
    return this;
  }
  update(patch) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  in(column, values) {
    this.filters.push((r) => norm(r[column]) !== null && values.includes(r[column]));
    return this;
  }
  // Solo la forma que usa el backend: .not(column, "is", null).
  not(column, operator, value) {
    if (operator !== "is" || value !== null) throw new Error(`not(${operator}) no soportado en el fake`);
    this.filters.push((r) => norm(r[column]) !== null);
    return this;
  }
  eq(column, value) {
    this.filters.push((r) => compare(column, norm(r[column]), value) === 0 && norm(r[column]) !== null);
    return this;
  }
  neq(column, value) {
    this.filters.push((r) => norm(r[column]) !== null && compare(column, r[column], value) !== 0);
    return this;
  }
  lt(column, value) {
    this.filters.push((r) => norm(r[column]) !== null && compare(column, r[column], value) < 0);
    return this;
  }
  order(column, { ascending = true } = {}) {
    this.orders.push({ column, ascending });
    return this;
  }
  limit(n) {
    this.limitN = n;
    return this;
  }
  range(from, to) {
    this.rangeAB = [from, to];
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  maybeSingle() {
    this.mode = "maybeSingle";
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve()
      .then(() => this.execute())
      .then(resolve, reject);
  }

  execute() {
    this.db.calls.push({ table: this.table, op: this.op });
    const fallo = this.db.takeFailure(this.table, this.op);
    // El mensaje simulado trae datos del body, como lo haría Postgres
    // ("Key (email)=(...)"), para probar que nunca llega a logs ni respuestas.
    if (fallo) return pgError(fallo.code, `fallo simulado: ${JSON.stringify(this.rows ?? [])}`);

    let result;
    if (this.op === "upsert") result = this.executeUpsert();
    else if (this.op === "delete") result = this.executeDelete();
    else if (this.op === "update") result = this.executeUpdate();
    else result = { data: this.executeSelect(), error: null };
    if (result.error) return result;

    const data = this.op === "select" || this.returning ? result.data : null;
    if (this.mode === "single") {
      if (!data || data.length !== 1) return pgError("PGRST116", "single sin exactamente una fila");
      return { data: data[0], error: null };
    }
    if (this.mode === "maybeSingle") {
      if (data && data.length > 1) return pgError("PGRST116", "maybeSingle con varias filas");
      return { data: data?.[0] ?? null, error: null };
    }
    return { data, error: null };
  }

  executeSelect() {
    let rows = this.db.tables[this.table].filter((r) => this.filters.every((f) => f(r)));
    if (this.orders.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const { column, ascending } of this.orders) {
          const c = compare(column, a[column], b[column]);
          if (c !== 0) return ascending ? c : -c;
        }
        return 0;
      });
    }
    if (this.rangeAB) rows = rows.slice(this.rangeAB[0], this.rangeAB[1] + 1);
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    return rows.map((r) => project(r, this.columns));
  }

  executeUpsert() {
    const def = TABLES[this.table];
    const store = this.db.tables[this.table];
    const conflict = (this.options.onConflict ?? "id").split(",").map((s) => s.trim());
    if (!sameCols(conflict, ["id"]) && !def.uniques.some((u) => sameCols(u, conflict))) {
      return pgError("42P10", "no hay unique que coincida con ON CONFLICT");
    }

    // Todo o nada, como un INSERT ... ON CONFLICT de Postgres.
    const staged = store.map((r) => ({ ...r }));
    const vistas = new Set();
    const devueltas = [];
    for (const input of this.rows) {
      const row = { ...input };
      for (const c of def.notNull ?? []) {
        if (norm(row[c]) === null) return pgError("23502", `null en ${c}`);
      }
      const violado = checkViolado(def, row);
      if (violado || (def.rowCheck && !def.rowCheck(row))) {
        return pgError("23514", `check violado${violado ? ` en ${violado}` : ""}`);
      }
      if (this.table === "snapshot_grades" && !this.db.tables.grade_snapshots.some((s) => s.id === row.snapshot_id)) {
        return pgError("23503", "snapshot inexistente");
      }
      if (this.table === "student_credentials" && !this.db.tables.app_users.some((u) => u.id === row.user_id)) {
        return pgError("23503", "usuario inexistente");
      }
      const key = keyOf(row, conflict);
      if (vistas.has(key)) {
        if (this.options.ignoreDuplicates) continue;
        return pgError("21000", "ON CONFLICT DO UPDATE no puede afectar la fila dos veces");
      }
      vistas.add(key);

      const existente = staged.find((r) => keyOf(r, conflict) === key);
      if (existente) {
        if (this.options.ignoreDuplicates) continue;
        Object.assign(existente, row, { id: existente.id });
        devueltas.push(existente);
        continue;
      }
      const nueva = {
        ...(def.defaults ?? {}),
        ...Object.fromEntries((def.defaultNow ?? []).map((c) => [c, new Date().toISOString()])),
        id: row.id ?? crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ...row,
      };
      if (this.table === "grade_snapshots" && !nueva.captured_at) nueva.captured_at = new Date().toISOString();
      if (nueva.captured_at) nueva.captured_at = new Date(nueva.captured_at).toISOString();
      for (const u of def.uniques) {
        if (staged.some((r) => keyOf(r, u) === keyOf(nueva, u))) return pgError("23505", "duplicado");
      }
      staged.push(nueva);
      devueltas.push(nueva);
    }
    this.db.tables[this.table] = staged;
    return { data: devueltas.map((r) => project(r, this.columns)), error: null };
  }

  executeUpdate() {
    const def = TABLES[this.table];
    const cambiadas = this.db.tables[this.table].filter((r) => this.filters.every((f) => f(r)));
    for (const c of def.notNull ?? []) {
      if (c in this.patch && norm(this.patch[c]) === null) return pgError("23502", `null en ${c}`);
    }
    const violado = checkViolado(def, this.patch);
    if (violado) return pgError("23514", `check violado en ${violado}`);
    for (const r of cambiadas) Object.assign(r, this.patch);
    return { data: cambiadas.map((r) => project(r, this.columns)), error: null };
  }

  executeDelete() {
    const store = this.db.tables[this.table];
    const borradas = store.filter((r) => this.filters.every((f) => f(r)));
    this.db.tables[this.table] = store.filter((r) => !borradas.includes(r));
    if (this.table === "grade_snapshots") {
      const ids = new Set(borradas.map((r) => r.id));
      this.db.tables.snapshot_grades = this.db.tables.snapshot_grades.filter((g) => !ids.has(g.snapshot_id));
      for (const gc of this.db.tables.grade_changes) {
        if (ids.has(gc.previous_snapshot_id)) gc.previous_snapshot_id = null;
        if (ids.has(gc.current_snapshot_id)) gc.current_snapshot_id = null;
      }
    }
    if (this.table === "app_users") {
      const ids = new Set(borradas.map((r) => r.id));
      this.db.tables.student_credentials = this.db.tables.student_credentials.filter((c) => !ids.has(c.user_id));
    }
    return { data: borradas.map((r) => project(r, this.columns)), error: null };
  }
}

function createFakeSupabase() {
  const db = {
    tables: Object.fromEntries(Object.keys(TABLES).map((t) => [t, []])),
    calls: [],
    failures: [],
    // Hace fallar la siguiente operación `op` sobre `table`.
    failNext(table, op, code = "XX000") {
      db.failures.push({ table, op, code });
    },
    takeFailure(table, op) {
      const i = db.failures.findIndex((f) => f.table === table && f.op === op);
      return i === -1 ? null : db.failures.splice(i, 1)[0];
    },
  };
  db.client = {
    from(table) {
      if (!TABLES[table]) throw new Error(`Tabla desconocida en el fake: ${table}`);
      return new Query(db, table);
    },
  };
  return db;
}

module.exports = { createFakeSupabase };
