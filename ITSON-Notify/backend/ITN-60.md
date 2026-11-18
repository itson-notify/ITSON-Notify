# ITN-60: calendario académico ITSON (backend y worker)

Implementación local para revisión. No se aplican migraciones ni se modifica
Railway desde esta rama.

> **Aviso:** el origen es una API del portal institucional **sin documentación
> oficial**. Su uso desde un servidor debe confirmarse con IT, igual que ITN-34 e
> ITN-64.

## Origen elegido y por qué

Se revisaron los dos orígenes conocidos (solo GET, timeout de 15 s, desde una red
mexicana, 18 de noviembre de 2026):

| | Portal institucional (`www.itson.mx`) | `webapi.itson.edu.mx` |
|---|---|---|
| Llamadas | `GET .../CalendarPublic/CalendarBySite?numPage=100&siteId=3` (lista) y `GET .../CalendarPublic/GetEvent/{tokenEncriptor}` (detalle) | `GET /api/Calendario?id=6` |
| Lista | arreglo de `{ calendarId: number, title, dateStr: "05 Dic", ispublished: bool, startTimeStr, url, tokenEncriptor }` | arreglo de `{ Titulo, DescrLarga, Fecha, FechaFin, FechaDia, FechafinDia, Mes }` |
| Detalle | `{ calendarID, title, startTime: "2026-12-05T08:00:00", endTime, eventDescription (HTML), categorys: [..], campus: [..], location, imagePath, documents }` | (no aplica) |
| Eventos | 26 próximos (19 nov 2026 a 18 ene 2027) | 5, solo del mes en curso |
| Contenido | Calendario académico real (categoría «Registro Escolar»): último día de clases, evaluaciones finales, solicitud de examen no ordinario, selección de carga académica, seguro facultativo, vacaciones, reanudación de labores, primer día de clases, por nivel (licenciatura, posgrado, tetramestral). Además algunos eventos del portal (categoría «Académicos»: conferencias, ceremonias) | Fechas administrativas del mes (retiro de documentación, suspensión de labores, inscripción de nuevo ingreso) |
| Acceso | Público, sin matrícula ni sesión | Público, sin matrícula ni sesión |

Ninguna respuesta trae datos personales.

**Decisión: el portal institucional (`www.itson.mx`).** Cumple los tres criterios
en orden: (1) trae el calendario académico real con fechas exactas en el detalle,
(2) es público, (3) no está en `webapi.itson.edu.mx`, que no responde desde Railway.
`webapi` solo trae el mes en curso y menos eventos.

Notas del origen:

- La lista no trae año ni hora utilizables; por eso se pide el detalle de cada
  evento (`GetEvent/{tokenEncriptor}`; con el `calendarId` numérico responde 400).
- `numPage` se comporta de forma irregular (con 1 o 2 devuelve 1 o 2 eventos; de 26
  a 100 devuelve los 26 próximos; con 200 o más devuelve 50 que incluyen eventos
  pasados). Se usa `numPage=100`, que da los próximos.
- `startTime`/`endTime` vienen sin zona, en hora local de Hermosillo.
- El portal no marca «todo el día». Las fechas académicas terminan a las 23:59, así
  que un evento que termina a las 23:59 se toma como de días completos.
- Riesgo pendiente: **no se probó desde Railway**. `www.itson.mx` es otro servidor
  que `webapi.itson.edu.mx`, pero conviene confirmarlo con una corrida
  (`npm run sync:calendar`) desde el worker antes del viernes. Si no respondiera,
  la fase solo deja una línea en el log y el worker sigue igual.

## Piezas

- `database/migrations/015_calendar_events.sql`: tabla `calendar_events`
  (`external_id` único, `title`, `description`, `starts_at`, `ends_at`,
  `all_day`, `category`, `created_at`, `updated_at`). Aditiva e idempotente, RLS
  sin políticas, solo `service_role`. **Aplicar a mano** antes de desplegar.
- `automation/services/itsonCalendarClient.js`: lee la lista y los detalles (timeout
  15 s; 2 reintentos con espera 1 s y 2 s solo ante red, timeout o 5xx; un 4xx no se
  reintenta) y normaliza cada evento. Un detalle que falla se cuenta y se sigue.
- `automation/schedulers/calendario-fase.js`: tercera fase del cron, después de
  iVirtual y la API de ITSON. Manda los eventos leídos a
  `POST /internal/calendar-events`. **Nunca** sale con 1 ni manda `ALERTA_RPA`:
  cualquier falla queda en el log y la corrida sigue.
- `backend/src/routes/calendarInternal.js`: `POST /internal/calendar-events`.
- `GET /api/calendar` en `backend/src/routes/studentApi.js`.

## Cómo correr la sincronización

- **Automática:** con el cron del worker (cada 2 horas). Para no consultar el portal
  en cada corrida, la fase solo corre cuando la hora de Hermosillo es 7, 13 o 19.
  Variable opcional `CALENDARIO_HORAS` del worker: lista de horas 0-23 separadas por
  coma, o `*` para cada corrida. `RPA_PAUSADO=true` también la pausa.
