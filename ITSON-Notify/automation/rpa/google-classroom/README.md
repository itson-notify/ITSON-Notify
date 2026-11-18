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

El cron actual no añade una fase Classroom. Persistencia, detección de tareas
y notificaciones quedan fuera de esta integración (ITN-43/44).

El OAuth actual solo admite `classroom.courses.readonly`; la lectura de tareas
necesita también `classroom.coursework.me.readonly`, pendiente de configurar
y obtener nuevo consentimiento. No se amplían permisos en esta rama.

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
