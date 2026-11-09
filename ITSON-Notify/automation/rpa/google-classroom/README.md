# Google Classroom — ITN-49

Cliente CommonJS pequeño para Node.js 22, sin dependencias adicionales. Sigue
el patrón de fixtures sintéticos y `node:test` de `../ivirtual-api/`.

```js
const { createClassroomClient } = require('./automation/rpa/google-classroom');
const client = createClassroomClient();
// accessToken lo entrega el llamador; no usar un refresh token.
const courses = await client.listCourses(accessToken);
const tasks = await client.listCourseWork(accessToken, courseId);
```

Ambos métodos devuelven un arreglo de recursos REST sin transformar, después de
recorrer todas las páginas. No filtran por estudiante ni detectan tareas nuevas.
No hay integración con backend, OAuth, almacenamiento, Supabase ni notificaciones.
No se persiste ni se registra el token; se envía exclusivamente en Authorization.
Los errores nunca incluyen cuerpos del servidor, URLs, credenciales o causas externas.
Los recursos devueltos pueden contener datos personales en uso real: corresponde
al llamador evitar registrarlos. Los fixtures de este módulo son inventados.

Solo se permiten GET a endpoints fijos oficiales y se rechazan redirecciones.
`listCourses` usa `/v1/courses`; `listCourseWork` usa
`/v1/courses/{courseId}/courseWork` (PUBLISHED por defecto según Google).
Los parámetros opcionales por llamada son `{ pageSize: 100 }`.
La fábrica admite `{ fetchImpl, timeoutMs: 15000, maxPages: 1000 }`.
El timeout cubre petición y lectura del cuerpo con fetch nativo. Un transporte
inyectado debe respetar la señal. Ciclos o exceso de páginas fallan sin devolver
resultados parciales. Se aceptan listas omitidas como vacías; se validan el
envoltorio, los identificadores y los nombres/títulos mínimos de los recursos.
No es un validador completo de todos los campos opcionales de Google.

`ClassroomError` expone `code`, `status` y `retryable`: 401 es
`UNAUTHENTICATED` (incluye token vencido o inválido; no se puede distinguir solo
por HTTP), 403 es `PERMISSION_DENIED`, y otros estados son `HTTP_ERROR`.
429, 5xx, errores de red y timeout son recuperables; el cliente no reintenta ni
renueva tokens automáticamente. También existen `MALFORMED_RESPONSE`,
`PAGINATION_LOOP` y `PAGE_LIMIT_EXCEEDED`. Entradas inválidas lanzan TypeError.

## Permisos y dependencia pendiente

Cursos requiere `classroom.courses.readonly`; tareas del estudiante requiere
además `classroom.coursework.me.readonly`. El OAuth actual del repositorio
ITN-40/41 concede solo el primero. Por eso su token puede consultar cursos pero
recibir 403 al consultar tareas. La ampliación del consentimiento queda fuera
de ITN-49; no se cambia la configuración OAuth ni se solicitan permisos de escritura.
`READONLY_SCOPES` documenta ambos permisos; no modifica los permisos de un token.

Referencias oficiales consultadas el 2026-11-09:
- [courses.list](https://developers.google.com/workspace/classroom/reference/rest/v1/courses/list)
- [courses.courseWork.list](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork/list)

## Verificación offline

Desde `ITSON-Notify/automation`:

```sh
node --test rpa/google-classroom/test/classroom.test.js
node --test
```

Las pruebas inyectan respuestas HTTP en memoria y bloquean fetch global.
No necesitan variables de entorno, cuentas Google ni servicios reales.
