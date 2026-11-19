# ITN-43-OAUTH-SCOPE-01 — diagnóstico

**HOLD para aceptar/normalizar el scope alternativo.** Diagnóstico y pruebas
offline completados; no se demuestra equivalencia ni autorización real del endpoint.
Se conserva íntegra la validación actual. No se crea commit.

Inicio verificado: rama `feature/ITN-43-classroom-sync-01`, HEAD
`e13678f424055912026047381e0857d43f85efd4`, worktree limpio.
Sin subagentes, dependencias nuevas, servicios reales, migraciones o publicación.

## Evidencia oficial consultada

Nombres completos:

* A: `https://www.googleapis.com/auth/classroom.coursework.me.readonly`
* B: `https://www.googleapis.com/auth/classroom.student-submissions.me.readonly`

1. [OAuth Google, examinar permisos concedidos](https://developers.google.com/identity/protocols/oauth2)
   explica que solicitud y respuesta pueden tener nombres distintos y que una API
   puede mapear varios nombres a un permiso. Su ejemplo trata de People/Contacts;
   no confirma esta pareja Classroom.
2. [Guía de scopes Classroom](https://developers.google.com/workspace/classroom/guides/auth)
   enumera A y B por separado con la misma descripción de lectura. No afirma
   que sean aliases ni define equivalencia de endpoints. La página consultada
   indica actualización 2026-09-03.
3. [courses.courseWork.list](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork/list#authorization-scopes)
   enumera A entre los permisos admitidos, pero no B. La página consultada indica
   actualización 2026-06-10. También enumera permisos docentes y de escritura;
   ninguno se propone como sustituto en ITN-43.
4. [Catálogo OAuth de Google](https://developers.google.com/identity/protocols/oauth2/scopes#classroom)
   también enumera los dos nombres por separado. No documenta su mapeo mutuo.

Las búsquedas oficiales focalizadas de alias/equivalencia no aportaron una
declaración explícita. El Discovery público no pudo abrirse con el navegador de
consulta; no se usa como evidencia. La ausencia de documentación encontrada no
prueba que la equivalencia no exista.

La observación Cloud/Playground procede del contexto del usuario. No se
inspeccionaron capturas, códigos ni credenciales. Una etiqueta de interfaz tampoco
demuestra qué `scope` devuelve realmente el endpoint de tokens.

## Auditoría del contrato actual

Referencias relativas a `backend/`; líneas del HEAD verificado:

| Punto | Comportamiento y consecuencia si solo llega B en lugar de A |
| --- | --- |
| `src/config/env.js:21`, `:66` | Lista permitida: cursos + A. Configurar B, escritura o permisos docentes falla al cargar configuración. |
| `src/services/googleAuthService.js:19` | `generateAuthUrl` conserva los scopes recibidos, añade openid/email/profile y no normaliza. Su default solicita solo cursos; la ruta usa `oauth.scopes`. La función aislada no es la lista permitida. |
| `src/routes/authGoogle.js:67` | Solicita exactamente la configuración cargada; no fuerza A si la configuración aún contiene únicamente cursos. |
| `src/services/googleAuthService.js:35` | El intercambio de código devuelve `tokens.scope` sin transformación. Verifica presencia de ID/access token; no decide equivalencia de scopes. |
| `src/routes/authGoogle.js:89` | Tras validar firma/claims/nonce, pasa `tokens.scope` y `oauth.scopes` a persistencia. El parámetro `scope` del query del callback no decide el permiso. |
| `src/services/googleAuthService.js:106` | `saveGoogleAuthorization` exige membresía literal de cada scope configurado, además del de cursos. Con A requerido y solo B recibido lanza `classroom_scope_not_granted` antes de consultar/escribir la BD. La ruta redirige con `classroom=error`, sin crear sesión/grant. |
| `src/services/classroomCourses.js:68`, `:79` | `getAccessToken` comprueba usuario/Google ID/estado y los scopes almacenados literalmente. Su default solo exige cursos; con requisitos de tareas rechaza B con 403 antes de descifrar/renovar. |
| `src/services/classroomCourses.js:84` | El refresh token es opaco, no contiene scopes interpretables localmente. Se valida el sobre cifrado y el token no vacío; se renueva en backend. `invalid_grant` sigue su manejo de `needs_relink`. Un nombre de scope distinto no equivale a revocación. |
| `src/services/classroomCourses.js:56` | Si la renovación devuelve `scope`, exige los requisitos literales. Guardado A + renovación solo B produce 403 antes de consultar Classroom. Si omite `scope`, conserva como referencia los permisos almacenados; no infiere un alias. |
| `src/services/classroomCourses.js:121` | `readForWorker`, tanto lectura como sync, exige cursos + A al llamar a `getAccessToken`; por ello puede fallar en cualquiera de las dos comprobaciones anteriores. |

Detalle: si OAuth está configurado solo para cursos, cursos+B satisface ese
callback y puede guardarse sin normalizar. Ello no certifica tareas: el lector
posterior exige A y falla. La consulta ITN-42 de cursos sigue funcionando con su
permiso propio; no debe usarse como prueba del permiso de tareas.

## Causa probable y decisión

Hipótesis compatible con lo observado: Google presenta/devuelve una denominación
canónica distinta y las comparaciones literales de ITN-43 la rechazan. No está
demostrado que B sea ese nombre canónico para A, ni que el cambio ocurra en la
respuesta de tokens en vez de solo en la UI. También cabe consentimiento parcial
o discrepancia documental. No atribuir el 403 automáticamente a `invalid_grant`.

Aceptar B sin prueba permitiría registrar como autorizado un grant incapaz de
leer tareas, retrasar el fallo hasta la API y ocultar consentimiento insuficiente.
No se demuestra una escalada concreta, pero sí se debilitaría una condición de
autorización sin evidencia de capacidad. No ampliar a coincidencias por prefijo,
descripciones, escritura, permisos docentes ni otros scopes.

**Corrección ahora: ninguna en runtime.** Si se confirma oficialmente la pareja,
proponer un mapa exacto B -> A para evaluar permisos concedidos en callback,
grant almacenado y renovación, compartido por las tres comprobaciones. Mantener
A como permiso solicitado documentado; conservar el scope original como evidencia
y no añadir aliases genéricos. La validación de scopes configurados puede seguir
solicitando únicamente A. Añadir positivos A/B y negativos de escritura/docentes
antes de cambiar ese contrato. Esto es una propuesta condicional, no implementada.

## Pruebas sintéticas y offline

Único archivo ejecutable añadido:
`tests/services/classroomOAuthScopes.test.js` — **13/13** pruebas nuevas.
Contiene consentimiento configurado, intercambio con ambos nombres, callback
completo con JWT firmado sintético, query de scopes que no sustituye al endpoint
de tokens, almacenamiento, renovación, omisión de scope en refresh y rechazo de
escritura/permisos docentes como sustitutos. Verifica que el fallo de scopes no
marque `needs_relink`, no persista ni consulte tareas y no filtre fixtures en logs.

Selección ejecutada: **143/143**, cero fallos, omitidas o canceladas:

```sh
node --require ./tests/helpers/offlineNetwork.cjs --test tests/services/classroomOAuthScopes.test.js tests/services/googleAuthService.test.js tests/routes/authGoogle.test.js tests/config/env.test.js tests/app/classroomInternal.test.js tests/app/classroomCourses.test.js
```

Todos los transportes Google son inyectados con fixtures; el preload bloquea red
externa. Las pruebas caracterizan decisiones locales, no prueban comportamiento
real de Google. No se cambió ningún módulo de runtime, automation o ITN-50/44.
El otro archivo añadido es este informe. Cambios deliberadamente sin commit.

## Próximo paso seguro, pendiente de sesión autorizada

1. Usar cuenta y cliente de prueba aprobados, cron aún apagado y consentimiento
   nuevo; nunca reutilizar códigos de capturas. Comparar solo las cadenas de scopes
   solicitadas y devueltas por el endpoint de tokens, sin capturar credenciales.
   Evitar grants anteriores acumulados que incluyan A, escritura o permisos docentes
   y harían inconcluso un resultado positivo con B.
2. Desde una herramienta segura bajo control del operador, con el access token
   únicamente en memoria y en `Authorization: Bearer`, ejecutar contra un curso
   conocido donde la cuenta sea estudiante:

   `GET https://classroom.googleapis.com/v1/courses/{courseId}/courseWork?pageSize=1&fields=courseWork(id),nextPageToken`

   No usar `studentSubmissions.list` como sustituto. Desactivar registro de headers,
   cuerpos y trazas; no copiar tokens a chat, archivos, argumentos de shell ni URL.
   Descartar IDs/respuesta y registrar solo estado HTTP, resultado booleano y scopes.
3. Comprobar los scopes efectivos del token en un mecanismo seguro aprobado:
   B presente y A/permisos amplios ausentes para que el ensayo aísle la hipótesis.
   HTTP 200, aunque vacío, acredita esa llamada; una tarea publicada conocida
   permite además verificar el resultado funcional sin conservar sus datos.
   Un 403 puede deberse a permisos de cuenta/curso, por lo que requiere un control
   equivalente con A y la misma identidad/curso cuando sea posible.
4. Repetir la llamada tras renovar para certificar también el camino de refresh.
   Si el resultado difiere de la referencia oficial, solicitar aclaración a soporte
   Google sobre A/B y este endpoint. Un éxito experimental aislado no demuestra
   equivalencia universal ni autoriza por sí solo normalizar producción.

No se ejecutó esta prueba real en esta sesión ni se obtuvieron credenciales.

## Seguimiento — ITN-43-REVIEW-REMEDIATION-02

Se conserva arriba el diagnóstico histórico del HEAD `e13678f`, sin cambios de
sus conclusiones sobre equivalencia. El usuario informa un HTTP 200 real en
Playground, pero sin certificar el identificador técnico del scope concedido:
no demuestra que B sustituya a A. No se incorporaron capturas ni credenciales.

R2 restaura ITN-59: `readForWorker` sin sync solo exige cursos; con `sync: true`
mantiene cursos + A. Los casos sintéticos de requisitos de tareas de este archivo
se adaptan explícitamente al modo sync, conservando rechazo de B, escritura y
permisos docentes como sustitutos. El callback y la validación de renovación no
normalizan scopes. El proveedor sigue decidiendo si una llamada sin A tiene acceso.

Los archivos de esta investigación fueron revisados: únicamente fixtures
sintéticos y referencias públicas, sin secretos reales. Se integran con la
remediación autorizada; la indicación anterior «sin commit» corresponde a la
entrega histórica, no al commit separado solicitado para esta remediación.
