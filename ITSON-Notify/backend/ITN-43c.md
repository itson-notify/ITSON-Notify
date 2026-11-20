# ITN-43c — autorización opcional de tareas de Classroom

Rama `feature/ITN-43c-autorizacion-tareas` (desde `main` con ITN-43, ITN-43b y 017).
Cambios sin commit. No se desplegó, no se aplicaron migraciones y no se tocó Railway,
Supabase ni Google Cloud.

## Qué cambia y qué no

* El login (`GET /auth/google`) sigue pidiendo solo `GOOGLE_OAUTH_SCOPES`
  (`classroom.courses.readonly`). `GOOGLE_OAUTH_SCOPES` no cambia.
* El alumno puede activar, desde Ajustes, el permiso
  `https://www.googleapis.com/auth/classroom.coursework.me.readonly` (`CLASSROOM_WORK_SCOPE`)
  mediante autorización incremental. Si lo rechaza, todo sigue igual.
* La sync de ITN-43b no cambia: ya lee y guarda tareas solo cuando el scope guardado
  (y el del token renovado, si Google lo informa) incluye `CLASSROOM_WORK_SCOPE`.
* Todo depende de `CLASSROOM_TASKS_AUTH_ENABLED` (default `false`).

Respecto a `ITN-43-OAUTH-SCOPE-01.md`: se mantiene la comparación literal de scopes, sin
aliases ni normalización `student-submissions.me.readonly` → `coursework.me.readonly`. Si
Google devolviera solo el nombre alterno, la activación responde `?tareas=rechazada` y no
cambia nada (ver «Riesgos»).

## Bandera `CLASSROOM_TASKS_AUTH_ENABLED`

| Valor | Efecto |
| --- | --- |
| ausente, `false`, `0` | `GET /auth/google/tasks` y `DELETE /api/classroom/tasks-authorization` → 404. `GET /api/classroom/tasks-authorization` → `{ enabled: false, granted: false, needsRelink: false }`; la UI no muestra la tarjeta. El login es idéntico a hoy. |
| `true`, `1` | Rutas activas. El login añade `include_granted_scopes=true` (mismo scope solicitado) para que un re-login conserve las tareas ya activadas. |
| otro | El arranque falla con `CLASSROOM_TASKS_AUTH_ENABLED (booleano inválido)`. |

## Flujo

1. **`GET /auth/google/tasks`** (navegación desde Ajustes). Requiere bandera, OAuth
   configurado, sesión válida (`google_app_sessions`) y grant activo del mismo
   `user_id`/`google_id` con el scope de cursos y sin `needs_relink` (si no, 409
   `classroom_requiere_autorizacion`). Rechaza `Origin` distinto del frontend y las
   navegaciones `Sec-Fetch-Site: cross-site` cuyo `Referer` no sea el frontend (403).
   Redirige a Google pidiendo **solo** `CLASSROOM_WORK_SCOPE` (+ `openid email profile`
   para verificar la identidad), `include_granted_scopes=true`, PKCE S256, `state` =
   `nonce`, `access_type=offline`, `prompt=consent` y `login_hint` = google_id de la sesión.
2. **Callback** — se reusa `/auth/google/callback` (sin URI nueva en Google Cloud). El modo
   tareas no viene de la URL: va dentro del valor de state que genera el servidor y sella
   con AES-256-GCM (`GOOGLE_AUTH_SECRET`, propósito `google-state`) en la cookie HttpOnly
   `itn41_google_state`, junto con `state`, verificador PKCE, caducidad (10 min), `userId`,
   `googleId` y el hash de la sesión. El cliente no puede leerlo ni alterarlo; un `mode=`
   en la query se ignora. Un login nuevo sobreescribe esa cookie, así que solo hay un flujo
   pendiente a la vez.
3. En modo tareas el callback:
   * valida el state como el login (cookie, coincidencia y caducidad; si no, 400);
   * exige que la sesión actual sea la misma que inició el flujo (si no, `?tareas=error`);
   * `?error=` de Google → `?tareas=rechazada`, sin intercambiar código;
   * intercambia el código con PKCE y verifica el ID token (firma, claims, nonce);
   * `sub` distinto del `google_id` de la sesión → `?tareas=cuenta_distinta`; los tokens se
     descartan sin persistir nada;
   * scope devuelto sin `CLASSROOM_WORK_SCOPE` (consentimiento parcial) → `?tareas=rechazada`;
   * refresh token nuevo cuyo scope no incluya cursos → `?tareas=error` (no se sustituye el
     token del login por uno que no lee cursos);
   * si todo va bien: si las tareas no estaban activas pone `coursework_baseline_at = null`
     en los cursos del alumno (la primera sync con tareas será baseline silencioso), y
     después une los scopes (`guardado ∪ devuelto ∪ CLASSROOM_WORK_SCOPE`) en
     `google_authorizations`. Si Google manda refresh token se guarda cifrado y
     `status = active`; si no, se conserva el anterior. El access token nunca se persiste.
     → `?tareas=ok`.
   * No crea sesión nueva. Cualquier excepción → `?tareas=error`, sin cambios parciales en
     el grant (la limpieza de baseline previa es inocua: sin el scope no hay tareas).
