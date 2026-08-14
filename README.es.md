# React Native Upload Queue

Cola persistente y resiliente de subidas de archivos para React Native.

En un dispositivo real una subida no falla solo por el contrato de la API: el proceso muere, se cae la radio, Wi-Fi pasa a datos, el SO suspende la app, el token caduca a mitad del request, o el servidor responde `429` / `500` después de dos minutos de transferencia. Un `fetch()` suelto no representa ese ciclo de vida.

Esta librería persiste cada upload en el dispositivo, procesa la cola con concurrencia acotada, reintenta solo fallos recuperables y recupera trabajo abandonado después de un reinicio.

**Promesa de `0.1.0`:** persistir subidas de archivos en el dispositivo y procesarlas de forma fiable con reintentos, seguimiento de progreso, control de concurrencia y recuperación automática tras reiniciar la aplicación.

| | |
| ------------- | ----------------------------------------- |
| Paquete | `@erickmorales/react-native-upload-queue` |
| Runtime | React Native / TypeScript (núcleo compatible con Hermes) |
| Persistencia | SQLite mediante un driver enchufable, más un adaptador en memoria para tests |
| Transporte | HTTP multipart, un intento por llamada |
| Conectividad | Adaptador NetInfo o un proveedor manual |
| Licencia | MIT |

También disponible en [inglés](README.md).

