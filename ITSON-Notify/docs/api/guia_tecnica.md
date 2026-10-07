#  Guía técnica — Google Classroom API

##  Autenticación y Scopes (OAuth)
Para interactuar con la API de Google Classroom se requiere **OAuth 2.0**.  
Scopes más relevantes:
- `https://www.googleapis.com/auth/classroom.courses.readonly` → leer cursos.
- `https://www.googleapis.com/auth/classroom.announcements` → crear y gestionar anuncios.
- `https://www.googleapis.com/auth/classroom.coursework.me` → gestionar tareas del usuario autenticado.
- `https://www.googleapis.com/auth/classroom.coursework.students` → gestionar tareas de estudiantes.

 Se recomienda solicitar el menor scope posible para cumplir con la funcionalidad, siguiendo el principio de **mínimos privilegios**.

---

##  Endpoints principales
- **Cursos**:  
  - `GET https://classroom.googleapis.com/v1/courses` → listar cursos.
- **Anuncios**:  
  - `GET https://classroom.googleapis.com/v1/courses/{courseId}/announcements`  
  - `POST https://classroom.googleapis.com/v1/courses/{courseId}/announcements`
- **Tareas (CourseWork)**:  
  - `GET https://classroom.googleapis.com/v1/courses/{courseId}/courseWork`  
  - `POST https://classroom.googleapis.com/v1/courses/{courseId}/courseWork`

>  **Nota:** `{courseId}` es el identificador único del curso en Google Classroom.  
> Se obtiene al listar cursos con el endpoint `GET /courses`.

---

##  Límites de la API
- **Rate limits**: alrededor de **1,000 requests por usuario por cada 100 segundos** y **100 requests por proyecto por cada 100 segundos** (puede variar según el recurso).  
- Se recomienda implementar **exponencial backoff** en caso de errores `429 Too Many Requests`.

---

##  Ejemplo mínimo — Anuncio
**Request:**
```http
POST https://classroom.googleapis.com/v1/courses/123456789/announcements
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json

{
  "text": "Recordatorio: entregar proyecto final antes del viernes."
}
