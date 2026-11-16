# ITN-59: contrato interno y preparación de demo

Implementación local para revisión. No se aplican migraciones ni se modifican
cuentas o servicios compartidos desde esta rama.

## Configuración

Aplicar manualmente `database/migrations/013_google_authorization_status.sql`
antes de publicar el backend. Añade `google_authorizations.status` con valores
`active` y `needs_relink` (equivalente al estado funcional «needs-relink»).
Conservar las variables OAuth, `GOOGLE_AUTH_SECRET`, Supabase e
`INTERNAL_API_KEY` existentes exclusivamente en backend. El worker recibe solo
la URL HTTPS del backend y `INTERNAL_API_KEY`, mediante su gestor de secretos.
No necesita secretos Google ni acceso directo a Supabase.

Todas las rutas siguientes exigen `x-api-key`; la autenticación ocurre antes
del parseo JSON. Usar TLS y desactivar registros de cuerpos y de este encabezado
en cualquier proxy. La llave interna permite consultar a todos los alumnos;
limitar su distribución al backend y worker.

* `GET /internal/classroom/active`: `{ students: [{ userId, googleId }] }`,
  únicamente autorizaciones activas.
* `POST /internal/classroom/read`: cuerpo `{ userId, googleId }`; devuelve
  `{ courses: [{ id, coursework: [{ id, dueDate?, dueTime? }] }] }`.
  Las fechas conservan la representación de Google; no se convierten de zona.
  Se recorre la paginación existente, sin devolver resultados parciales.
  No incluye nombres, títulos, correos ni tokens.
* 409 exige revinculación: omitir la cuenta, sin reintentos. `invalid_grant`
  persiste `needs_relink`; futuras consultas fallan antes de llamar a Google.
  403 indica permisos insuficientes; 502/503 fallo del proveedor; 500 fallo local.
  Una respuesta 401 de Classroom produce 409, pero no se toma como prueba de
  revocación del refresh token.

El servicio backend conserva su API invocable de ITN-42 y expone
`service.getAccessToken({ userId, googleId })` para reutilización exclusivamente
interna. Nunca publica el resultado de esa función por HTTP.
Un consentimiento con nuevo refresh token reactiva la cuenta; sin token nuevo
conserva su estado. La actualización por `invalid_grant` compara el ciphertext
leído para no bloquear una autorización reemplazada concurrentemente.

## Consumidor automation

```js
const { createClassroomWorkerClient } = require('./rpa/google-classroom');
const client = createClassroomWorkerClient({
  baseUrl: process.env.BACKEND_URL,
  apiKey: process.env.INTERNAL_API_KEY,
});
const accounts = await client.listActive();
// Por cada cuenta activa, el coordinador puede llamar client.read(account).
// Si result.needsRelink es true, omitirla sin reintentar.
```

Esta entrada sustituye al antiguo adaptador local ITN-49 que importaba backend.
Los consumidores del cliente REST Google deben usar la implementación backend.
El cron existente no añade una fase Classroom: su coordinación, persistencia
en `classroom_courses`/`classroom_coursework`, detección y notificaciones quedan
para ITN-43/44. Este cambio entrega el contrato HTTP y el consumidor independiente.

## Vinculación y usuarios de prueba

El responsable del proyecto Google debe dar de alta a cada integrante en la
audiencia de prueba de la pantalla de consentimiento, usando las cuentas
acordadas fuera del repositorio. No registrar correos ni credenciales aquí.
Después, cada integrante abre `/auth/google/` en el backend configurado,
acepta el consentimiento y verifica su sesión en `/auth/google/session`.
Para una cuenta `needs_relink`, repetir el consentimiento con emisión de un
nuevo refresh token. No copiar tokens al worker ni al navegador.

Según la especificación Jira ITN-59, los refresh tokens en modo de prueba
caducan a los siete días: renovar el consentimiento antes de la demo prevista
para el 19 de noviembre y anotar privadamente la fecha de vinculación,
caducidad prevista y responsable. El alta real y la vigencia no se verificaron
en esta sesión, por prohibición de credenciales reales y llamadas a Google.

