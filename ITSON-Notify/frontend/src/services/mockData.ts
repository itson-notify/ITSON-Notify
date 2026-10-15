import type { Notif, Settings } from '@/types'

/* Datos simulados mientras el frontend no está conectado al backend.
   TODO: reemplazar por llamadas a la API (ver docs/api/guia_tecnica.md). */

export const STUDENT = { name: 'Alumno Demo', initials: 'AD', career: 'Ingeniería en Software' }
export const PERIODO = 'Agosto – Diciembre 2026'

export const DEFAULT_SETTINGS: Settings = {
  itsonId: '',
  itsonStatus: 'ok',
  classroomConnected: false,
  classroomEmail: 'alumno@ejemplo.com',
  categories: { calificaciones: true, tareas: true, cupos: true, tramites: true },
  cupoWatch: [],
  pushOn: false,
  pushPermission: 'default',
  emailOn: true,
  email: 'alumno@ejemplo.com',
  quietHours: true,
}

// TODO: URL real de recuperación de contraseña de ITSON
export const ITSON_RECOVERY_URL = '#'

// Materias que el RPA podría leer del portal para sugerir (mock)
export const SUGGESTED_COURSES = ['Redes de Computadoras', 'Sistemas Operativos', 'Ingeniería de Software II', 'Arquitectura de Software']

export const INITIAL_NOTIFS: Notif[] = [
  { id: 1, type: 'calificaciones', title: 'Nueva calificación disponible', subject: 'Programación Avanzada', time: 'Hace 2 h', unread: true,
    body: 'Tu calificación de Programación Avanzada ya está disponible en el portal de alumnos.',
    rows: [{ label: 'Materia', value: 'Programación Avanzada' }, { label: 'Periodo', value: PERIODO }, { label: 'Calificación', value: '92' }] },
  { id: 2, type: 'tareas', title: 'Nueva tarea en Classroom', subject: 'Bases de Datos', time: 'Hace 5 h', unread: true,
    body: 'Se publicó la tarea "Normalización hasta 3FN" en Google Classroom.',
    rows: [{ label: 'Clase', value: 'Bases de Datos' }, { label: 'Entrega', value: '28 sep, 23:59' }, { label: 'Estado', value: 'Sin entregar' }] },
  { id: 3, type: 'cupos', title: 'Se liberó un cupo', subject: 'Redes de Computadoras', time: 'Hace 1 día', unread: true,
    body: 'Hay 1 lugar libre en el grupo 01 de Redes de Computadoras. Los cupos suelen ocuparse rápido.',
    rows: [{ label: 'Materia', value: 'Redes de Computadoras' }, { label: 'Grupo', value: '01' }, { label: 'Lugares libres', value: '1' }] },
  { id: 4, type: 'tramites', title: 'Trámite aprobado', subject: 'Inscripción', time: 'Hace 2 días', unread: false,
    body: 'Tu trámite de inscripción para el periodo Agosto – Diciembre 2026 fue aprobado.',
    rows: [{ label: 'Trámite', value: 'Inscripción' }, { label: 'Periodo', value: PERIODO }, { label: 'Estado', value: 'Aprobado' }] },
  { id: 5, type: 'tareas', title: 'Tu tarea vence mañana', subject: 'Inteligencia Artificial', time: 'Hace 3 días', unread: false,
    body: 'La tarea "Práctica 2: árboles de decisión" vence mañana y aún no la entregas.',
    rows: [{ label: 'Clase', value: 'Inteligencia Artificial' }, { label: 'Entrega', value: '23 sep, 23:59' }, { label: 'Estado', value: 'Sin entregar' }] },
  { id: 6, type: 'calificaciones', title: 'Nueva calificación disponible', subject: 'Cálculo Diferencial', time: 'Hace 4 días', unread: false,
    body: 'Tu calificación de Cálculo Diferencial ya está disponible en el portal de alumnos.',
    rows: [{ label: 'Materia', value: 'Cálculo Diferencial' }, { label: 'Periodo', value: PERIODO }, { label: 'Calificación', value: '88' }] },
  { id: 7, type: 'tramites', title: 'Tu trámite cambió de estado', subject: 'Beca ITSON', time: 'Hace 5 días', unread: false,
    body: 'Tu solicitud de Beca ITSON pasó a revisión.',
    rows: [{ label: 'Trámite', value: 'Beca ITSON' }, { label: 'Periodo', value: PERIODO }, { label: 'Estado', value: 'En revisión' }] },
]

// [H10] Preguntas frecuentes enfocadas en tareas concretas del alumno
export const FAQ: { q: string; a: string }[] = [
  { q: '¿Por qué no me llegan avisos?', a: 'Revisa en Configuración que la categoría esté activada y que tengas al menos un canal (este dispositivo o correo). Si ves un aviso naranja, tu contraseña de ITSON cambió y hay que actualizarla.' },
  { q: '¿Qué pasa si cambio mi contraseña de ITSON?', a: 'Dejamos de poder revisar tu portal y te mostramos un aviso naranja. Toca “Actualizar contraseña” y escribe la nueva. No pierdes tu historial.' },
  { q: '¿Es seguro darles mi contraseña?', a: 'Se guarda cifrada y solo se usa para consultar tu información. Nunca hacemos trámites ni cambios por ti. Puedes desconectar tu cuenta cuando quieras.' },
  { q: '¿Cada cuánto revisan mis portales?', a: 'Varias veces al día. Si quieres ver novedades en este momento, toca “Revisar ahora” en Inicio o en Notificaciones.' },
  { q: '¿Cómo elijo qué materias vigilar para cupos?', a: 'En Configuración, sección “Materias para vigilar cupos”, escribe el nombre o la clave de la materia, o toca una de las sugeridas.' },
  { q: 'Uso iPhone y no me llegan notificaciones', a: 'En Safari toca Compartir y luego “Agregar a inicio”. Abre ITSON Notify desde ese ícono y activa las notificaciones en Configuración.' },
  { q: '¿Cómo dejo de usar ITSON Notify?', a: 'En Configuración desconecta tu cuenta ITSON y Google Classroom. Si además quieres que borremos tu historial, escríbenos desde “Escribir a soporte”.' },
]
