import { Cause, Data, Duration, Effect, Exit, Option, Schedule } from "effect";

interface AsyncLocalStorage<T> {
  run<R>(store: T, callback: () => R): R;
  getStore(): T | undefined;
}

function createAsyncLocalStorage<T>(): AsyncLocalStorage<T> {
  const getBuiltin = (globalThis as {
    process?: { getBuiltinModule?: (id: string) => { AsyncLocalStorage: new <V>() => AsyncLocalStorage<V> } };
  }).process?.getBuiltinModule;
  if (getBuiltin !== undefined) {
    return new (getBuiltin("node:async_hooks").AsyncLocalStorage)<T>();
  }
  let current: T | undefined;
  return {
    run(store, callback) {
      const previous = current;
      current = store;
      try {
        return callback();
      } finally {
        current = previous;
      }
    },
    getStore() {
      return current;
    },
  };
}

/**
 * DB-boundary errors. Fields stay stable so a later Effect migration can
 * wrap these classes without changing callers. `sessionId` and `sandboxId`
 * are set only when the caller knows them.
 */
export interface DbErrorFields {
  readonly op: string;
  readonly sessionId?: string;
  readonly sandboxId?: string;
  readonly timeoutMs?: number;
  readonly cause?: unknown;
  readonly sql?: string;
}

export class Deadlock extends Data.TaggedError("Deadlock")<DbErrorFields> {}
export class LockWaitTimeout extends Data.TaggedError("LockWaitTimeout")<DbErrorFields> {}
export class ConnectionLost extends Data.TaggedError("ConnectionLost")<DbErrorFields> {}
export class CasConflict extends Data.TaggedError("CasConflict")<DbErrorFields> {}
export class Timeout extends Data.TaggedError("Timeout")<DbErrorFields> {}
export class LeaseLost extends Data.TaggedError("LeaseLost")<DbErrorFields> {}
export class NotFound extends Data.TaggedError("NotFound")<DbErrorFields> {}

export type TaggedDbError =
  | Deadlock
  | LockWaitTimeout
  | ConnectionLost
  | CasConflict
  | Timeout
  | LeaseLost
  | NotFound;

const tagged = new Set([
  "Deadlock",
  "LockWaitTimeout",
  "ConnectionLost",
  "CasConflict",
  "Timeout",
  "LeaseLost",
  "NotFound",
]);

/** Transient driver failures. Timeout is an application deadline, not a driver retry. */
const transientTags = new Set(["Deadlock", "LockWaitTimeout", "ConnectionLost"]);

/**
 * One policy for 1213/1205/connection loss: 5 attempts, exponential delay
 * starting at 5ms and doubling, jittered (Effect's 0.8–1.2 band).
 * `Schedule.recurs(4)` is four retries after the first attempt.
 */
export const transientDbRetrySchedule = Schedule.exponential(Duration.millis(5), 2).pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(4)),
);

export interface DbBoundaryLog {
  op: string;
  sessionId?: string;
  sandboxId?: string;
  timeoutMs?: number;
  durationMs: number;
  retryCount: number;
  outcome: "ok" | "error";
  errorTag?: string;
}

export type DbBoundaryLogger = (record: DbBoundaryLog) => void;

let boundaryLogger: DbBoundaryLogger = (record) => {
  const line = JSON.stringify({ msg: "db.boundary", ...record });
  if (record.outcome === "error") console.error(line);
  else if (record.retryCount > 0) console.warn(line);
  else console.info(line);
};

export function setDbBoundaryLogger(logger: DbBoundaryLogger): void {
  boundaryLogger = logger;
}

export function emitDbBoundaryLog(record: DbBoundaryLog): void {
  boundaryLogger(record);
}

interface BoundaryStore {
  op: string;
  sessionId?: string;
  sandboxId?: string;
  timeoutMs?: number;
  retryCount: number;
  lastErrorTag?: string;
}