Pendiente de coordinación: OAuth actual admite únicamente
`classroom.courses.readonly`. Leer tareas requiere además
`classroom.coursework.me.readonly`; hasta ampliar y revisar ese consentimiento,
`/read` puede responder 403 cuando haya cursos. No se amplían scopes en esta rama.
No considerar completado el criterio de demo con datos reales hasta resolverlo.

## Validación offline

Desde backend:
`node --require ./tests/helpers/offlineNetwork.cjs --test`

Específicas:
`node --require ./tests/helpers/offlineNetwork.cjs --test tests/app/classroomInternal.test.js tests/app/classroomCourses.test.js tests/packaging/backendArtifact.test.js`

Desde automation:
`node --require ../backend/tests/helpers/offlineNetwork.cjs --test`
(el preload es una protección del ejecutor de pruebas del monorepo, no una
dependencia del artefacto automation).
Específicas: `node --test rpa/google-classroom/test/*.test.js`.
El empaquetado copia automation sin backend ni `.env`, bloquea dependencias
backend y red, carga el consumidor Classroom y arranca el cron real pausado.
Las pruebas REST Google y fixtures sintéticos se trasladaron al backend.

## Revisión de migración 013

Revisión estática únicamente; no se ejecutó contra ninguna base de datos.
Requiere la tabla de la migración 008 y un rol con permiso ALTER TABLE.
Aplicarla antes del backend: el código nuevo selecciona y actualiza `status`.
La transacción añade una columna NOT NULL con default `active` y CHECK de
los dos estados, sin tocar refresh tokens, filas, grants ni políticas RLS.
El lock timeout de cinco segundos limita la espera por el bloqueo de tabla;
un timeout exige programar otro intento manual, no iniciar el backend a medias.
`IF NOT EXISTS` permite repetirla si ya se aplicó correctamente, pero no valida
una columna preexistente de definición distinta: comprobar tipo, default,
NOT NULL y CHECK antes de aprobar su aplicación en un entorno compartido.
Los registros históricos quedan activos hasta comprobar su autorización.

## Consentimiento pendiente

Antes de habilitar lectura real de tareas, el responsable debe documentar la
necesidad del scope de lectura `classroom.coursework.me.readonly`, actualizar
la lista permitida y sus pruebas, configurar el consentimiento en Google y
pedir a cada integrante que acepte los permisos nuevos. Un token anterior no
adquiere permisos adicionales por cambiar una variable. No solicitar scopes
de escritura. Esta campaña no cambia la lista permitida ni publica OAuth.

Pendientes operativos: aplicación manual de migración, consentimiento de
lectura de tareas, alta de usuarios y ensayo real autorizado. El cron actual
se certifica únicamente en arranque pausado offline, sin extracción real.

## Certificación local — 2026-11-16

Dependencias backend y automation resueltas, incluido supertest. Suites finales
ejecutadas con el preload de bloqueo de red: backend 461/461 y automation
218/218, cero fallos, omitidas o canceladas. Selección específica de Classroom
y empaquetado: backend 83/83; automation 4/4, incluidas en los totales anteriores.
El empaquetado arranca el servidor backend con health local y el cron real
de automation pausado; no requiere la carpeta hermana del otro servicio.

El primer pase de backend falló porque el fixture de éxito omitía `courseId`,
campo obligatorio para el cliente REST existente. Se corrigió el fixture,
sin cambiar código de producción en esta campaña. Se añadieron pruebas de
identidades cruzadas, error al persistir needs_relink, reemplazo concurrente
del refresh token, privacidad de fechas malformadas y autenticación de /active.
Se corrigieron las expectativas del test HTTP y la documentación obsoleta del
antiguo adaptador. Ningún cambio previo fue descartado.

Dictamen: READY_FOR_REVIEW del código y de las pruebas offline. No constituye
habilitación de demo real: siguen pendientes el scope de tareas, consentimiento,
usuarios de prueba y aplicación de la migración. No se ejecutaron llamadas
Google, migraciones, publicación OAuth, push, PR, merge ni despliegues.
