# Frontend de ITSON Notify

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # node:test, sin navegador
npm run build
```

## Variables

Van en `frontend/.env` (Vite no lee el `.env` de la raíz). Son públicas: quedan en el bundle, así que nunca pongas
secretos aquí, ni la `INTERNAL_API_KEY`.

| Variable           | Uso                                                                                     | Por defecto             |
| ------------------ | --------------------------------------------------------------------------------------- | ----------------------- |
| `VITE_USE_MOCK`    | Con `true`, usa los datos de `src/services/mockData.ts`. Con cualquier otro valor o sin definir, usa el backend | sin definir (backend)   |
| `VITE_BACKEND_URL` | Origen del backend, sin `/auth/google` ni `/api`                                        | `http://localhost:3000` |

Para cambiarlas hay que reiniciar `npm run dev` y volver a generar el build.

## Probar contra el backend real

1. Aplica en Supabase las migraciones hasta `010_notifications_read_at.sql`.
2. Levanta el backend con `GOOGLE_OAUTH_ENABLED=true` y `FRONTEND_URL=http://localhost:5173` (ver `backend/README.md`).
3. Crea `frontend/.env` con `VITE_BACKEND_URL=http://localhost:3000` y corre `npm run dev`.
4. Entra con Google por el Onboarding. Sin sesión no se puede pasar de ese paso.
5. Si aún no hay notificaciones, siembra algunas con `npm run seed:dev` en el backend.

Abre el frontend en `localhost`, no en `127.0.0.1`: con un host distinto al del backend, el navegador no envía la cookie de
sesión con `SameSite=Lax`.

El correo de Google debe ser el mismo que `ALUMNO_EMAIL` del worker para ver sus notificaciones. Con otro correo, cada uno
queda en su propia fila de `app_users` y la lista sale vacía.

## Qué viene de la API y qué sigue simulado

| Viene de la API                                  | Sigue simulado                                          |
| ------------------------------------------------ | ------------------------------------------------------- |
| Sesión de Google                                 | «Revisar ahora» y la hora de la última revisión         |
| Notificaciones y marcar como leídas              | Ajustes (categorías, canales, horario de silencio)      |
| Correo, estado de Classroom y de la cuenta ITSON | Materias para vigilar cupos                             |
|                                                  | Contraseña de ITSON e ID                                |
|                                                  | Nombre y carrera del perfil                             |

Marcar como no leída es solo local, porque el backend no tiene ese endpoint: al recargar vuelve a leída. Lo mismo pasa con
el «Deshacer» de marcar todas.

Hoy todas las notificaciones son de calificaciones, porque es lo único que registra el backend.
