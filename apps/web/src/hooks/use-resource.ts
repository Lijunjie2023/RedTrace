import { useCallback, useEffect, useRef, useState } from "react";

export interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: unknown;
  retry: () => void;
}

export function useResource<T>(loader: () => Promise<T>, dependencies: readonly unknown[]): ResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const activeRequest = ++requestId.current;
    setError(null);
    if (data === null) setLoading(true);
    else setRefreshing(true);

    void loader()
      .then((nextData) => {
        if (activeRequest !== requestId.current) return;
        setData(nextData);
        setError(null);
      })
      .catch((nextError: unknown) => {
        if (activeRequest !== requestId.current) return;
        setError(nextError);
      })
      .finally(() => {
        if (activeRequest !== requestId.current) return;
        setLoading(false);
        setRefreshing(false);
      });
  }, [...dependencies, attempt]);

  return { data, loading, refreshing, error, retry };
}