4. **`GET /api/classroom/tasks-authorization`** (sesión) → `{ enabled, granted, needsRelink }`.
   `granted` = scope guardado con `CLASSROOM_WORK_SCOPE` y sin `needs_relink`.
5. **`DELETE /api/classroom/tasks-authorization`** (sesión + `Origin` exacto, como el resto de
   escrituras de `/api`) → 204. Quita `CLASSROOM_WORK_SCOPE` del scope guardado (conserva
   cursos y el refresh token), borra `classroom_task_events` y `classroom_coursework` del
   alumno y pone `coursework_baseline_at = null` en sus cursos. Solo afecta a
   `req.student.userId`.
   * **Regla de autorización (con y sin 018):** antes de tocar nada debe existir la fila
     `google_authorizations` con `user_id` **y** `google_id` de la sesión, **sea cual sea su
     `status`**. Un grant en `needs_relink` **sí** puede desactivar: el alumno debe poder
     borrar sus datos aunque su token esté roto. Si la fila no existe (otro `google_id` o sin
     autorización) responde **409 `classroom_requiere_autorizacion`** (el mismo error de
     Classroom que usan `/auth/google/tasks` y Materias) y no borra ni actualiza nada. Los
     borrados siguen restringidos a `user_id`.
   * Con la migración **018** aplicada usa `disable_classroom_tasks(user_id, google_id)`:
     una transacción con el mismo candado que `sync_classroom` (`app_users FOR UPDATE`) más
     `FOR UPDATE` sobre el grant `(user_id, google_id)`. Sin grant lanza
     `classroom_authorization_required` (42501), que la ruta traduce a 409. Otro 42501 (p. ej.
     falta de permiso de infraestructura) sigue siendo 500.
   * Sin la 018 (PostgREST `PGRST202` / `42883`) primero lee el grant `(user_id, google_id)`
     (cualquier `status`; si no existe → 409 sin escribir) y luego hace los pasos en este orden: scope →
     eventos → tareas → baseline. Cada paso es idempotente; si uno falla responde 500 y
     repetir el DELETE completa la limpieza. Cualquier otro error de la función → 500 sin
     borrar nada.
   * No revoca el grant en Google: la revocación de Google es de todo el grant y tiraría
     también el login. Por eso el login (`saveGoogleAuthorization`) ya **no** guarda el
     scope de tareas que Google devuelva por autorización incremental si el alumno no lo
     tenía activo (o si el propio `GOOGLE_OAUTH_SCOPES` no lo pide). La decisión del
     alumno en Ajustes manda.

## Revocación y recuperación

* Si Google rechaza el refresh token (`invalid_grant`), sigue el flujo existente de ITN-42:
  `status = needs_relink` (o borrado del grant antes de la 014). El login no se cae.
* Con `needs_relink`, la tarjeta muestra «Vuelve a autorizar Google Classroom» y el botón
  **Volver a autorizar**, que lanza el login normal desde Ajustes (`/auth/google?from=settings`).
  Ese login guarda un refresh token nuevo y vuelve a `active`. Con la bandera encendida pide
  `include_granted_scopes=true`: si Google aún conserva el permiso de tareas, sigue activo;
  si no (lo normal tras una revocación), la tarjeta queda en «No activadas» y el alumno pulsa
  **Activar** otra vez. Esa reactivación limpia la baseline: no se notifica en bloque lo
  publicado mientras estuvo inactivo.
* Si el alumno quita el acceso desde su cuenta de Google, el próximo refresh da
  `invalid_grant` y se aplica lo anterior.

## Frontend (Ajustes)

Sección «Tareas de Classroom», solo si `enabled` y Classroom conectado:
* No activadas → botón **Activar** (navega a `/auth/google/tasks`).
* Activadas → enlace **Desactivar** con diálogo de confirmación; tras el DELETE, «No activadas».
* `needsRelink` → **Volver a autorizar**.
* Al volver con `?tareas=ok|rechazada|cuenta_distinta|error` abre Ajustes, muestra un aviso y
  limpia la URL. El estado se vuelve a leer del backend; el parámetro solo elige el texto.
* Mismo `Section`/`SettingRow` que el resto de Ajustes (modo móvil igual). En mock no aparece.

## Google Cloud (Julián)

