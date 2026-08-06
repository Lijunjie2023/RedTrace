import type { ResponseMetaSchema } from "@readtrace/contracts";
import { useSyncExternalStore } from "react";

export type ResponseMeta = ReturnType<typeof ResponseMetaSchema.parse>;

let currentMeta: ResponseMeta | null = null;
const listeners = new Set<() => void>();

export function publishMeta(meta: ResponseMeta): void {
  currentMeta = meta;
  listeners.forEach((listener) => listener());
}

export function useResponseMeta(): ResponseMeta | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => currentMeta,
    () => null
  );
}
