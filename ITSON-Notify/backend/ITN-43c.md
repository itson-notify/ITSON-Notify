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
   * si todo va bien llama a `activate_classroom_tasks(user_id, google_id, scope_devuelto,
     refresh_token_cifrado|null)` (018), que en **una transacción** y con el mismo orden de
     candados que `sync_classroom` (`app_users FOR UPDATE` → grant `FOR UPDATE`): exige el grant
     `(user_id, google_id)` con `status = active` y el scope de cursos (si no, 42501
     `classroom_authorization_required`); si las tareas no estaban activas pone
     `coursework_baseline_at = null` en los cursos del alumno (la primera sync con tareas será
     baseline silencioso); une los scopes (`guardado ∪ devuelto ∪ CLASSROOM_WORK_SCOPE`, sin
     duplicados, en orden) y, si Google mandó refresh token, lo guarda (ya cifrado por el
     backend); si no, conserva el anterior. Una sync concurrente espera al commit y nunca ve un
     estado intermedio. El access token nunca se persiste. → `?tareas=ok`.
   * No crea sesión nueva. Cualquier excepción → `?tareas=error` sin cambios (la función
     revierte todo). Sin la 018 → `?tareas=error` con log `migracion_pendiente`, sin escribir
     por otro camino.
4. **`GET /api/classroom/tasks-authorization`** (sesión) → `{ enabled, granted, needsRelink }`.
   `granted` = scope guardado con `CLASSROOM_WORK_SCOPE` y sin `needs_relink`.
5. **`DELETE /api/classroom/tasks-authorization`** (sesión + `Origin` exacto, como el resto de
   escrituras de `/api`) → 204. Quita `CLASSROOM_WORK_SCOPE` del scope guardado (conserva
   cursos y el refresh token), borra `classroom_task_events` y `classroom_coursework` del
   alumno y pone `coursework_baseline_at = null` en sus cursos. Solo afecta a
   `req.student.userId`.
   * **Regla de autorización:** antes de tocar nada debe existir la fila
     `google_authorizations` con `user_id` **y** `google_id` de la sesión, **sea cual sea su
     `status`**. Un grant en `needs_relink` **sí** puede desactivar: el alumno debe poder
     borrar sus datos aunque su token esté roto. Si la fila no existe (otro `google_id` o sin
     autorización) la función lanza `classroom_authorization_required` (42501) y la ruta
     responde **403 `classroom_requiere_autorizacion`** sin borrar ni actualizar nada.
   * Usa **solo** `disable_classroom_tasks(user_id, google_id)` (018): una transacción con el
     mismo candado que `sync_classroom` (`app_users FOR UPDATE`) más `FOR UPDATE` sobre el
     grant `(user_id, google_id)`.
   * Respuestas con código fijo, nunca con el mensaje de Supabase: sin la 018 (PostgREST
     `PGRST202` / `42883`) → **503 `migracion_pendiente`** sin escribir por ningún otro camino
     (ya no hay respaldo sin transacción); 42501 de negocio → **403**; cualquier otro error
     (incluido un 42501 de infraestructura, p. ej. falta de permiso de `service_role`) →
     **500 `error_interno`**.
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

* **017 y 018 obligatorias antes de encender la bandera.** Sin la 018 activar y desactivar
  fallan sin escribir nada (`?tareas=error` / 503 `migracion_pendiente`); ya no hay respaldo
  en JS.
* **018 propuesta, sin aplicar:** `database/migrations/018_classroom_tasks_authorization.sql`
  (`activate_classroom_tasks(uuid, text, text, text)` y `disable_classroom_tasks(uuid, text)`,
  `security invoker`, `search_path` fijo, `execute` solo para `service_role`). Validada contra
  `postgres:16` desechable sin red: `node scripts/verify-classroom-sync-sql.cjs --docker postgres:16`
  (016+017+018 en una transacción y reaplicable; desactivación: limpieza, aislamiento, candado
  compartido con una sync en ambos órdenes, regla de autorización; activación: caso feliz, sin
  autorización usable → 42501 sin cambios, fallo forzado a mitad → rollback completo,
  concurrencia con `sync_classroom` en ambos órdenes y mezclada sin deadlock, permisos).
  Pruebas SQL: `backend/tests/sql/classroomTasksDisable.sql`, `classroomTasksDisableAuth.sql`
  y `classroomTasksActivate.sql`.

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

* `backend/tests/routes/classroomTasksAuth.test.js`: bandera apagada, sesión, origen,
  `needs_relink`, URL de autorización (solo tareas, incremental, PKCE, nonce), state
  inválido, `mode` falsificado en la query, rechazo, permisos parciales, cuenta distinta,
  sesión distinta, concesión correcta (una sola RPC, refresh token cifrado antes de la RPC,
  sin access token, baseline limpia, sin sesión nueva), refresh token conservado, refresh
  token sin cursos, sin 018 / RPC que rechaza o falla → `error` sin escribir, ya activas,
  bandera apagada a mitad del flujo, GET de estado, DELETE (solo RPC, aislamiento, sin 018 →
  503 sin ningún otro acceso a tablas, error → 500 genérico, otro `google_id` y sin grant →
  403, `needs_relink` limpia, 42501 de infraestructura → 500), reactivación y decisión del
  alumno en re-login. Ningún log contiene tokens, código, scopes, títulos ni mensajes de Supabase.
* `backend/tests/services/classroomTasksAuthorization.test.js`: con un cliente que solo tiene
  `rpc()` (cualquier otro acceso lanza) comprueba que no existe camino de escritura alterno
  y el mapeo de errores a 503/403/500.
* `backend/tests/config/env.test.js`: parseo de la bandera.
* `frontend/tests/classroomTasks.test.cjs` (14): cliente, mock, mensajes, tarjeta (oculta,
  no activadas, activadas, revocada), retorno `?tareas=…`, Activar, Desactivar con
  confirmación (éxito y fallo) y fallo de la API de estado.
