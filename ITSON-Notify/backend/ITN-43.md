# ITN-43 — sincronización Classroom

Responsable: Julián. Rama `feature/ITN-43-classroom-sync-01`, creada previamente
en este worktree limpio y verificada contra `origin/main` actualizado:
`ee249af58e603c1ef3c0482f504bafea7af91bc8`.
Este documento sustituye para ITN-43 las notas históricas de ITN-59 sobre
ausencia de cron, persistencia y soporte del scope de tareas.

## Contrato interno

Se conserva `x-api-key` antes del parseo JSON y `Cache-Control: no-store`.
`GET /internal/classroom/active` continúa enumerando solo autorizaciones activas.

`POST /internal/classroom/read`:

* `{ userId, googleId }` o `sync: false`: conserva la proyección ITN-59
  `{ courses: [{ id, coursework: [{ id, dueDate?, dueTime? }] }] }`.
* `{ userId, googleId, sync: true }`: lee todas las páginas con la identidad
  autorizada, valida los metadatos y persiste una transacción por alumno.
  Respuesta: `{ sync: { courses, coursework, newTasks } }`, conteos enteros.
  `userId` debe ser UUID; `googleId` e IDs externos son cadenas opacas limitadas.
  No acepta snapshots del worker: cualquier campo adicional del body se ignora.

Nombres y títulos se guardan exclusivamente dentro del backend. La lista blanca
de persistencia incluye nombre/sección/estado/link del curso y título/tipo/estado/
vencimiento/link/fechas de origen de la tarea. No almacena descripciones,
materiales, creadores, correos, tokens ni objetos Google completos. Links solo
HTTPS de `classroom.google.com`, sin credenciales. Fechas y horas se validan,
incluidos días imposibles y pertenencia `courseId`. Duplicados exactos de páginas
se colapsan; duplicados contradictorios abortan antes de escribir.

`/read` sin sync conserva ITN-59: solo exige `courses.readonly` en el grant
almacenado y en la renovación cuando Google devuelve `scope`. `sync: true` exige
además `classroom.coursework.me.readonly` en ambas comprobaciones. Esto no concede
permisos en Google: el proveedor puede rechazar la lectura de tareas con 403.
La consulta de cursos ITN-42 sigue requiriendo solo `courses.readonly`.
Se reutilizan el cifrado, renovación, paginación y manejo de revocación de ITN-59.
No se entrega ningún token al worker.

Errores públicos: 400 entrada inválida; 401 llave interna; 409 identidad ausente,
revocada o `needs_relink`; 403 scopes insuficientes; 502 datos Google inválidos;
503 proveedor no disponible o migración/RPC faltante; 500 persistencia/local.
No se devuelven errores externos ni resultados parciales. `invalid_grant`
persiste `needs_relink` como antes; las cuentas marcadas no se vuelven a renovar.

## Persistencia y baseline

`016_classroom_sync.sql` añade la función `sync_classroom` y la bandeja
`classroom_task_events`. Requiere 006, 008 y 014; 015 de calendario queda intacta.
No se ejecutan migraciones al arrancar. Función `SECURITY INVOKER`, ejecución
solo por `service_role`, `search_path` explícito; bandeja con RLS y sin políticas
de alumno. No se modifican las tablas ni las claves de 006.
016 no incluye `BEGIN/COMMIT`: la herramienta que la aplica debe envolver el
archivo completo en una transacción. En una aplicación manual también se debe
abrir/cerrar esa transacción externamente para conservar atomicidad y `SET LOCAL`.

La RPC bloquea el `app_user`, vuelve a comprobar y bloquea la autorización
activa del par usuario/identidad antes de escribir. Serializa escritores del
mismo alumno, incluso sin cursos previos. Un fallo revierte cursos, tareas y
eventos de ese alumno; los otros alumnos continúan.

* Curso: `(user_id, external_course_id)`. Insertar un curso establece su baseline,
  tanto en la primera corrida como si se descubre después. Sus tareas iniciales
  no generan eventos. Un curso inicialmente vacío también queda establecido.
* Tarea: `(course_id, external_coursework_id)`. Solo una inserción nueva en un
  curso conocido genera `classroom.task.created` cuando está `PUBLISHED`.
  No se decide por proximidad de timestamps. El rol estudiante de Google lee
  tareas publicadas; esta implementación no detecta transiciones de borrador
  a publicado para cuentas docentes.
  Si un borrador ya está persistido y luego se publica con el mismo ID, se
  actualiza su estado, pero no se garantiza un evento nuevo: la detección actual
  corresponde a inserciones de actividades publicadas en cursos conocidos.
