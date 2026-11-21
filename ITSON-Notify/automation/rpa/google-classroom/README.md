# Google Classroom — consumidor del worker (ITN-59)

La entrada `index.js` exporta `createClassroomWorkerClient`. Consulta el backend
mediante HTTP autenticado; no importa backend ni recibe tokens Google.
La implementación REST Google y sus pruebas de ITN-49 viven en backend.

```js
const { createClassroomWorkerClient } = require('./rpa/google-classroom');
const client = createClassroomWorkerClient({
  baseUrl: process.env.BACKEND_URL,
  apiKey: process.env.INTERNAL_API_KEY,
});
const accounts = await client.listActive();
if (accounts.ok) {
  for (const account of accounts.data.students) {
    const result = await client.read(account);
    // result.needsRelink: omitir esta cuenta sin reintentar.
    // No registrar cuerpos, identificadores ni la llave interna.
  }
}
```

La URL debe ser un origen HTTPS; HTTP solo se admite para localhost/127.0.0.1.
Se rechazan redirecciones. La fábrica permite inyectar `fetchImpl` y
`timeoutMs` (15000 por defecto). No reintenta; los errores no incluyen cuerpos
ni mensajes externos. `listActive` consulta `/internal/classroom/active` y
`read` envía `{ userId, googleId }` a `/internal/classroom/read`.

ITN-43 añade `schedulers/classroom-fase.js` al cron, después de ITSON API y antes
del calendario. Se habilita explícitamente con `CLASSROOM_SYNC_ENABLED=true`;
`RPA_PAUSADO=true` evita cualquier consulta. `client.sync(account)` envía
`{ userId, googleId, sync: true }` al mismo `/read` y recibe únicamente
`{ sync: { courses, coursework, newTasks } }`. Los nombres y títulos permanecen
en backend. La sincronización admite `syncTimeoutMs` (120000 por defecto), sin
reintentos automáticos; `409` y el `403` identificado por el backend como
`classroom_sin_permisos` omiten la cuenta. `401` cuenta como fallo y detiene
solicitudes; `403` desconocido, `500/503` y otros errores siguen siendo fallos.
Los fallos individuales no
interrumpen las demás. Solo se registran conteos.

El backend admite los scopes de lectura `classroom.courses.readonly` y
`classroom.coursework.me.readonly`. La configuración y el nuevo consentimiento
individual siguen pendientes: cambiar código no concede permisos a tokens previos.
Aplicar/revisar manualmente 006, 008, 014 y 016 antes de activar la fase.
No se envían notificaciones: ITN-50/44 debe consumir la bandeja de eventos
persistida en backend. Ver [ITN-43.md](../../../backend/ITN-43.md).

ITN-58f añade la fase no crítica de estado de entrega: tras el sync, solo para las
cuentas cuyo sync reportó tareas (`coursework > 0`; un permiso solo de cursos reporta 0),
`client.submissions(account)` envía `{ userId, googleId }` a
`/internal/classroom/submissions`. El backend lee `studentSubmissions.list`
(`courseWorkId "-"`, `userId "me"`) por curso con tareas y lo guarda con la RPC de la
migración 022; nunca genera eventos ni avisos. El worker solo recibe conteos y registra
conteos y status HTTP. Un fallo por cuenta no detiene las demás; `401`/`404` detienen la
fase. Su resultado nunca cambia el código de salida.

Contrato, migración, privacidad y alta de usuarios:
[ITN-59.md](../../../backend/ITN-59.md).

Pruebas desde automation, con transporte externo bloqueado:

```sh
node --require ../backend/tests/helpers/offlineNetwork.cjs --test rpa/google-classroom/test/worker.test.js rpa/google-classroom/test/packaging.test.js
```

El preload es una protección del ejecutor del monorepo, no una dependencia de
runtime. El test de empaquetado copia automation sin backend ni `.env`, bloquea
la red y cualquier carga desde backend, importa este módulo y arranca el cron
real con `RPA_PAUSADO=true`. No certifica extracción real ni servicios remotos.
