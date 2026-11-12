const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY

// Date.parse acepta textos como "Hace 2" en algunos navegadores: se exige forma ISO.
const ISO = /^\d{4}-\d{2}-\d{2}T/

/** Fecha ISO a texto relativo ("Hace 2 h"). Lo que no sea ISO, como los textos de mockData, se devuelve igual. */
export function timeAgo(time: string, now: number = Date.now()): string {
  const then = ISO.test(time) ? Date.parse(time) : NaN
  if (Number.isNaN(then)) return time
  const elapsed = now - then
  if (elapsed < MINUTE) return 'Hace un momento'
  if (elapsed < HOUR) return `Hace ${Math.floor(elapsed / MINUTE)} min`
  if (elapsed < DAY) return `Hace ${Math.floor(elapsed / HOUR)} h`
  if (elapsed < MONTH) {
    const days = Math.floor(elapsed / DAY)
    return `Hace ${days} ${days === 1 ? 'día' : 'días'}`
  }
  const months = Math.floor(elapsed / MONTH)
  return `Hace ${months} ${months === 1 ? 'mes' : 'meses'}`
}
