export const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB]'
export const linkCls = `inline-flex items-center gap-1.5 min-h-9 rounded text-[14px] font-semibold hover:underline underline-offset-2 cursor-pointer ${focusRing}`

/** Normaliza para comparar sin acentos ni mayúsculas. */
export const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
