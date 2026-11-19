import type { CalendarEvent, Course, CourseItem } from '@/services/api'
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
  { id: '1', type: 'calificaciones', title: 'Nueva calificación disponible', subject: 'Programación Avanzada', time: 'Hace 2 h', unread: true,
    body: 'Tu calificación de Programación Avanzada ya está disponible en el portal de alumnos.',
    rows: [{ label: 'Materia', value: 'Programación Avanzada' }, { label: 'Periodo', value: PERIODO }, { label: 'Calificación', value: '92' }] },
  { id: '2', type: 'tareas', title: 'Nueva tarea en Classroom', subject: 'Bases de Datos', time: 'Hace 5 h', unread: true,
    body: 'Se publicó la tarea "Normalización hasta 3FN" en Google Classroom.',
    rows: [{ label: 'Clase', value: 'Bases de Datos' }, { label: 'Entrega', value: '28 sep, 23:59' }, { label: 'Estado', value: 'Sin entregar' }] },
  { id: '3', type: 'cupos', title: 'Se liberó un cupo', subject: 'Redes de Computadoras', time: 'Hace 1 día', unread: true,
    body: 'Hay 1 lugar libre en el grupo 01 de Redes de Computadoras. Los cupos suelen ocuparse rápido.',
    rows: [{ label: 'Materia', value: 'Redes de Computadoras' }, { label: 'Grupo', value: '01' }, { label: 'Lugares libres', value: '1' }] },
  { id: '4', type: 'tramites', title: 'Trámite aprobado', subject: 'Inscripción', time: 'Hace 2 días', unread: false,
    body: 'Tu trámite de inscripción para el periodo Agosto – Diciembre 2026 fue aprobado.',
    rows: [{ label: 'Trámite', value: 'Inscripción' }, { label: 'Periodo', value: PERIODO }, { label: 'Estado', value: 'Aprobado' }] },
  { id: '5', type: 'tareas', title: 'Tu tarea vence mañana', subject: 'Inteligencia Artificial', time: 'Hace 3 días', unread: false,
    body: 'La tarea "Práctica 2: árboles de decisión" vence mañana y aún no la entregas.',
    rows: [{ label: 'Clase', value: 'Inteligencia Artificial' }, { label: 'Entrega', value: '23 sep, 23:59' }, { label: 'Estado', value: 'Sin entregar' }] },
  { id: '6', type: 'calificaciones', title: 'Nueva calificación disponible', subject: 'Cálculo Diferencial', time: 'Hace 4 días', unread: false,
    body: 'Tu calificación de Cálculo Diferencial ya está disponible en el portal de alumnos.',
    rows: [{ label: 'Materia', value: 'Cálculo Diferencial' }, { label: 'Periodo', value: PERIODO }, { label: 'Calificación', value: '88' }] },
  { id: '7', type: 'tramites', title: 'Tu trámite cambió de estado', subject: 'Beca ITSON', time: 'Hace 5 días', unread: false,
    body: 'Tu solicitud de Beca ITSON pasó a revisión.',
    rows: [{ label: 'Trámite', value: 'Beca ITSON' }, { label: 'Periodo', value: PERIODO }, { label: 'Estado', value: 'En revisión' }] },
]

// ITN-58 - Materias y tareas simuladas. Las fechas se calculan desde que carga la app
// para que siempre haya tareas vencidas y próximas.
const HORA = 3_600_000
const enHoras = (h: number) => new Date(Date.now() + h * HORA).toISOString()

export const MOCK_COURSES: Course[] = [
  { id: 'mock-ivirtual-1', name: 'Programación Avanzada', source: 'ivirtual', period: null, finalGrade: '92.5', updatedAt: enHoras(-2) },
  { id: 'mock-ivirtual-2', name: 'Bases de Datos', source: 'ivirtual', period: null, finalGrade: null, updatedAt: enHoras(-2) },
  { id: 'mock-classroom-1', name: 'Inteligencia Artificial', source: 'classroom', period: 'Grupo 02', finalGrade: null, updatedAt: enHoras(-5) },
  { id: 'mock-classroom-2', name: 'Taller de Tesis', source: 'classroom', period: null, finalGrade: null, updatedAt: enHoras(-5) },
  { id: 'mock-itson-1', name: 'Cálculo Diferencial', source: 'itson_api', period: '03', finalGrade: '9', updatedAt: enHoras(-30) },
  { id: 'mock-itson-2', name: 'Ética Profesional', source: 'itson_api', period: '03', finalGrade: 'A', updatedAt: enHoras(-30) },
]