const boundaries = createAsyncLocalStorage<BoundaryStore>();

export function annotateDbBoundary(patch: {
  sessionId?: string;
  sandboxId?: string;
}): void {
  const store = boundaries.getStore();
  if (!store) return;
  if (patch.sessionId !== undefined) store.sessionId = patch.sessionId;
  if (patch.sandboxId !== undefined) store.sandboxId = patch.sandboxId;
}

function errorTag(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return undefined;
  const tag = (error as { _tag?: unknown })._tag;
  return typeof tag === "string" && tagged.has(tag) ? tag : undefined;
}

export function isTaggedDbError(error: unknown): error is TaggedDbError {
  return errorTag(error) !== undefined;
}

export function isTransientDbError(error: unknown): boolean {
  const tag = errorTag(error);
  if (tag !== undefined && transientTags.has(tag)) return true;
  const mysql = driverCode(error);
  return mysql.deadlock || mysql.lockWait || mysql.connection;
}

export function isCasConflict(error: unknown): boolean {
  return errorTag(error) === "CasConflict";
}

/** Lease remains valid across driver blips and application deadlines. */
export function isLeaseSafeFailure(error: unknown): boolean {
  return isTransientDbError(error) || errorTag(error) === "Timeout";
}

function driverCode(error: unknown): {
  deadlock: boolean;
  lockWait: boolean;
  connection: boolean;
} {
  const current = error as { errno?: number; code?: string; cause?: unknown };
  const errno = current?.errno;
  const code = current?.code;
  const deadlock = errno === 1213 || code === "ER_LOCK_DEADLOCK";
  const lockWait = errno === 1205 || code === "ER_LOCK_WAIT_TIMEOUT";
  const connection = errno === 2006 || errno === 2013 || errno === 1053 ||
    code === "PROTOCOL_CONNECTION_LOST" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    code === "CR_SERVER_LOST" ||
    code === "CR_SERVER_GONE_ERROR" ||
    code === "PROTOCOL_ENQUEUE_AFTER_QUIT" ||
    code === "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR";
  if (deadlock || lockWait || connection || current?.cause === undefined) {
    return { deadlock, lockWait, connection };
  }
  const nested = driverCode(current.cause);
  return {
    deadlock: deadlock || nested.deadlock,
    lockWait: lockWait || nested.lockWait,
    connection: connection || nested.connection,
  };
}

function contextFields(hints?: { sql?: string }): DbErrorFields {
  const store = boundaries.getStore();
  const sql = hints?.sql?.slice(0, 500);
  return {
    op: store?.op ?? "mysql",
    ...(store?.sessionId !== undefined ? { sessionId: store.sessionId } : {}),
    ...(store?.sandboxId !== undefined ? { sandboxId: store.sandboxId } : {}),
    ...(store?.timeoutMs !== undefined ? { timeoutMs: store.timeoutMs } : {}),
    ...(sql !== undefined ? { sql } : {}),
  };
}

export function classifySqlDriverError(
  error: unknown,
  hints?: { sql?: string },
): unknown {
  if (isTaggedDbError(error)) return error;
  const fields = { ...contextFields(hints), cause: error };
  const mysql = driverCode(error);
  if (mysql.deadlock) return new Deadlock(fields);
  if (mysql.lockWait) return new LockWaitTimeout(fields);
  if (mysql.connection) return new ConnectionLost(fields);
  return error;
}

function noteRetries(count: number, tag: string | undefined): void {
  if (count <= 0) return;
  const store = boundaries.getStore();
  if (!store) return;
  store.retryCount += count;
  if (tag !== undefined) store.lastErrorTag = tag;
}

/**
 * Retry a whole transaction (or one autocommit statement) on 1213, 1205,
 * and lost connections. Emits nothing by itself: the surrounding
 * {@link withDbBoundary} writes one summary record.
 */
