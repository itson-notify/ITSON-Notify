// ITN-48 - Tablas de Classroom (migración 006) en el Supabase simulado. Datos
// inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createFakeSupabase } = require("./fakeSupabase");

const ON_CONFLICT = { onConflict: "course_id,external_coursework_id" };

const tarea = (extra) => ({
  user_id: "u-1",
  course_id: "c-1",
  external_coursework_id: "t-1",
  title: "Tarea 1",
  ...extra,
});

describe("fakeSupabase: student_credentials (007)", () => {
  const CONFLICTO = { onConflict: "user_id,portal,kind" };

  async function preparar() {
    const db = createFakeSupabase();
    const { data } = await db.client.from("app_users").upsert({ email: "a@example.test" }, { onConflict: "email" }).select("id").single();
    const fila = (extra) => ({
      user_id: data.id,
      portal: "ivirtual",
      kind: "ivirtual_token",
      ciphertext: "\\x01",
      nonce: `\\x${"00".repeat(12)}`,
      auth_tag: `\\x${"00".repeat(16)}`,
      ...extra,
    });
    return { db, fila, userId: data.id, tabla: () => db.client.from("student_credentials") };
  }

  test("aplica los defaults al insertar y respeta el unique", async () => {
    const { db, fila, tabla } = await preparar();
    const { data, error } = await tabla().upsert(fila(), CONFLICTO).select().single();
    assert.equal(error, null);
    assert.equal(data.status, "active");
    assert.equal(data.key_version, 1);
    assert.equal(data.last_validated_at, null);
    assert.ok(data.updated_at);

    await tabla().upsert(fila({ ciphertext: "\\x02" }), CONFLICTO);
    assert.equal(db.tables.student_credentials.length, 1);
    assert.equal(db.tables.student_credentials[0].ciphertext, "\\x02");

    const llaveMal = await tabla().upsert(fila(), { onConflict: "user_id,portal" });
    assert.equal(llaveMal.error.code, "42P10");
  });

  test("rechaza lo mismo que los checks de la 007", async () => {
    const { fila, tabla } = await preparar();
    const invalidas = {
      portal: { portal: "otro" },
      kind: { kind: "otro" },
      status: { status: "otro" },
      portal_y_kind_cruzados: { portal: "google_classroom", kind: "ivirtual_token" },
      nonce_corto: { nonce: "\\x00" },
      tag_corto: { auth_tag: "\\x00" },
      buffer_sin_codificar: { ciphertext: Buffer.from("x") },
      base64: { nonce: Buffer.alloc(12).toString("base64") },
    };
    for (const [nombre, extra] of Object.entries(invalidas)) {
      const { error } = await tabla().upsert(fila(extra), CONFLICTO);
      assert.equal(error?.code, "23514", nombre);
    }
    const sinCifrado = await tabla().upsert(fila({ ciphertext: null }), CONFLICTO);
    assert.equal(sinCifrado.error.code, "23502");
  });

  test("un update tampoco puede dejar un status inválido", async () => {
    const { fila, tabla, userId } = await preparar();
    await tabla().upsert(fila(), CONFLICTO);
    const { error } = await tabla().update({ status: "otro" }).eq("user_id", userId);
    assert.equal(error.code, "23514");
  });

  test("exige un usuario existente y borrarlo borra sus credenciales", async () => {
    const { db, fila, tabla, userId } = await preparar();
    const huerfana = await tabla().upsert(fila({ user_id: "no-existe" }), CONFLICTO);
    assert.equal(huerfana.error.code, "23503");

    await tabla().upsert(fila(), CONFLICTO);
    await db.client.from("app_users").delete().eq("id", userId);
    assert.equal(db.tables.student_credentials.length, 0);
  });
});

describe("fakeSupabase: tablas de Classroom", () => {
  test("el upsert de la misma tarea dos veces no duplica y conserva first_seen_at", async () => {
    const db = createFakeSupabase();
    const tabla = () => db.client.from("classroom_coursework");

    const primera = await tabla().upsert(tarea(), ON_CONFLICT).select().single();
    assert.equal(primera.error, null);
    assert.ok(primera.data.first_seen_at);

    const segunda = await tabla()
      .upsert(tarea({ title: "Tarea 1 editada", last_seen_at: "2030-01-01T00:00:00.000Z" }), ON_CONFLICT)
      .select()
      .single();
    assert.equal(segunda.error, null);

    assert.equal(db.tables.classroom_coursework.length, 1);
    assert.equal(segunda.data.id, primera.data.id);
    assert.equal(segunda.data.title, "Tarea 1 editada");
    assert.equal(segunda.data.first_seen_at, primera.data.first_seen_at);
    assert.equal(segunda.data.last_seen_at, "2030-01-01T00:00:00.000Z");
  });

  test("el mismo id externo en dos cursos se guarda como dos filas", async () => {
    const db = createFakeSupabase();
    const tabla = () => db.client.from("classroom_coursework");

    await tabla().upsert(tarea({ course_id: "c-1" }), ON_CONFLICT);
    await tabla().upsert(tarea({ course_id: "c-2" }), ON_CONFLICT);

    assert.equal(db.tables.classroom_coursework.length, 2);
  });

  test("rechaza llaves mal escritas y columnas not null vacías, como Postgres", async () => {
    const db = createFakeSupabase();

    const llave = await db.client.from("classroom_coursework").upsert(tarea(), { onConflict: "external_coursework_id" });
    assert.equal(llave.error.code, "42P10");

    const sinNombre = await db.client
      .from("classroom_courses")
      .upsert({ user_id: "u-1", external_course_id: "c-1" }, { onConflict: "user_id,external_course_id" });
    assert.equal(sinNombre.error.code, "23502");
  });
});
