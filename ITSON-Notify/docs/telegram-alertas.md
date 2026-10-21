# Alertas del equipo por Telegram (ITN-38)

Un bot de Telegram manda avisos **técnicos** a un grupo privado del equipo, por ejemplo cuando falla una corrida
del RPA (ITN-39). No es el canal de notificaciones a alumnos: aquí nunca van calificaciones ni datos personales.

| Pieza | Archivo |
|-------|---------|
| Módulo `sendTeamAlert(texto)` | [`automation/monitors/telegram.js`](../automation/monitors/telegram.js) |
| Script de prueba | [`automation/scripts/enviar-alerta-prueba.js`](../automation/scripts/enviar-alerta-prueba.js) |
| Pruebas | [`automation/monitors/test/telegram.test.js`](../automation/monitors/test/telegram.test.js) |
| Nombres de variables | [`.env.example`](../.env.example) |

El módulo está en `automation/` porque el servicio `worker-rpa` de Railway solo despliega esa carpeta
(`rootDirectory`) y es el que detecta los fallos. Si después el backend (ITN-27) también necesita alertar, puede
copiar el archivo (no tiene dependencias) o llamarlo con sus propias variables.

## 1. Crear el bot con @BotFather

1. En Telegram, abre [@BotFather](https://t.me/BotFather) (verifica la palomita azul) y manda `/newbot`.
2. Nombre visible: por ejemplo `ITSON Notify Alertas`.
3. Usuario: debe terminar en `bot`, por ejemplo `itson_notify_alertas_bot`.
4. BotFather responde con el **token** (`<números>:<letras>`). Es la contraseña del bot:
   - Guárdalo directo en Railway o en tu `.env` local. No lo pegues en el chat del equipo, en Jira, en
     commits ni en capturas de pantalla.
   - Si se filtra: en @BotFather, `/mybots` → el bot → **API Token** → **Revoke current token**, y actualiza la
     variable.

## 2. Crear el grupo y agregar el bot

1. Crea un grupo nuevo, por ejemplo `ITSON Notify · Alertas`, con los integrantes de la sección 5.
2. Agrega el bot por su usuario (`@itson_notify_alertas_bot`). Para mandar mensajes no necesita ser admin.
3. Recomendado: en @BotFather, `/setjoingroups` → el bot → **Disable**, para que nadie más pueda meterlo a otros
   grupos.

## 3. Obtener el chat_id con getUpdates

1. En el grupo manda un mensaje que el bot pueda ver. Por el *privacy mode* el bot solo recibe comandos y
   menciones, así que escribe `/start@itson_notify_alertas_bot` (o menciónalo).
2. En tu terminal (no en el navegador de una computadora compartida), con el token en una variable para que no
   quede en el historial:

   ```bash
   read -s TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN
   ```

   ```bash
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" | grep -o '"chat":{"id":-[0-9]*'
   ```

3. El número negativo es el `chat_id` (los supergrupos empiezan con `-100`). Si sale vacío, manda otro
   `/start@...` en el grupo y repite.
4. Si después conviertes el grupo en supergrupo (pasa solo al activar algunas opciones), el `chat_id` cambia:
   repite este paso.

## 4. Variables de entorno

| Variable | Valor | Dónde |
|----------|-------|-------|
| `TELEGRAM_BOT_TOKEN` | Token de @BotFather. Secreto. | Railway → `worker-rpa` → Variables (marcar *sealed*) y `.env` local |
| `TELEGRAM_CHAT_ID` | `chat_id` del grupo, con el signo `-` | Igual |

Si falta alguna, `sendTeamAlert` no envía nada, deja una línea en el log y el proceso sigue normal.

Para probar, con las variables en `ITSON-Notify/.env`:

```bash
npm run alert:test
```

Debe llegar al grupo un mensaje fijo de prueba y la terminal debe decir `Mensaje de prueba enviado`. Si no:

| Log | Causa |
|-----|-------|
| `sin_configuracion` | Falta alguna de las dos variables. |
| `Telegram respondió 401: Unauthorized` | Token mal copiado o revocado. |
| `Telegram respondió 400: Bad Request: chat not found` | `chat_id` incorrecto, o sin el `-`. |
| `Telegram respondió 403: ... bot was kicked` | Sacaron al bot del grupo. |

## 5. Quiénes reciben las alertas

Recibe las alertas **quien esté en el grupo**. No hay lista en el código: para agregar o quitar a alguien se
cambia el grupo y se actualiza esta tabla.

| Integrante | Rol en el equipo | Atiende | Admin del grupo |
|------------|------------------|---------|-----------------|
| _(nombre)_ | _(p. ej. RPA / worker)_ | Fallos del RPA, `cambio_password`, credenciales | Sí |
| _(nombre)_ | _(p. ej. backend)_ | Errores del backend (cuando exista ITN-27) | No |
| _(nombre)_ | _(p. ej. líder)_ | Respaldo si nadie responde | Sí |

Reglas:

- Solo integrantes activos del equipo. Al salir alguien del proyecto, se le saca del grupo el mismo día.
- Solo los admins agregan miembros (en el grupo: **Permisos** → quitar *Agregar miembros* a los demás).
- Cada quien deja las notificaciones del grupo **activadas**.
- Quien atienda una alerta responde en el hilo (`yo lo veo`) para no duplicar trabajo. Los pasos para
  `cambio_password` y credenciales están en [`deployment/cron-railway.md`](deployment/cron-railway.md).

## 6. Qué se puede enviar

`sendTeamAlert` solo acepta mensajes técnicos cortos (máximo 300 caracteres) y **rechaza** el mensaje completo,
sin enviarlo, si parece llevar:

- Contraseñas o tokens: `password=`, `contraseña:`, `token=`, `P_User=`, `Bearer ...`, JWT, tokens de bot,
  cadenas largas tipo llave.
- Datos de alumnos: correos, matrículas o cualquier número de 6 dígitos o más, CURP.

El log del rechazo dice el motivo pero nunca repite el texto. El filtro es una red de seguridad, no un permiso:
los mensajes se arman solo con datos técnicos (tipo de fallo, fuente, fecha, código HTTP, conteos), por ejemplo
`Extracción detenida: cambio_password (ivirtual-api)`. No incluyas nombres de alumnos ni de materias: el filtro
no puede detectarlos.

## Pendiente

- **ITN-39:** llamar a `sendTeamAlert` desde `notificarFalloCritico` en
  [`automation/monitors/alertas.js`](../automation/monitors/alertas.js) y capturar las variables en Railway.
