// ITN-58b - Emparejamiento de materias entre fuentes (iVirtual, Classroom y la API
// de ITSON). Funciones puras: no consultan la base, no registran nada y no cambian
// sus entradas. Los nombres académicos nunca salen de aquí hacia los logs.
//
// Reglas:
//   - Se normalizan los nombres (minúsculas, sin acentos ni signos, sin palabras de
//     relleno y sin sufijos de grupo, sección o periodo).
//   - La similitud es Jaccard por tokens; se une solo si llega a SIMILARITY_THRESHOLD.
//   - Los números y numerales romanos deben coincidir exactamente (Cálculo I no se
//     une con Cálculo II; "I" y "1" sí cuentan como el mismo número).
//   - Una materia de una fuente se une con a lo más una de cada otra fuente. Gana la
//     pareja de mayor puntaje; si dos candidatas empatan, no se une ninguna.
//   - Nunca se unen dos materias de la misma fuente.

const SIMILARITY_THRESHOLD = 0.8;

// Palabras de relleno que no distinguen una materia de otra.
const STOPWORDS = new Set(["de", "del", "la", "las", "el", "los", "y", "e", "en", "a", "al"]);

// Palabras que introducen un sufijo de grupo, sección o periodo; se quitan junto con
// el token que las sigue ("grupo 02", "sec a", "periodo 2026").
const SUFFIX_KEYWORDS = new Set(["grupo", "gpo", "grp", "seccion", "secc", "sec", "periodo", "semestre", "turno"]);

const MESES = "(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[a-z]*";
const RANGO_MESES = new RegExp(`\\b${MESES}\\s+${MESES}\\b`, "g");
// Años (2026) y periodos con año (2026 1, 2026 2) ya sin signos.
const ANIO = /\b(?:19|20)\d{2}(?:\s+[12])?\b/g;

const ROMANO = /^(?=[ivx])(x{0,3})(ix|iv|v?i{0,3})$/;

function romanoANumero(token) {
  if (!ROMANO.test(token)) return null;
  const valores = { i: 1, v: 5, x: 10 };
  let total = 0;
  for (let i = 0; i < token.length; i += 1) {
    const actual = valores[token[i]];
    const siguiente = valores[token[i + 1]] ?? 0;
    total += actual < siguiente ? -actual : actual;
  }
  return total;
}

