# Stack Final — ITSON Notify

##  Backend
- **Node.js + Express**  
- Corriendo como servicio en **Railway**.  
- **Justificación:** el equipo ya trabaja en **JavaScript**, lo que permite compartir tipos y lógica con el frontend (React/Vue). Además, **Playwright** tiene soporte nativo y maduro en Node.

##  RPA / Scraping
- **Playwright** como *worker/proceso separado* en Railway.  
- Ventaja: al estar en la misma plataforma que el backend, mantiene sesión persistente sin el problema de “contenedor limpio cada vez” que ocurría con GitHub Actions.  
- Configuración de **usage limit en Railway** para controlar costos.

##  Base de Datos
- **Supabase (Postgres)**  
- Incluye **Auth listo** para un futuro login institucional de alumnos.  
- PostgreSQL soporta **schemas separados**, ideal para organizar notificaciones por fuente (portal académico, Moodle, correo, etc.).

##  Credenciales de estudiantes (ITN-36)
- **Flujo:** captura → cifrado en el backend (AES-256-GCM) → `student_credentials` en Supabase → el worker pide el secreto a `POST /internal/credentials/get`.
- Se guarda el token de iVirtual y el refresh token de Classroom, no contraseñas. `ivirtual_password` es solo un último recurso previsto en el esquema.
- La llave maestra (`CREDENTIALS_ENCRYPTION_KEY`) vive **solo en el backend**. El worker nunca recibe la llave ni accede a la base.
- Generación, rotación con `key_version` y procedimiento si la llave se compromete: [backend/README.md](../../backend/README.md#credenciales-de-los-estudiantes-itn-36).

---

##  Justificación General
- **Node/Express sobre FastAPI**:  
  - Familiaridad del equipo con JavaScript.  
  - Simplifica compartir lógica entre backend y frontend.  
  - Playwright nació en Node, con soporte más maduro que en Python.  
- **Postgres vía Supabase**:  
  - Escalabilidad y robustez.  
  - Auth integrado para crecimiento futuro.  
  - Organización clara de datos por origen de notificaciones.  
- **Railway**: despliegue ágil, sesiones persistentes y control de gasto.