export const MOCK_COURSE_ITEMS: Record<string, CourseItem[]> = {
  'mock-ivirtual-1': [
    { id: 'm1', label: 'Práctica 1: punteros', grade: 95, maxGrade: 100, dueAt: enHoras(-24 * 20), kind: 'ivirtual' },
    { id: 'm2', label: 'Práctica 2: listas ligadas', grade: 85, maxGrade: 100, dueAt: enHoras(-24 * 9), kind: 'ivirtual' },
    { id: 'm3', label: 'Práctica 3: árboles', grade: null, maxGrade: 100, dueAt: enHoras(-30), kind: 'ivirtual' },
    { id: 'm4', label: 'Proyecto final', grade: null, maxGrade: 100, dueAt: enHoras(24 * 6), kind: 'ivirtual' },
    { id: 'm5', label: 'Participación', grade: null, maxGrade: 10, dueAt: null, kind: 'ivirtual' },
  ],
  'mock-ivirtual-2': [
    { id: 'm6', label: 'Normalización hasta 3FN', grade: null, maxGrade: 100, dueAt: enHoras(20), kind: 'ivirtual' },
    { id: 'm7', label: 'Examen parcial 1', grade: 78.5, maxGrade: 100, dueAt: enHoras(-24 * 14), kind: 'ivirtual' },
  ],
  'mock-classroom-1': [
    { id: 'm8', label: 'Práctica 2: árboles de decisión', grade: null, maxGrade: 100, dueAt: enHoras(-3), kind: 'classroom' },
    { id: 'm9', label: 'Lectura: redes neuronales', grade: null, maxGrade: null, dueAt: null, kind: 'classroom' },
    { id: 'm10', label: 'Proyecto: clasificador', grade: null, maxGrade: 50, dueAt: enHoras(24 * 3), kind: 'classroom' },
  ],
  'mock-classroom-2': [],
  'mock-itson-1': [],
  'mock-itson-2': [],
}

// ITN-61 - Calendario académico simulado (eventos inventados). Las fechas se calculan
// desde que carga la app, en hora de Hermosillo (UTC-7 todo el año), para que siempre
// haya eventos pasados, de hoy y próximos, de todo el día y con hora.
const DESFASE_HMO = 7 * HORA
const diaHmo = (dias: number) => new Date(Date.now() - DESFASE_HMO + dias * 24 * HORA).toISOString().slice(0, 10)
const instanteHmo = (dia: string, hora: string) => new Date(Date.parse(`${dia}T${hora}:00.000Z`) + DESFASE_HMO).toISOString()

function mockEvento(id: string, title: string, category: string | null, desde: number, hasta: number, horas?: [string, string], description: string | null = null): CalendarEvent {
  const startDate = diaHmo(desde)
  const endDate = diaHmo(hasta)
  const [inicio, fin] = horas ?? ['00:00', '23:59']
  return {
    id, title, description, category, startDate, endDate, allDay: !horas,
    startsAt: instanteHmo(startDate, inicio), endsAt: instanteHmo(endDate, fin), updatedAt: enHoras(-24),
  }
}

export const MOCK_CALENDAR_EVENTS: CalendarEvent[] = [
  mockEvento('mock-cal-1', 'Inicio de solicitudes de examen extraordinario', 'Registro Escolar', -10, -10),
  mockEvento('mock-cal-2', 'Plática informativa de servicio social', 'Académicos', -3, -3, ['10:00', '11:30'], 'Sesión en línea para quienes ya cubren el 70% de créditos.'),
  mockEvento('mock-cal-3', 'Periodo de evaluaciones finales', 'Registro Escolar', -1, 4),
  mockEvento('mock-cal-4', 'Último día para bajas parciales', 'Registro Escolar', 0, 0),
  mockEvento('mock-cal-5', 'Feria de proyectos de ingeniería', 'Académicos', 0, 0, ['16:00', '18:00']),
  mockEvento('mock-cal-6', 'Último día de clases', 'Registro Escolar', 2, 2),
  mockEvento('mock-cal-7', 'Ceremonia de reconocimiento académico', 'Académicos', 6, 6, ['18:00', '20:00']),
  mockEvento('mock-cal-8', 'Mantenimiento programado del portal', null, 9, 9, ['22:00', '23:30']),
  mockEvento('mock-cal-9', 'Examen no ordinario', 'Registro Escolar', 12, 13),
  mockEvento('mock-cal-10', 'Vacaciones de invierno', 'Registro Escolar', 24, 40, undefined, 'Sin actividades académicas ni administrativas.'),
  mockEvento('mock-cal-11', 'Carga académica en línea', 'Registro Escolar', 42, 44),
  mockEvento('mock-cal-12', 'Primer día de clases', 'Registro Escolar', 47, 47),
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
