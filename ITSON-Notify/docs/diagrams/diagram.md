# ITSON Notify · Flujo de datos y monitoreo

Diagrama de la arquitectura propuesta: Portal ITSON / Classroom → scraper / RPA → backend → detección de cambios → canal de notificación → usuario.

![Flujo de datos y monitoreo de ITSON Notify: extracción con Playwright o API de Classroom, backend y monitor independiente en Railway, estado por alumno, fuente y registro en Supabase, notificaciones por FCM y email al alumno y alertas por Telegram a administradores.](./ITSON-Notify-diagram.png)

[Abrir o descargar la imagen del diagrama](./ITSON-Notify-diagram.png)

## Componentes y ubicación

| Componente | Tecnología o función | Entorno de ejecución |
| --- | --- | --- |
| Portal ITSON / Classroom | Origen de avisos, tareas y datos académicos | Portal institucional de ITSON y servicios de Google Classroom |
| Scraper / RPA | Playwright para el portal; API para Classroom; entrega datos y reporta actividad y errores | Worker separado en Railway |
| Backend | Node.js + Express; recibe, valida y normaliza los datos; identifica alumno, fuente e ID del registro | Servicio en Railway |
| Detección de cambios | Compara el estado del mismo alumno, fuente e ID del registro; genera avisos para ese alumno cuando hay cambios | Dentro del backend en Railway |
| Base de datos | Supabase (Postgres); almacena el estado previo y actual por alumno, fuente e ID del registro | Supabase |
| Canal de notificación | Push mediante Firebase Cloud Messaging (FCM); email mediante Resend o servidor SMTP; envío solicitado por el backend | Servicios externos de mensajería |
| Usuario | Recibe el aviso y consulta el enlace al origen | Dispositivo del alumno: navegador, aplicación o correo |
| Monitor independiente del RPA | Comprueba errores y última señal de actividad; alerta si el RPA falla o deja de reportar | Otro proceso o servicio en Railway, independiente del proceso RPA |
| Bot de Telegram | Recibe la llamada del monitor a su API y envía alertas de fallo o caída a los administradores | Servicio externo de Telegram |

## Flujo académico

El backend recibe los registros extraídos y la lógica de detección consulta el estado anterior en Supabase para comparar y guardar las actualizaciones.

El estado se separa por **alumno + fuente + ID del registro**. La fuente corresponde al portal ITSON o Classroom; el estado no es global. Cuando hay cambios, se genera un aviso para el alumno correspondiente con un resumen y un enlace al origen, enviado por FCM y/o email.

Si no se detectan cambios, el flujo termina sin enviar avisos.

## Monitoreo del RPA

El RPA reporta actividad y errores a un monitor cuya ejecución es independiente. Este comprueba la última señal de actividad y los errores para detectar fallos o ausencia de actividad, incluso si el proceso RPA se detiene.

Cuando detecta un fallo o caída, el monitor llama a la API del bot de Telegram para alertar al equipo administrador, que revisa y recupera el RPA. Telegram corresponde a esta rama operativa; los avisos académicos al alumno utilizan FCM y email.

Las tecnologías base se describen en [Stack final](../architecture/Stack_final.md). El diagrama representa la arquitectura propuesta.
