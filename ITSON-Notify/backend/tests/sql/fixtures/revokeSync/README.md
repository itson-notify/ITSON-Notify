# ITN-43-REVOKE-SYNC-021 — QA local

Resultado: **PASS**, PostgreSQL **18.6**, 2026-11-20. Pruebas exclusivamente con datos
sintéticos en un clúster nuevo, temporal y enlazado a `127.0.0.1`. El verificador
detiene el servidor y elimina su directorio al terminar. No acepta URLs de BD ni
hereda variables PG de conexión. No requiere instalar software.

## Reproducir

Desde la raíz del worktree, en PowerShell:

```powershell
node ITSON-Notify/backend/scripts/verify-classroom-revoke-sync-sql.cjs 'C:/Program Files/PostgreSQL/18/bin'
```

En este entorno `pg_ctl` falló dentro del sandbox con error de token restringido
87. La ejecución autorizada fuera del sandbox sí completó todas las pruebas. Una
primera ejecución SQL detectó un error del fixture (INSERT del usuario sintético
bajo service_role sin INSERT en app_users); se corrigió creando ese usuario como
administrador del clúster de prueba, sin ampliar permisos de service_role.

## Dependencias SQL fijadas

Estos fixtures son copias íntegras de solo las migraciones pertinentes, no son
migraciones para aplicar al proyecto. El verificador comprueba sus SHA de blob Git
(normalizando CRLF a LF) antes de ejecutarlas:

| Fixture | Fuente revisada | Commit del PR | Blob Git |
| --- | --- | --- | --- |
| `18.sql` | [PR #41, migración 018](https://github.com/itson-notify/ITSON-Notify/blob/a392a805e621c1d3c36885a181ea2e27e0c79ae9/ITSON-Notify/database/migrations/018_classroom_tasks_authorization.sql) | `a392a805e621c1d3c36885a181ea2e27e0c79ae9` | `8855972195329b6d69edcc0c9255d3347cd9de63` |
| `19.sql` | [PR #44, migración 019](https://github.com/itson-notify/ITSON-Notify/blob/c90fbb65c7fe2fa6aa12b07e35c9771771b5e3cf/ITSON-Notify/database/migrations/019_classroom_notification_deliveries.sql) | `c90fbb65c7fe2fa6aa12b07e35c9771771b5e3cf` | `0ab13751f4545a0023db41b78b65652b94d2734b` |

Se usa el esquema mínimo app_users(id) y las dependencias locales 006/008/014/016/017.
La 017 no se modifica. La 021 conserva firma, JSON de salida, security invoker,
search_path, ACL y algoritmo de baseline/idempotencia de la 017; añade la decisión
de scopes a partir de la autorización bloqueada después de app_users.

## Evidencia de la ejecución final

```text
PASS: negative control reproduces stale-task resurrection on original 017 + 018
PASS: 017 regression suite with real scoped grants; rollback and migration replay
PASS: scope matrix, no task writes, permissions, identity/status, RLS and isolation
PASS: sync -> disable; observed blocking and both commits, no 40P01
PASS: disable -> sync with stale task payload; observed blocking and both commits, no 40P01
PASS: activate -> sync; observed blocking and both commits, no 40P01
PASS: sync -> activate; observed blocking and both commits, no 40P01
PASS: sync -> ledger materialize; observed blocking and both commits, no 40P01
PASS: ledger materialize -> sync; observed blocking and both commits, no 40P01
PASS: 018/019 compatibility, ledger cancellation, isolation and infrastructure ACL errors
CLASSROOM_REVOKE_SYNC_SQL_OK (PostgreSQL real, disposable localhost cluster)
```

Cada carrera espera a que la primera RPC haya terminado dentro de una transacción
abierta (`PgSleep`), inicia la segunda y exige observar al PID de la primera en
`pg_blocking_pids` de la segunda antes de aceptar ambos commits. Hay timeouts y
fallo inmediato ante errores SQL; una demora sin bloqueo observado no cuenta como PASS.

Las pruebas verifican adicionalmente:

- Solo cursos con scope de cursos, incluso ante coursework malformado o residual:
  comparación completa de tareas/eventos antes y después y baseline sin cambios.
- Ambos scopes de tareas por separado; rechaza coincidencias parciales y scopes de otros alumnos.
- Baseline silencioso, eventos incrementales únicos y repetición idempotente.
- Tras revocación confirmada, varios snapshots residuales no recrean tareas/eventos/baseline.
- Activación y sync en ambos órdenes: el primer snapshot autorizado es silencioso.
- Ledger real materializado como pending y cancelado por el trigger 019 al desactivar,
  conservando la fila de auditoría; otro alumno permanece idéntico.
- Identidad user_id/google_id, grant ausente, needs_relink, scope de cursos ausente,
  metadatos de propietario manipulados, RLS y ACL. Errores reales de privilegios
  mantienen 42501 sin usar el marcador de autorización de negocio.
- Aplicación repetida de 021 y rollback externo explícito y por error.

## Riesgos y límites antes del PR

- Revalidar si cambian los commits SQL de #41/#44; resolver su orden de integración
  con #45 antes de preparar el PR remoto. Esta rama no incorpora su implementación.
- PostgreSQL 18.6 local validado; no se ejecutó contra la versión de Supabase ni
  contra su esquema completo. La 020 no está en este worktree y no se inspeccionó
  ni aplicó; no se afirma validación integrada de 020 ni de #45.
- La concurrencia del ledger aquí cubre materialize contra sync y cancelación real
  de pending al desactivar. No se ejecutó toda la suite de 019, ni envíos externos,
  ni la suite completa del backend. No se cambia su protocolo de envío.
- La garantía depende de que los escritores de activación/desactivación usen las
  RPC atómicas de 018 y su orden de bloqueos. La 021 no corrige escritores externos
  que omitan ese protocolo.
- Aplicar manualmente 021 en una transacción externa, después de 017 y coordinada
  con 018/019. Este trabajo no aplica migraciones ni cambia banderas en producción.

Sin push, PR remoto, merge, deploy, Supabase, Railway ni datos reales.