1. **Pantalla de consentimiento OAuth → Permisos de datos (Data access / Scopes):** agregar
   `https://www.googleapis.com/auth/classroom.coursework.me.readonly` al mismo cliente OAuth
   que ya usa el login. Es un scope sensible: si la app está **En producción** con usuarios
   externos, Google exige verificación de la app para ese scope (justificación de uso y,
   posiblemente, video de demostración); mientras no esté verificada, los usuarios verán la
   advertencia de «app no verificada» y aplica el límite de usuarios de apps sin verificar.
   Si está en **Testing**, solo las cuentas de la lista de usuarios de prueba pueden
   autorizar (y sus refresh tokens caducan a los 7 días).
2. Confirmar que **Google Classroom API** sigue habilitada en el proyecto (ya lo está para cursos).
3. **No** hace falta una URI de redirección nueva: se reusa
   `…/auth/google/callback`, que ya está registrada. Tampoco cambia el origen JavaScript.
4. Si el dominio de ITSON (Workspace) controla el acceso de apps de terceros, el
   administrador de Workspace debe permitir el cliente OAuth con ese scope; si no, Google
   devolverá `access_denied` / `admin_policy_enforced` y la UI mostrará «rechazada».

## Railway (backend)

* `CLASSROOM_TASKS_AUTH_ENABLED=true` cuando se quiera exponer la función. Dejarla en `false`
  (o sin definir) hasta tener 017 aplicada y el scope en la pantalla de consentimiento.
* No cambiar `GOOGLE_OAUTH_SCOPES` (sigue solo con `classroom.courses.readonly`).
* No hay variables nuevas en el frontend.

## Migraciones

* **017 obligatoria antes de encender la bandera.** Si falta `coursework_baseline_at`, la
  activación falla con `?tareas=error` y no amplía el scope (evita notificaciones en bloque).
* **018 propuesta, sin aplicar:** `database/migrations/018_disable_classroom_tasks.sql`
  (`disable_classroom_tasks(uuid, text)`, `security invoker`, `execute` solo para
  `service_role`). Opcional: el backend funciona sin ella (pasos en orden seguro) y la
  usa automáticamente cuando existe. Validada contra `postgres:16` desechable sin red:
  `node scripts/verify-classroom-sync-sql.cjs --docker postgres:16` (016+017+018 en una
  transacción y reaplicable, limpieza, aislamiento, candado compartido con una sync
  concurrente en ambos órdenes, `service_role` + invoker, y la regla de autorización:
  otro `google_id` y sin grant → 42501 sin cambios; `needs_relink` y activa → limpian).
  Pruebas SQL: `backend/tests/sql/classroomTasksDisable.sql` y `classroomTasksDisableAuth.sql`.

## Riesgos conocidos

* **Carrera con una sync en curso.** Si una sync leyó tareas de Google antes del DELETE y
  llama a `sync_classroom` después, puede volver a escribir tareas (la 018 lo serializa con
  el candado de `app_users`, pero `sync_classroom` no comprueba el scope y no se cambió por
  alcance). Efecto: filas residuales que la sync ya no actualiza; la siguiente activación
  limpia la baseline, así que no hay avisos en bloque. Un nuevo DELETE las borra.
* **Nombre alterno del scope** (`student-submissions.me.readonly`): sigue la decisión del
  ADR — no se normaliza; la activación respondería «rechazada» hasta confirmarlo.
* El `login_hint` solo preselecciona la cuenta; la verificación real es el `sub` del ID token.

## Pruebas

* `backend/tests/routes/classroomTasksAuth.test.js` (32): bandera apagada, sesión, origen,
  `needs_relink`, URL de autorización (solo tareas, incremental, PKCE, nonce), state
  inválido, `mode` falsificado en la query, rechazo, permisos parciales, cuenta distinta,
  sesión distinta, concesión correcta (scopes unidos, refresh token nuevo cifrado, sin
  access token, baseline limpia, sin sesión nueva), refresh token conservado, refresh
  token sin cursos, sin 017, bandera apagada a mitad del flujo, GET de estado, DELETE (con
  y sin 018, orden, aislamiento de otro alumno, error de la función; regla de
  autorización del respaldo y de la 018: otro `google_id` y sin grant → 409 sin escribir,
  `needs_relink` y activa → limpian, 42501 de infraestructura → 500), reactivación y
  decisión del alumno en re-login. Ningún log contiene tokens, código, scopes ni títulos.
* `backend/tests/config/env.test.js`: parseo de la bandera.
* `frontend/tests/classroomTasks.test.cjs` (14): cliente, mock, mensajes, tarjeta (oculta,
  no activadas, activadas, revocada), retorno `?tareas=…`, Activar, Desactivar con
  confirmación (éxito y fallo) y fallo de la API de estado.