- **A mano**, a cualquier hora (usa `BACKEND_URL` e `INTERNAL_API_KEY` del `.env`):

  ```bash
  npm --prefix automation run sync:calendar
  ```

Correrla dos veces no crea filas: el backend hace upsert por `external_id` y solo
reescribe las filas que cambiaron (por eso `updated_at` dice cuándo cambió el
evento, no cuándo se sincronizó). Los eventos que el portal deja de publicar (los ya
pasados) se conservan.

## `POST /internal/calendar-events` (worker → backend)

Exige `x-api-key` con `INTERNAL_API_KEY`, igual que el resto de `/internal`.

```json
{
  "events": [
    {
      "externalId": "137",
      "title": "Profesional asociado y licenciatura: último día de clases",
      "description": "Último día de clases.",
      "startsAt": "2026-12-05T00:00:00-07:00",
      "endsAt": "2026-12-05T23:59:59-07:00",
      "allDay": true,
      "category": "Registro Escolar"
    }
  ]
}
```

- 1 a 500 eventos; `externalId` numérico como texto; fechas ISO 8601 **con zona**;
  sin campos extra. Si `allDay` es true, el backend fija 00:00:00 y 23:59:59 hora
  de Hermosillo de los días de inicio y fin.
- El lote se guarda en **un solo upsert** (todo o nada). Un evento inválido rechaza
  el lote completo con 400 `{ error: "payload_invalido", issues: [{ path, code }] }`.
- 200 `{ received, inserted, updated, unchanged }`.
- 503 `{ error: "calendario_migracion_requerida" }` si falta la 015; 500
  `{ error: "error_interno" }` ante otra falla de la base.

## `GET /api/calendar?from=AAAA-MM-DD&to=AAAA-MM-DD` (frontend, ITN-61)

Con la sesión de Google, como el resto de `/api` (cookie; 401
`{ error: "no_autenticado" }` sin sesión). `Cache-Control: no-store`. El calendario
es el mismo para todos los alumnos.

**Parámetros:** `from` y `to` son días en **hora de Hermosillo**, ambos inclusive
(`from` = desde las 00:00 de ese día; `to` = hasta las 23:59:59.999). Se devuelven
los eventos cuyo rango **intersecta** `[from, to]`, ordenados por inicio (máximo
1000).

**Errores 400** `{ error, message }`:

| `error` | Cuándo |
|---|---|
| `fechas_requeridas` | falta `from` o `to` |
| `fecha_invalida` | no es `AAAA-MM-DD`, no existe (p. ej. `2026-02-30`) o se repite el parámetro |
| `rango_invertido` | `from` > `to` |
| `rango_demasiado_amplio` | más de 366 días |

503 `{ error: "calendario_no_disponible" }` si la migración 015 aún no está aplicada.

**Respuesta 200:**

```json
{
  "events": [
    {
      "id": "6f0c2c1e-0000-4000-8000-000000000000",
      "title": "Profesional asociado y licenciatura: último día de clases",
      "description": "Último día de clases.",
      "startsAt": "2026-12-05T07:00:00.000Z",
      "endsAt": "2026-12-06T06:59:59.000Z",
      "startDate": "2026-12-05",
      "endDate": "2026-12-05",
      "allDay": true,
      "category": "Registro Escolar",
      "updatedAt": "2026-11-18T14:00:03.000Z"
    }
  ]
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string (uuid) | estable entre sincronizaciones |
| `title` | string | |
| `description` | string \| null | texto plano (sin HTML); puede tener `\n` |
| `startsAt`, `endsAt` | string ISO 8601 UTC | igual que `dueAt` en `/api/courses/:id/items`. Para mostrar la hora: `toLocaleString("es-MX", { timeZone: "America/Hermosillo" })` |
| `startDate`, `endDate` | string `AAAA-MM-DD` | día de inicio y de fin **en Hermosillo**. Para eventos de todo el día, usar estos y no `startsAt`/`endsAt`, así no se corren de día en otra zona |
| `allDay` | boolean | true: días completos, sin hora que mostrar |
| `category` | string \| null | del portal, p. ej. `Registro Escolar` (calendario académico) o `Académicos` (eventos del portal) |
| `updatedAt` | string ISO 8601 UTC | cuándo cambió el evento por última vez |

## Pruebas

Sin red, con fixtures inventados:

- `backend/tests/app/calendar.test.js`: upsert sin duplicados al correr dos veces,
  lote todo o nada, 401 sin llave o sin sesión, validación de `from`/`to`,
  intersección y orden, eventos de todo el día y horas en Hermosillo.
- `automation/services/test/itsonCalendarClient.test.js`: parseo del portal,
  reintentos ante red/timeout/5xx, 4xx sin reintento, un detalle fallido no tumba
  la corrida.
- `automation/schedulers/test/calendario-fase.test.js`: la fase siempre sale con 0,
  no alerta, y no cambia el código de salida de `arrancar()`.