export async function retryTransientDb<A>(
  operation: () => Promise<A>,
  hints?: { sql?: string },
): Promise<A> {
  const failures = { n: 0, tag: undefined as string | undefined };
  const program = Effect.retry(
    Effect.tryPromise({
      try: operation,
      catch: (error: unknown) => classifySqlDriverError(error, hints),
    }),
    {
      schedule: transientDbRetrySchedule,
      while: (error: unknown) => {
        const transient = isTransientDbError(error);
        if (transient) {
          failures.n += 1;
          failures.tag = errorTag(error);
        }
        return transient;
      },
    },
  );
  const exit = await Effect.runPromiseExit(program);
  if (Exit.isSuccess(exit)) {
    noteRetries(failures.n, failures.tag);
    return exit.value;
  }
  // `while` runs once per retry the schedule actually performs, not for the
  // final failure that is returned to the caller.
  noteRetries(failures.n, failures.tag);
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  throw Cause.squash(exit.cause);
}

export interface DbBoundaryInput {
  op: string;
  sessionId?: string;
  sandboxId?: string;
  timeoutMs?: number;
}

/**
 * One structured record per logical DB call. Nested boundaries (a sweep
 * inside a claim) each emit their own line.
 */
export async function withDbBoundary<A>(
  input: DbBoundaryInput,
  operation: () => Promise<A>,
): Promise<A> {
  const store: BoundaryStore = {
    op: input.op,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.sandboxId !== undefined ? { sandboxId: input.sandboxId } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    retryCount: 0,
  };
  const started = Date.now();
  let outcome: DbBoundaryLog["outcome"] = "ok";
  let errorTagSeen: string | undefined;
  try {
    return await boundaries.run(store, () =>
      input.timeoutMs === undefined
        ? operation()
        : raceTimeout(operation(), input.timeoutMs, store),
    );
  } catch (error) {
    outcome = "error";
    errorTagSeen = errorTag(error) ?? "unknown";
    throw error;
  } finally {
    const tag = outcome === "error" ? errorTagSeen : store.lastErrorTag;
    emitDbBoundaryLog({
      op: store.op,
      ...(store.sessionId !== undefined ? { sessionId: store.sessionId } : {}),
      ...(store.sandboxId !== undefined ? { sandboxId: store.sandboxId } : {}),
      ...(store.timeoutMs !== undefined ? { timeoutMs: store.timeoutMs } : {}),
      durationMs: Date.now() - started,
      retryCount: store.retryCount,
      outcome,
      ...(tag !== undefined ? { errorTag: tag } : {}),
    });
  }
}

function raceTimeout<A>(
  operation: Promise<A>,
  timeoutMs: number,
  store: BoundaryStore,
): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<A>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Timeout({
        op: store.op,
        ...(store.sessionId !== undefined ? { sessionId: store.sessionId } : {}),
        ...(store.sandboxId !== undefined ? { sandboxId: store.sandboxId } : {}),
        timeoutMs,
        cause: new Error(`${store.op} timed out after ${timeoutMs}ms`),
      }));
    }, timeoutMs);
    operation.then(resolve, reject);
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function processFailureRecord(
  kind: "unhandled_rejection" | "uncaught_exception",
  reason: unknown,
): {
  op: string;
  errorTag: string;
  message: string;
  stack?: string;
  sessionId?: string;
  sandboxId?: string;
} {
  const tag = errorTag(reason) ?? "unknown";
  const error = reason instanceof Error ? reason : undefined;
  const fields = isTaggedDbError(reason) ? reason : undefined;
  return {
    op: `process.${kind}`,
    errorTag: tag,
    message: error?.message ?? String(reason),
    ...(error?.stack !== undefined ? { stack: error.stack } : {}),
    ...(fields?.sessionId !== undefined ? { sessionId: fields.sessionId } : {}),
    ...(fields?.sandboxId !== undefined ? { sandboxId: fields.sandboxId } : {}),
  };
}