* `first_seen_at` usa el default de 006 al insertar y jamás se incluye en updates.
  `last_seen_at` y `updated_at` usan un instante del servidor tomado después del
  bloqueo. Las tareas ausentes se conservan con su última observación anterior.
* El `user_id` de las tareas deriva del propietario, nunca del payload Google.
  La bandeja tiene UNIQUE en `coursework_id`; un evento por tarea persistida.
  Repetir el snapshot, perder una respuesta HTTP o solapar dos escritores no
  duplica filas ni eventos. Un reinicio tras commit deja el evento pendiente.

## Cron y notificaciones ITN-50/44

`classroom-fase.js` reutiliza el consumidor HTTP `rpa/google-classroom` sin
importaciones hacia backend ni acceso directo a Supabase/Google.
Orden: iVirtual, ITSON API, Classroom, calendario. Cada fase conserva su
aislamiento; calendario mantiene su semántica no crítica. Classroom se habilita
solo con `CLASSROOM_SYNC_ENABLED=true`; por defecto no hace consultas.
`RPA_PAUSADO=true` también la omite. Solo registra conteos, sin alertas ni
metadatos académicos. Deduplica cuentas enumeradas, omite 409 sin reintentos,
continúa tras fallos individuales y detiene llamadas ante 401. Solo el 403 con
el código fijo del backend `classroom_sin_permisos` se cuenta como omitido;
un 403 desconocido/malformado y 500/503 son fallos. El cliente devuelve únicamente
un indicador booleano de permisos insuficientes, sin propagar cuerpos de error.
Su fallo afecta
el código final sin impedir calendario. Timeout HTTP sync: 120 segundos,
configurable en la fábrica; no reintenta automáticamente.

Integración ITN-50/44 **preparada, sin despacho**. Contrato persistido:
`classroom_task_events(id, user_id, coursework_id, event_type, created_at,
delivered_at)`. Los eventos nacen con `delivered_at = NULL`. No se llama a
`notificationService`, correo ni push desde esta fase.

El adaptador futuro debe reclamar pendientes con exclusión concurrente, usar
`id` como clave estable de deduplicación por canal y obtener contexto mediante
joins de evento/tarea/curso verificando el mismo `user_id`. Mapear curso a
`subjectName`, tarea a `itemLabel`, `due_at` a `dueAt`; resolver el destinatario
desde `app_users` usando el propietario. No fabricar filas de `grade_changes`
ni reutilizar sus FKs para Classroom. Marcar `delivered_at` solo después de la
entrega durable por los canales requeridos; los fallos deben seguir pendientes.
Los módulos existentes de compañeros no se reescriben. La garantía actual es
un evento de detección por tarea; el envío idempotente por canal es trabajo del
adaptador ITN-50/44.

## OAuth pendiente antes de demo

Se amplía únicamente la lista permitida del código con
`https://www.googleapis.com/auth/classroom.coursework.me.readonly`.
Se sigue exigiendo `classroom.courses.readonly` y rechazando scopes de escritura
o ajenos. El callback comprueba todos los scopes configurados antes de guardar
la autorización; un consentimiento incompleto no crea/reemplaza el grant.

El responsable debe revisar/configurar el scope de tareas en Google Cloud y en
`GOOGLE_OAUTH_SCOPES` del backend, obtener consentimiento nuevo individual y
verificar vigencia antes de la demo. Un token anterior no gana permisos por
cambiar código/configuración. Una cuenta `needs_relink` requiere refresh token
nuevo. No se cambiaron credenciales, consentimiento, audiencia ni Google Cloud.

Referencias oficiales revisadas: [scopes y visibilidad de courseWork.list](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork/list)
y [vencimiento en UTC](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork).
`dueDate` sin `dueTime` se guarda como 23:59 UTC, según el contrato Google;
equivale a las **16:59 del mismo día en America/Hermosillo (UTC−7)**, no a las
23:59 locales. Por ejemplo, `2026-11-20` se persiste como
`2026-11-20T23:59:00.000Z` y se presenta como 20 de noviembre, 16:59 en Hermosillo.
Se conserva la semántica Google, sin añadir siete horas para forzar fin de día
local. Sin fecha se guarda NULL. Se conserva precisión de milisegundos para vencimiento.

## Validación offline reproducible

Desde backend:

```sh
node --require ./tests/helpers/offlineNetwork.cjs --test
node scripts/verify-classroom-sync-sql.cjs "C:/Program Files/PostgreSQL/18/bin"
```

Desde automation:

```sh
node --require ../backend/tests/helpers/offlineNetwork.cjs --test
```

El preload bloquea transportes externos; fixtures y credenciales son sintéticos.
El script SQL no acepta URL de conexión: crea un clúster PostgreSQL propio,
puerto loopback efímero, aplica 006/008/014; prueba rollback explícito y por error
de 016 dentro de transacciones externas, luego la aplica y repite, ejecuta fixtures y
dos escritores concurrentes, detiene el servidor y elimina el directorio creado.
Necesita binarios PostgreSQL locales y permiso para iniciar un proceso local.
En Windows usa archivos para stdout/stderr del daemon, evitando heredar pipes.
No usa la instalación de datos del servicio PostgreSQL del equipo.

Los empaquetados prueban backend sin automation y automation sin backend,
health local, cron pausado y fase Classroom activa con cliente sintético.
Las regresiones incluyen OAuth, ITN-42, vistas persistidas de cursos/tareas,
iVirtual, ITSON API, calendario, notificaciones y correo por alumno.

## Revisión y publicación controlada

1. Revisar diff y SQL de 016; comprobar contrato, aislamiento y permisos.
   Repetir suites y prueba SQL. Crear commit local únicamente tras certificación.
2. En una sesión operativa autorizada, revisar estado de 006/008/014 y aplicar
   016 manualmente primero en un entorno de prueba. Verificar RLS, grants,
   unicidad, función y recarga de caché PostgREST antes de habilitar el worker.
3. Publicar primero backend, mantener Classroom deshabilitado, coordinar nuevo
   consentimiento y revisar TTL/timeouts del proxy para lecturas paginadas.
4. Tras autorización independiente, habilitar un ensayo controlado con cuentas
   aprobadas y canales de notificación desactivados; verificar baseline sin eventos
   y un evento ante una tarea nueva. Luego habilitar cron mediante su flag.
5. Integrar/certificar el adaptador ITN-50/44 antes de habilitar entregas reales.
   Detener esta fase quitando el flag; preservar datos y bandeja para no perder
   deduplicación. No borrar cursos/tareas para reiniciar: restablece baselines y
   puede perder detecciones pendientes.

Riesgos pendientes: migración no aplicada a Supabase; consentimiento/usuarios
reales y cuotas Google no verificados; atomicidad de la persistencia no implica
un snapshot transaccional del proveedor durante paginación; un curso sin acceso
aborta la lectura completa del alumno y se intentará en la próxima corrida.
Un timeout del worker/proxy puede ocurrir mientras backend termina el commit;
la repetición es idempotente. No se ha certificado envío real de ITN-50/44.
No se garantiza detectar una tarea creada y eliminada entre dos consultas.

No se ejecutó sincronización en producción, migración Supabase, correo/push real,
commit, push, PR, merge ni despliegue.

## Certificación local — 2026-11-18

**READY_FOR_COMMIT** del código y pruebas offline; no habilita producción.
Backend: **593/593**. Automation: **269/269**. Cero fallos, canceladas u omitidas.
`git diff --check`: correcto. PostgreSQL local **18.6**:
`CLASSROOM_SQL_OK`, incluida reaplicación de 016, rollback y escritores
concurrentes; no se verificó contra PostgreSQL 15 ni PostgREST real.

En el desarrollo se corrigieron dos problemas del ejecutor local: Node descubría
el script SQL por su prefijo `test-` (se renombró a `verify-`), y Windows heredaba
pipes al arrancar PostgreSQL (se cambiaron por archivos). El pase final de todas
las suites y la prueba SQL ya incorpora ambas correcciones. Los clústeres locales
creados durante las pruebas se detuvieron y sus directorios se eliminaron.

Archivos nuevos (rutas relativas a `ITSON-Notify/`):

* `automation/schedulers/classroom-fase.js`
* `automation/schedulers/test/classroom-fase.test.js`
* `backend/ITN-43.md`
* `backend/scripts/verify-classroom-sync-sql.cjs`
* `backend/src/services/classroomSync.js`
* `backend/tests/services/classroomSync.test.js`
* `backend/tests/sql/classroomSync.sql`
* `database/migrations/016_classroom_sync.sql`

Archivos existentes modificados:

* `automation/rpa/google-classroom/README.md`
* `automation/rpa/google-classroom/client.js`
* `automation/rpa/google-classroom/test/packaging.test.js`
* `automation/schedulers/extraccion-cron.js`
* `backend/src/config/env.js`
* `backend/src/routes/authGoogle.js`
* `backend/src/routes/classroomInternal.js`
* `backend/src/services/classroomCourses.js`
* `backend/src/services/googleAuthService.js`
* `backend/tests/app/classroomInternal.test.js`
* `backend/tests/config/env.test.js`

## ITN-43-REVIEW-REMEDIATION-02

Revisión real consultada mediante GitHub: `pedrizquierdo`, estado
`CHANGES_REQUESTED`, enviada `2026-11-19T06:28:50Z` en
[PR #37](https://github.com/itson-notify/ITSON-Notify/pull/37).
Preflight: rama solicitada, HEAD `e13678f424055912026047381e0857d43f85efd4`,
únicamente los dos archivos OAuth locales esperados sin seguimiento.

* R1: 401 se contabiliza antes de cualquier otro indicador y detiene solicitudes.
  403 solo se omite si el cliente reconoce `classroom_sin_permisos`; los cuerpos
  desconocidos/malformados permanecen como fallo. 409 y relink sin un estado HTTP
  contradictorio se omiten. 500/503 y estados desconocidos no se ocultan aunque
  aparezcan indicadores contradictorios de éxito/relink. Se mantiene el aislamiento.
* R2: se restaura validación local de cursos para lectura ITN-59; exclusivamente
  `sync === true` requiere A y persiste. Se prueban grants y renovaciones en ambos
  modos, sin cambios a la lista permitida ni equivalencias OAuth.
* R3: se documenta 23:59 UTC = 16:59 America/Hermosillo del mismo día, sin cambiar
  la semántica del proveedor.
* R4: 006/007 documentan aplicación manual en SQL Editor; no hay runner/configuración
  automática versionada en el código/documentación pertinente ni workflows.
  Pedro confirma que la herramienta operativa envuelve la transacción, pero su
  nombre/versión no consta en el repositorio. 016 delega la transacción al ejecutor;
  el verificador local reproduce ese contrato sin afirmar acceso al servicio real.
* R5: se explicita la limitación de eventos al pasar de borrador existente a publicado.

Certificación final local: backend **612/612**, automation **273/273**, cero
fallos, canceladas u omitidas; ambas suites con bloqueo de red externa, incluidos
empaquetados aislados, OAuth, ITN-42/59, privacidad y fuentes existentes.
Selección focalizada previa: backend **149/149**, automation Classroom **13/13**.
SQL PostgreSQL local 18.6: `CLASSROOM_SQL_OK`; rollback externo explícito y por
error de 016 sin tabla/función residual, aplicación, reaplicación y regresiones
de baseline/dedup/idempotencia/aislamiento/RLS/concurrencia correctas.
`CLASSROOM_SYNC_ENABLED` sigue sin habilitar por defecto; no se cambia su configuración.

Los dos archivos OAuth se conservan e integran tras revisión manual y escaneo de
patrones de credenciales, con fixtures sintéticos. El informe original se mantiene
como evidencia histórica con un seguimiento añadido; las pruebas de tareas se
adaptan al modo sync. El HTTP 200 de Playground informado por el usuario no
certifica qué scope técnico se concedió. Permanece HOLD para normalizar A/B.

Archivos de este commit de remediación, relativos a `ITSON-Notify/`:

* `automation/rpa/google-classroom/README.md`
* `automation/rpa/google-classroom/client.js`
* `automation/schedulers/classroom-fase.js`
* `automation/schedulers/test/classroom-fase.test.js`
* `backend/ITN-43.md`
* `backend/ITN-43-OAUTH-SCOPE-01.md` (investigación local integrada)
* `backend/scripts/verify-classroom-sync-sql.cjs`
* `backend/src/services/classroomCourses.js`
* `backend/tests/app/classroomInternal.test.js`
* `backend/tests/services/classroomOAuthScopes.test.js` (pruebas locales integradas)
* `database/migrations/016_classroom_sync.sql`

Dictamen de remediación: **PASS local**. No constituye aprobación de Pedro ni
habilitación de producción. No se envían mensajes, notificaciones ni cambios a
GitHub; sin push, PR nuevo, merge, despliegue, migración remota o cambios a Railway,
Supabase/Google Cloud. El commit local separado queda autorizado tras certificación.
