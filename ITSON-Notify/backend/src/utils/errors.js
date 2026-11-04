// ITN-27 - Errores del backend.
// PersistenceError nunca copia el mensaje de Supabase: puede incluir valores
// de las filas (p. ej. "Key (email)=(...) already exists"). Solo guarda el
// paso que falló y el código de Postgres/PostgREST.

class PersistenceError extends Error {
  constructor(step, supabaseError) {
    super(`Falló la escritura o lectura en ${step}`);
    this.name = "PersistenceError";
    this.step = step;
    this.code = supabaseError?.code ?? null;
  }
}

// El run_id ya existe y pertenece a otro alumno.
class SnapshotOwnershipError extends Error {
  constructor(snapshotId) {
    super("El snapshot pertenece a otro usuario");
    this.name = "SnapshotOwnershipError";
    this.snapshotId = snapshotId;
  }
}

// ITN-36: mensaje fijo. Nunca lleva el texto, la llave, el ciphertext ni la causa
// original.
class CredentialDecryptError extends Error {
  constructor() {
    super("No se pudo descifrar la credencial");
    this.name = "CredentialDecryptError";
  }
}

class CredentialNotFoundError extends Error {
  constructor() {
    super("La credencial no existe");
    this.name = "CredentialNotFoundError";
  }
}

// El portal rechazó la credencial: hay que volver a vincular la cuenta.
class CredentialNeedsRelinkError extends Error {
  constructor() {
    super("La credencial requiere volver a vincular la cuenta");
    this.name = "CredentialNeedsRelinkError";
  }
}

// Lanza PersistenceError si la respuesta de supabase-js trae error.
function check(step, { data, error }) {
  if (error) throw new PersistenceError(step, error);
  return data;
}

module.exports = {
  PersistenceError,
  SnapshotOwnershipError,
  CredentialDecryptError,
  CredentialNotFoundError,
  CredentialNeedsRelinkError,
  check,
};