Este paquete **no** depende de [`react-native-resilient-sync`](https://github.com/erick9125/react-native-resilient-sync). Pertenecen a la misma familia de resiliencia y pueden convivir. Sync cubre operaciones JSON de dominio. Esta librería cubre archivos.

---

## Tabla de contenidos

1. [Cuándo usarla](#cuándo-usarla)
2. [El problema](#el-problema)
3. [Qué garantiza esta librería](#qué-garantiza-esta-librería)
4. [Qué no es](#qué-no-es)
5. [Instalación](#instalación)
6. [Inicio rápido](#inicio-rápido)
7. [Un ejemplo completo](#un-ejemplo-completo)
8. [Crear la cola](#crear-la-cola)
9. [Encolar subidas](#encolar-subidas)
10. [Procesar la cola](#procesar-la-cola)
11. [Pausar, reanudar, cancelar, reintentar](#pausar-reanudar-cancelar-reintentar)
12. [Eventos y progreso en UI](#eventos-y-progreso-en-ui)
13. [Adaptadores de almacenamiento](#adaptadores-de-almacenamiento)
14. [Transporte HTTP](#transporte-http)
15. [Conectividad](#conectividad)
16. [Reintentos y clasificación de errores](#reintentos-y-clasificación-de-errores)
17. [Autenticación](#autenticación)
18. [Recuperación después de un reinicio](#recuperación-después-de-un-reinicio)
19. [Idempotencia](#idempotencia)
20. [Semántica del progreso](#semántica-del-progreso)
21. [Relación con react-native-resilient-sync](#relación-con-react-native-resilient-sync)
22. [Seguridad](#seguridad)
23. [Testing](#testing)
24. [Referencia de API](#referencia-de-api)
25. [Limitaciones y roadmap](#limitaciones-y-roadmap)
26. [Licencia](#licencia)

---

## Cuándo usarla

Úsala cuando el producto no puede permitirse perder un archivo solo porque el dispositivo se quedó sin cobertura.

Cargas típicas:

- inspecciones en terreno: fotos y evidencia capturadas sin red
- facturación: PDFs adjuntos en bodega o en ruta
- operaciones / salud: documentos y notas de audio
- chat o tickets: imágenes y videos elegidos por el usuario
- cualquier flujo donde “el usuario ya pulsó enviar” tenga que llegar al servidor

Si el archivo es pequeño, la red está garantizada y perder el request es aceptable, un `fetch` directo alcanza. Si el usuario puede mandar la app a segundo plano, perder señal o reenviar el mismo documento, hace falta una cola.

---

## El problema

La implementación ingenua parece correcta:

```ts
await fetch('/uploads', {
  method: 'POST',
  body: file,
});
```

Funciona mientras se cumplen todas estas condiciones:

- la radio está estable
- la app permanece en primer plano
- el request es corto
- el archivo es pequeño
- el servidor responde `2xx` al primer intento

En un dispositivo real suele ocurrir otra cosa:

| Fallo | Qué hace un `fetch` crudo | Qué ve el usuario |
| ----- | ------------------------- | ----------------- |
| La app se mata a mitad de la subida | El request desaparece | El archivo desaparece de la UI; lo sube otra vez |
| Túnel / ascensor / zona rural | Lanza error de red | Reintenta a ciegas y genera duplicados |
| Handoff Wi-Fi → 4G | El socket muere | El progreso se resetea sin registro del intento |
| `500` / `502` / `503` | Cada pantalla inventa su retry | UX inconsistente |
| `429` + `Retry-After` | Casi nunca se respeta | El cliente se DDoSea a sí mismo |
| `401` con token vencido | Cinco reintentos con el mismo header | Bloqueos de cuenta, batería tirada |
| Una URI `file://` temporal caduca | Cinco reintentos de un archivo inexistente | Ruido en logs, sin diagnóstico útil |

La librería convierte eso en una máquina de estados durable:

```text
Elegir archivo
      ↓
Persistir el upload (SQLite)
      ↓
Entrar a la cola como pending
      ↓
Claim + un intento HTTP
      ↓
¿Fallo recuperable? persistir + esperar + reintentar
      ↓
El servidor confirma
      ↓
completed
```

---

## Qué garantiza esta librería

1. **Persistir antes de transmitir.** El registro existe en local antes de enviar el primer byte. Matar la app no elimina la intención de subir.

2. **Un intento HTTP por llamada de transporte.** `HttpUploadTransport` no reintenta. El processor posee el backoff, `Retry-After`, el máximo de intentos y `blocked`. Esas responsabilidades están separadas a propósito.

3. **Claim, no “seleccionar pending y esperar”.** La fila pasa `pending → uploading` con un `processingToken`. Dos `process()` en la misma instancia no pueden enviar dos veces el mismo archivo.

4. **La concurrencia es un tope duro.** `concurrency: 2` significa como máximo dos uploads en vuelo en esa instancia, aunque la UI dispare `process()` tres veces.

5. **Offline no consume reintentos.** Cinco minutos sin señal no queman cinco intentos. `attempts` solo aumenta después de un intento real de subida.

6. **Claves de idempotencia estables.** Los intentos 1, 2 y 3 envían el mismo `Idempotency-Key`. El servidor sigue teniendo que implementar la semántica; el cliente no rota la clave.

7. **Errores estructurados.** Los fallos son `network | authentication | authorization | rate-limit | validation | server | file-not-found | cancelled | unknown`, con `retryable` y `statusCode` / `retryAfterMs` opcionales.

8. **Se recuperan filas `uploading` abandonadas.** Tras un crash, las más antiguas que `processingTimeoutMs` vuelven a `pending` y se intentan de nuevo.

9. **Los tokens nunca entran en SQLite.** `getAccessToken` corre en cada intento. La cola guarda URI, destino, metadata y estado — no `Authorization`.

---

## Qué no es

`0.1.0` es una **cola de upload resiliente**, no un **protocolo de upload resumible**.

Persistir `progress: 0.53` no significa que el siguiente intento continúe en el byte 53%. Mientras el servidor no hable TUS, S3 multipart u otro protocolo por chunks, el reintento parte desde el byte 0. El progreso es para la UI.

Fuera de alcance en esta versión:

- TUS, S3 multipart, resume por chunks
- Firebase Storage, Supabase Storage, Cloudinary, SDKs de AWS / Azure / GCS
- GraphQL o WebSockets
- servicios nativos de background upload
- cifrado, compresión de imagen, transcodificación de video, thumbnails
- sincronización bidireccional
- una UI empaquetada o un store Redux / Zustand obligatorio

Eso corresponde a versiones posteriores o a la capa de aplicación.

---

## Instalación

```bash
npm install @erickmorales/react-native-upload-queue
```

El núcleo **no** depende en runtime de `react-native`, NetInfo ni de un motor SQLite concreto. Por eso el mismo código corre en tests de Node.

En producción tú entregas:

- un módulo nativo de SQLite (`react-native-quick-sqlite`, `op-sqlite`, `expo-sqlite`, …) detrás de `SQLiteDriver`
- opcionalmente `@react-native-community/netinfo`

Usa el `createId()` exportado cuando necesites un UUID. `crypto.randomUUID()` no existe en Hermes.

---

## Inicio rápido

```ts
import {
  createUploadQueue,
  createSQLiteUploadStorage,
  createHttpUploadTransport,
} from '@erickmorales/react-native-upload-queue';

const queue = createUploadQueue({
  storage: createSQLiteUploadStorage({
    databaseName: 'uploads.db',
    openDriver: (databaseName) => openYourSqliteDriver(databaseName),
  }),
  transport: createHttpUploadTransport({
    baseUrl: 'https://api.example.com',
    getAccessToken: async () => auth.getAccessToken(),
  }),
  concurrency: 2,
  retry: {
    maxAttempts: 5,
    strategy: 'exponential',
  },
});

const upload = await queue.enqueue({
  fileUri: file.uri,
  fileName: file.name,
  mimeType: file.type,
  destination: '/uploads',
});

await queue.start();
```

`enqueue` vuelve de inmediato con un `id`. `start()` recupera filas abandonadas, procesa lo debido y queda escuchando reconexiones.

---

## Un ejemplo completo

Una app de terreno que adjunta una foto de factura y un PDF, muestra progreso y sobrevive a un tramo sin señal:

```ts
import NetInfo from '@react-native-community/netinfo';
import {
  createHttpUploadTransport,
  createNetInfoConnectivityProvider,
  createSQLiteUploadStorage,
  createUploadQueue,
  type UploadQueueEvent,
  type UploadTask,
} from '@erickmorales/react-native-upload-queue';

const queue = createUploadQueue({
  storage: createSQLiteUploadStorage({
    databaseName: 'uploads.db',
    openDriver: openYourSqliteDriver,
  }),
  transport: createHttpUploadTransport({
    baseUrl: 'https://api.example.com',
    fieldName: 'file',
    idempotencyHeader: 'Idempotency-Key',
    getAccessToken: () => auth.getAccessToken(),
    timeoutMs: 60_000,
  }),
  connectivity: createNetInfoConnectivityProvider({ netInfo: NetInfo }),
  concurrency: 2,
  retry: {
    maxAttempts: 5,
    initialDelayMs: 2_000,
    maxDelayMs: 32_000,
    jitter: true,
  },
  recovery: {
    processingTimeoutMs: 5 * 60_000,
  },
});

export async function bootstrapUploads(): Promise<void> {
  queue.subscribe(onUploadEvent);
  await queue.start();
}

export async function enviarEvidencia(file: {
  uri: string;
  name: string;
  type: string;
  size?: number;
}): Promise<UploadTask> {
  return queue.enqueue({
    fileUri: file.uri,
    fileName: file.name,
    mimeType: file.type,
    ...(file.size !== undefined ? { size: file.size } : {}),
    destination: '/documents',
    metadata: {
      documentType: 'invoice',
      inspectionId: currentInspectionId,
    },
  });
}

function onUploadEvent(event: UploadQueueEvent): void {
  switch (event.type) {
    case 'upload.progress':
      updateRow(event.uploadId, {
        progress: event.progress,
        bytesUploaded: event.bytesUploaded,
      });
      break;
    case 'upload.completed':
      markDone(event.uploadId, event.remoteId);
      break;
    case 'upload.blocked':
      pedirInicioDeSesion();
      break;
    case 'upload.failed':
      mostrarFallo(event.uploadId, event.error.message);
      break;
    default:
      break;
  }
}
```

La pantalla solo pinta el estado de la cola. No posee timers de retry, suscripciones a NetInfo ni escrituras a SQLite.

```text
Subidas

photo.jpg      ████████░░  80%   uploading
invoice.pdf    ░░░░░░░░░░   0%   pending
video.mp4      ██████████ 100%   completed
```

---

## Crear la cola

```ts
const queue = createUploadQueue({
  storage,
  transport,
  connectivity,          // opcional
  fileProvider,          // opcional; por defecto asume que la URI sigue existiendo
  retry: {
    maxAttempts: 5,
    strategy: 'exponential', // o 'fixed', o un RetryStrategy propio
    initialDelayMs: 2_000,
    maxDelayMs: 60_000,
    jitter: true,
  },
  concurrency: 2,
  recovery: { processingTimeoutMs: 5 * 60_000 },
  progress: {
    eventThrottleMs: 200,
    persistEveryPercent: 0.1,
    persistEveryMs: 500,
  },
  autoProcessOnReconnect: true,
});
```

| Opción | Default | Rol |
| ------ | ------- | --- |
| `concurrency` | `2` | Máximo de uploads simultáneos en esta instancia |
| `retry.maxAttempts` | `5` | Intentos que realmente pegan a la red |
| `recovery.processingTimeoutMs` | `5 min` | Cuándo una fila `uploading` se considera abandonada |
| `progress.eventThrottleMs` | `200` | Eventos de UI, no escrituras SQLite |
| `autoProcessOnReconnect` | `true` | Solo mientras se haya llamado `start()` |

---

## Encolar subidas

```ts
const upload = await queue.enqueue({
  fileUri: file.uri,
  fileName: file.name,
  mimeType: file.type,
  size: file.size,
  destination: '/documents',
  method: 'POST', // o 'PUT'
  metadata: { documentType: 'invoice' },
});

upload.id;
upload.status;          // 'pending'
upload.idempotencyKey;  // estable en todos los intentos posteriores
```

El archivo original **no** se copia a SQLite. La cola guarda la URI y metadata pequeña (tope de 8 KiB). Si el SO recicla una URI temporal, el siguiente intento falla como `file-not-found` en lugar de reintentar cinco veces una ruta fantasma.

---

## Procesar la cola

```ts
await queue.start();    // recuperar + procesar + escuchar reconexión + programar backoff
await queue.process();  // un drenaje de lo que ya está due (ideal para tests)
await queue.stop();     // corta la programación automática; los intentos en vuelo terminan
await queue.destroy();  // stop, unsubscribe, cierra storage
```

`process()` es single-flight. Una segunda llamada solapada devuelve `{ skipped: true, reason: 'busy' }` en lugar de lanzar otro pool de workers.

Si la conectividad reporta offline, `process()` devuelve `{ skipped: true, reason: 'offline' }` y deja `attempts` en `0`.

---

## Pausar, reanudar, cancelar, reintentar

```ts
await queue.pause(uploadId);
// uploading | pending → paused
// el HTTP en vuelo se aborta con AbortController

await queue.resume(uploadId);
// paused → pending
// el scheduler decide cuándo corre; no es paused → uploading

await queue.cancel(uploadId);
// → cancelled (terminal)
// el archivo original en disco no se elimina

await queue.retry(uploadId);
// failed | blocked → pending
// primero se comprueba la URI; si el archivo no existe, lanza FileNotFoundError
```

Las transiciones ilegales lanzan `InvalidUploadStateError`. `completed → uploading` se rechaza.

---

## Eventos y progreso en UI

```ts
const unsubscribe = queue.subscribe((event) => {
  switch (event.type) {
    case 'upload.queued':
    case 'upload.started':
    case 'upload.progress':
    case 'upload.retry_scheduled':
    case 'upload.completed':
    case 'upload.failed':
    case 'upload.paused':
    case 'upload.cancelled':
    case 'upload.blocked':
      break;
  }
});
```

Los eventos de progreso van throttled (200 ms por defecto). SQLite se actualiza alrededor de cada 10% o 500 ms — nunca por byte.

Si un listener lanza, se traga el error. La cola no aborta un ciclo porque se cayó la UI.

---

## Adaptadores de almacenamiento

El motor solo habla con `UploadStorage`. SQLite es un adaptador, no el motor.

### En memoria (tests)

```ts
import { createMemoryUploadStorage, createUploadQueue } from '@erickmorales/react-native-upload-queue';

const queue = createUploadQueue({
  storage: createMemoryUploadStorage(),
  transport: fakeTransport,
});
```

El adaptador en memoria es un sustituto honesto: un id duplicado falla, un `update` de una fila inexistente falla, el claim es compare-and-set y la metadata viaja por JSON — el mismo contrato que implementa SQLite.

### SQLite (producción)

```ts
import { createSQLiteUploadStorage, type SQLiteDriver } from '@erickmorales/react-native-upload-queue';

const storage = createSQLiteUploadStorage({
  databaseName: 'uploads.db',
  openDriver: async (databaseName) => openYourSqliteDriver(databaseName),
});
```

O un driver ya creado:

```ts
createSQLiteUploadStorage({ driver: myDriver });
```

Superficie requerida:

```ts
interface SQLiteDriver {
  execute(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly Record<string, unknown>[]; rowsAffected?: number }>;
  transaction<T>(fn: (tx: SQLiteDriver) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
```

Esquema para un módulo nativo:

```ts
function createQuickSqliteDriver(databaseName: string): SQLiteDriver {
  const db = QuickSQLite.open(databaseName);

  return {
    async execute(sql, params = []) {
      const result = db.execute(sql, params as unknown[]);
      return {
        rows: result.rows?._array ?? [],
        rowsAffected: result.rowsAffected,
      };
    },
    async transaction(fn) {
      db.execute('BEGIN');
      try {
        const value = await fn(this);
        db.execute('COMMIT');
        return value;
      } catch (error) {
        db.execute('ROLLBACK');
        throw error;
      }
    },
    async close() {
      db.close();
    },
  };
}
```

---

## Transporte HTTP

El adaptador arma el multipart, pone el header de idempotencia, lee un token fresco, honra abort/timeout y devuelve **un** status code. No entra en un bucle.

```ts
createHttpUploadTransport({
  baseUrl: 'https://api.example.com',
  getAccessToken: () => auth.getAccessToken(),
  idempotencyHeader: 'Idempotency-Key',
  fieldName: 'file',
  timeoutMs: 60_000,
  defaultHeaders: { 'X-Client': 'mobile' },
});
```

En React Native el body por defecto es un part `{ uri, name, type }` de FormData. En tests de Node cae a un `Blob`. Para un payload a medida, pasa `buildBody`.

---

## Conectividad

El núcleo nunca importa NetInfo.

```ts
import NetInfo from '@react-native-community/netinfo';
import {
  createManualConnectivity,
  createNetInfoConnectivityProvider,
} from '@erickmorales/react-native-upload-queue';

createNetInfoConnectivityProvider({ netInfo: NetInfo });

const connectivity = createManualConnectivity(true);
connectivity.setOnline(false); // tests y “simular offline” en la app de ejemplo
```

Mientras está offline, el trabajo due permanece `pending`. Después de `start()`, volver online drena la cola.

---

## Reintentos y clasificación de errores

| Condición | Kind | Reintentable | Resultado |
| --------- | ---- | ------------ | --------- |
| Red / `TypeError` | `network` | sí | `pending` + backoff |
| `408` | `network` | sí | `pending` |
| `429` | `rate-limit` | sí | `pending`; `Retry-After` gana al backoff local |
| `500` `502` `503` `504` | `server` | sí | `pending` |
| `400` `404` `409` `422` | `validation` | no | `failed` |
| `401` | `authentication` | no | `blocked` |
| `403` | `authorization` | no | `failed` |
| Archivo inexistente | `file-not-found` | no | `failed` |
| Offline antes del intento | — | — | `pending`, `attempts` no cambia |

Serie exponencial por defecto sin jitter: 2s, 4s, 8s, 16s, 32s (con tope). El jitter viene activo para evitar una estampida de reintentos.

`Retry-After` siempre gana a la estrategia local.

Ver [docs/retries.md](docs/retries.md).

---

## Autenticación

```ts
createHttpUploadTransport({
  baseUrl: 'https://api.example.com',
  getAccessToken: async () => auth.getAccessToken(),
});
```

El callback corre en **cada** intento para no reutilizar un token vencido guardado en la fila. En `0.1.0`, un `401` pasa la tarea a `blocked`. No hay refresh automático; eso va en `0.2.0`. La UI debe llevar al usuario al login y luego llamar `queue.retry(id)`.

---

## Recuperación después de un reinicio

Si el proceso muere con una fila en `uploading`, esa fila sigue `uploading` en disco.

En el siguiente `initialize()` / `start()`:

```text
status = uploading
AND processingStartedAt < now - processingTimeoutMs
        ↓
pending  (progreso en cero; el siguiente HTTP parte del byte 0)
```

Una fila cuyo `processingStartedAt` tiene 10 segundos no se toca. Timeout por defecto: 5 minutos.

Ver [docs/recovery.md](docs/recovery.md).

---

## Idempotencia

Cada tarea recibe un `idempotencyKey` estable al encolar (`createId()` / UUID). Los reintentos lo reutilizan. El adaptador HTTP envía:

```http
Idempotency-Key: <key>
```

La cola no puede hacer idempotente al servidor. Si el cliente se cae después de que el servidor guardó el archivo pero antes de registrar `completed`, la recuperación enviará la misma clave otra vez. Un servidor correcto devuelve el resultado original en lugar de persistir un segundo objeto.

Documéntalo con tu backend. Ver [docs/idempotency.md](docs/idempotency.md).

---

## Semántica del progreso

| Capa | Cadencia | Significado |
| ---- | -------- | ----------- |
| Eventos de UI | ~200 ms | Pintar una barra |
| SQLite | ~10% o 500 ms | Sobrevivir un reinicio con una pista visual |
| Siguiente intento HTTP | desde el byte 0 | Hasta que exista un protocolo resumible |

No le digas al usuario “se reanuda en 53%” en `0.1.0`. Dile “la subida se reintentará”.

---

## Relación con react-native-resilient-sync

| `react-native-resilient-sync` | `react-native-upload-queue` |
| ----------------------------- | --------------------------- |
| Operaciones JSON de dominio | Archivos, imágenes, video, PDF |
| `POST /orders`, `PUT /users` | Transferencia binaria multipart |
| Resolutores de conflicto | Progreso, pausa, cancelación |
| Payload en la fila | URI + metadata pequeña, nunca los bytes |

Úsalas juntas cuando tengas notas **y** adjuntos. Ninguna importa a la otra.

---

## Seguridad

Nunca persistas:

- access / refresh tokens
- headers `Authorization`
- cookies o contraseñas
- el body multipart

Guarda URI, destino y metadata estructurada pequeña. El logger por defecto es no-op; uno propio debería registrar `uploadId`, `status` y `attempts` — no `console.log(task)`.

Ver [SECURITY.md](SECURITY.md) y [docs/security.md](docs/security.md).

---

## Testing

```bash
npm test
npm run check:full
```

La suite cubre la máquina de estados, backoff, clasificación HTTP, pausa/cancelación/retry, offline (`attempts` se queda en 0), concurrencia (`peak === 3` con 20 archivos), claiming con `process()` solapados, y recuperación tras crash (el proceso A muere en `uploading`, el B completa con la misma clave de idempotencia).

En tests de aplicación inyecta `createMemoryUploadStorage()`, `createManualConnectivity()` y un `UploadTransport` falso.

---

## Referencia de API

```ts
interface UploadQueue {
  initialize(): Promise<void>;
  enqueue(input: EnqueueUploadInput): Promise<UploadTask>;
  start(): Promise<void>;
  stop(): Promise<void>;
  process(): Promise<UploadProcessResult>;
  pause(uploadId: string): Promise<UploadTask>;
  resume(uploadId: string): Promise<UploadTask>;
  cancel(uploadId: string): Promise<UploadTask>;
  retry(uploadId: string): Promise<UploadTask>;
  get(uploadId: string): Promise<UploadTask | null>;
  list(): Promise<readonly UploadTask[]>;
  purgeCompleted(olderThanIso?: string): Promise<number>;
  subscribe(listener: (event: UploadQueueEvent) => void): () => void;
  destroy(): Promise<void>;
}

type UploadStatus =
  | 'pending'
  | 'uploading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';
```

Más detalle: [docs/architecture.md](docs/architecture.md), [docs/limitations.md](docs/limitations.md).

---

## Limitaciones y roadmap

**`0.2.0`:** hooks de refresh de autenticación, prioridades, headers por upload, política de limpieza, pausa/reanudación de toda la cola.

**`0.3.0`:** uploads por chunks, chunks persistidos, resume tokens, adaptador de capacidades del servidor.

---

## Licencia

MIT. Si cambias comportamiento, mira [CONTRIBUTING.md](CONTRIBUTING.md).
