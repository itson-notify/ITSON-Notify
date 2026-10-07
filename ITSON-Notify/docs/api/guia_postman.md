# 📌 Paso a paso en Postman

## 1. Crear un proyecto en Google Cloud

1. Ve a [Google Cloud Console](https://console.cloud.google.com/).
2. Crea un proyecto nuevo o utiliza uno existente.
3. Entra a **APIs & Services → Library**.
4. Busca **Google Classroom API**.
5. Haz clic en **Enable** para activar la API.

---

## 2. Configurar credenciales OAuth

1. Ve a **APIs & Services → Credentials**.
2. Selecciona **Create Credentials**.
3. Crea un **OAuth 2.0 Client ID**.
4. Configura la pantalla de consentimiento de Google.

Google solicitará algunos datos, como:

* Nombre de la aplicación.
* Correo electrónico.
* Correo de soporte.
* Permisos (Scopes) que utilizará la aplicación.

5. Una vez creadas las credenciales, descarga el archivo:

```text
credentials.json
```

Este archivo contiene información como el **Client ID** y el **Client Secret** necesarios para autenticar la aplicación.

>  **Importante:** No compartas el archivo `credentials.json` ni el Client Secret públicamente.

---

## 3. Obtener el Access Token

En **Postman**, realiza los siguientes pasos:

1. Abre la pestaña **Authorization**.
2. En **Type**, selecciona:

```text
OAuth 2.0
```

3. Configura los siguientes valores:

| Configuración        | Valor                                                     |
| -------------------- | --------------------------------------------------------- |
| **Auth URL**         | `https://accounts.google.com/o/oauth2/v2/auth`            |
| **Access Token URL** | `https://oauth2.googleapis.com/token`                     |
| **Client ID**        | El Client ID de `credentials.json`                        |
| **Client Secret**    | El Client Secret de `credentials.json`                    |
| **Scope**            | `https://www.googleapis.com/auth/classroom.announcements` |
| **Grant Type**       | `Authorization Code`                                      |

4. Haz clic en **Get New Access Token**.
5. Inicia sesión con tu cuenta de Google.
6. Autoriza el acceso solicitado.
7. Postman guardará el **Access Token** automáticamente.

---

## 4. Hacer la petición

Una vez obtenido el Access Token, crea una nueva petición en Postman.

### Método

```text
POST
```

### URL

```text
https://classroom.googleapis.com/v1/courses/{courseId}/announcements
```

> Reemplaza `{courseId}` por el ID real del curso de Google Classroom.

Por ejemplo:

```text
https://classroom.googleapis.com/v1/courses/123456789/announcements
```

### Headers

Agrega los siguientes encabezados:

| Key             | Value                   |
| --------------- | ----------------------- |
| `Content-Type`  | `application/json`      |
| `Authorization` | `Bearer <ACCESS_TOKEN>` |

Si configuraste correctamente OAuth 2.0 en Postman, normalmente Postman agregará automáticamente el encabezado `Authorization`.

### Body

Selecciona:

```text
Body → raw → JSON
```

Utiliza el siguiente contenido:

```json
{
  "text": "Recordatorio: entregar proyecto final antes del viernes."
}
```

---

## 5. Ejecutar y revisar la petición

Haz clic en:

```text
Send
```

Si la petición fue exitosa, Google Classroom devolverá un JSON con la información del anuncio creado.

Ejemplo:

```json
{
  "id": "987654321",
  "courseId": "123456789",
  "text": "Recordatorio: entregar proyecto final antes del viernes.",
  "state": "PUBLISHED",
  "creationTime": "2026-09-24T21:00:00.000Z"
}
```

### Resultado esperado

El anuncio debería aparecer publicado dentro del curso correspondiente de **Google Classroom**.