// Quita una "s" final de palabras largas para que "Bases" y "Base" coincidan.
function singular(token) {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

// Devuelve { words: string[], numbers: number[] } con tokens únicos y ordenados.
function normalizeCourseName(name) {
  if (typeof name !== "string") return { words: [], numbers: [] };
  let texto = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  texto = texto.replace(RANGO_MESES, " ").replace(ANIO, " ");

  const crudos = texto.split(/\s+/).filter(Boolean);
  const words = new Set();
  const numbers = new Set();
  for (let i = 0; i < crudos.length; i += 1) {
    const token = crudos[i];
    if (SUFFIX_KEYWORDS.has(token)) {
      i += 1; // también el identificador del grupo o periodo
      continue;
    }
    if (STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) {
      numbers.add(Number(token));
      continue;
    }
    const romano = romanoANumero(token);
    if (romano !== null) {
      numbers.add(romano);
      continue;
    }
    words.add(singular(token));
  }
  return {
    words: [...words].sort(),
    numbers: [...numbers].sort((a, b) => a - b),
  };
}

function mismosNumeros(a, b) {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

// Similitud entre 0 y 1. Es 0 si los números no coinciden exactamente o si alguno
// de los dos nombres se queda sin palabras.
function courseSimilarity(nameA, nameB) {
  const a = typeof nameA === "string" ? normalizeCourseName(nameA) : nameA;
  const b = typeof nameB === "string" ? normalizeCourseName(nameB) : nameB;
  if (!mismosNumeros(a.numbers, b.numbers)) return 0;
  if (a.words.length === 0 || b.words.length === 0) return 0;
  const setB = new Set(b.words);
  const comunes = a.words.filter((w) => setB.has(w)).length;
  const union = a.words.length + b.words.length - comunes;
  return union === 0 ? 0 : comunes / union;
}

// Agrupa materias de varias fuentes.
//   entradas: [{ key, source, name }] (key único).
//   Devuelve { groups: [[key, ...], ...], ambiguous: [key, ...] }.
// `groups` conserva el orden de las entradas (por el primer miembro) y cada grupo
// trae sus claves en el orden de entrada. `ambiguous` lista las claves que tenían
// un empate y por eso quedaron sin unir hacia esa fuente.
function matchCourses(entradas, { threshold = SIMILARITY_THRESHOLD } = {}) {
  const lista = entradas.map((e, index) => ({ ...e, index, norm: normalizeCourseName(e.name) }));

  // Unión de conjuntos: cada grupo sabe qué fuentes ya tiene.
  const padre = lista.map((_, i) => i);
  const fuentesDe = lista.map((e) => new Set([e.source]));
  const raiz = (i) => {
    while (padre[i] !== i) {
      padre[i] = padre[padre[i]];
      i = padre[i];
    }
    return i;
  };
  // Grupo + fuente que quedaron bloqueados por un empate.
  const bloqueados = new Set();
  const ambiguos = new Set();

  const parejas = [];
  for (let i = 0; i < lista.length; i += 1) {
    for (let j = i + 1; j < lista.length; j += 1) {
      if (lista[i].source === lista[j].source) continue;
      const score = courseSimilarity(lista[i].norm, lista[j].norm);
      if (score >= threshold) parejas.push({ i, j, score });
    }
  }
  parejas.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);

  const EPS = 1e-9;
  let k = 0;
  while (k < parejas.length) {
    // Todas las parejas con el mismo puntaje se deciden juntas.
    let fin = k;
    while (fin < parejas.length && Math.abs(parejas[fin].score - parejas[k].score) < EPS) fin += 1;
    const nivel = parejas.slice(k, fin);
    k = fin;

    const viables = nivel.filter(({ i, j }) => {
      const ri = raiz(i);
      const rj = raiz(j);
      if (ri === rj) return false;
      if (bloqueados.has(`${ri}|${lista[j].source}`) || bloqueados.has(`${rj}|${lista[i].source}`)) return false;
      for (const s of fuentesDe[rj]) if (fuentesDe[ri].has(s)) return false;
      return true;
    });

    // Un grupo solo puede recibir una materia de cada fuente: si en este nivel dos
    // parejas le ofrecen la misma fuente, es un empate y no se une ninguna.
    const ofertas = new Map();
    for (const p of viables) {
      for (const clave of [`${raiz(p.i)}|${lista[p.j].source}`, `${raiz(p.j)}|${lista[p.i].source}`]) {
        ofertas.set(clave, (ofertas.get(clave) ?? 0) + 1);
      }
    }
    const conflicto = (p) =>
      ofertas.get(`${raiz(p.i)}|${lista[p.j].source}`) > 1 || ofertas.get(`${raiz(p.j)}|${lista[p.i].source}`) > 1;

    const empatadas = viables.filter(conflicto);
    for (const p of empatadas) {
      ambiguos.add(p.i);
      ambiguos.add(p.j);
    }
    for (const [clave, n] of ofertas) if (n > 1) bloqueados.add(clave);

    for (const p of viables) {
      if (conflicto(p)) continue;
      const ri = raiz(p.i);
      const rj = raiz(p.j);
      if (ri === rj) continue;
      // Revalida: una unión anterior de este nivel pudo meter la misma fuente.
      let choca = false;
      for (const s of fuentesDe[rj]) if (fuentesDe[ri].has(s)) choca = true;
      if (choca) continue;
      const [mayor, menor] = ri < rj ? [ri, rj] : [rj, ri];
      padre[menor] = mayor;
      for (const s of fuentesDe[menor]) fuentesDe[mayor].add(s);
      // Los bloqueos del grupo absorbido pasan al grupo resultante.
      for (const clave of [...bloqueados]) {
        const [r, s] = clave.split("|");
        if (Number(r) === menor) bloqueados.add(`${mayor}|${s}`);
      }
    }
  }

  const porRaiz = new Map();
  for (const e of lista) {
    const r = raiz(e.index);
    if (!porRaiz.has(r)) porRaiz.set(r, []);
    porRaiz.get(r).push(e);
  }
  const groups = [...porRaiz.values()]
    .sort((a, b) => a[0].index - b[0].index)
    .map((g) => g.map((e) => e.key));

  // Una clave ambigua que de todos modos se unió por otro lado sigue reportándose:
  // el empate se dio hacia una fuente concreta.
  const ambiguous = lista.filter((e) => ambiguos.has(e.index)).map((e) => e.key);
  return { groups, ambiguous };
}

module.exports = {
  SIMILARITY_THRESHOLD,
  normalizeCourseName,
  courseSimilarity,
  matchCourses,
};
