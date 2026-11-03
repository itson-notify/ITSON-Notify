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
