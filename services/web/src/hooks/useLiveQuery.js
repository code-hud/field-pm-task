import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fetch on mount, then poll.
 *
 * `isLoading` is true only for the first load — refetches set `isRefreshing`
 * instead, so the UI can hold the previous render at reduced opacity rather than
 * flashing a skeleton on every tick. Polling pauses while the tab is hidden.
 *
 * <b>`error` and `refreshError` split for exactly the same reason.</b> A request that
 * fails before anything has ever loaded leaves the caller with nothing to draw, and
 * that is `error`. A request that fails *after* data has arrived leaves the caller
 * holding something real and a few seconds old, and that is `refreshError` — a
 * different event, because the right response to it is to keep showing what you have
 * and say the last update failed. Reporting both as `error` is what made a single
 * blip on a four-second poll replace a whole page with an error card, discarding data
 * that was still perfectly good.
 *
 * A success clears both. Nothing else does: an error that has not been superseded by
 * a good response is still true.
 *
 * @param {(signal: AbortSignal) => Promise<unknown>} fetcher
 * @param {{ intervalMs?: number, deps?: unknown[], enabled?: boolean }} options
 */
export function useLiveQuery(fetcher, { intervalMs = 0, deps = [], enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const hasLoaded = useRef(false);
  // The in-flight effect's controller, so `refresh` cancels with the rest.
  const controllerRef = useRef(null);

  const run = useCallback(async (signal) => {
    if (hasLoaded.current) setIsRefreshing(true);
    try {
      const result = await fetcherRef.current(signal);
      if (signal.aborted) return;
      setData(result);
      setError(null);
      setRefreshError(null);
      setUpdatedAt(new Date());
      hasLoaded.current = true;
    } catch (caught) {
      if (caught.name === 'AbortError' || signal.aborted) return;
      // Which of the two depends on whether there is anything on screen to keep.
      // `hasLoaded` is the same flag that decides between the skeleton and the
      // dimmed previous render, and it is answering the same question here.
      if (hasLoaded.current) setRefreshError(caught);
      else setError(caught);
    } finally {
      if (!signal.aborted) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  // A changed dep set is a different query — go back to the loading state.
  useEffect(() => {
    hasLoaded.current = false;
    // A different query has no previous answer to hold on to, so a failure against it
    // is a first failure again.
    setRefreshError(null);
    if (enabled) setIsLoading(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  useEffect(() => {
    if (!enabled) return undefined;

    const controller = new AbortController();
    controllerRef.current = controller;
    run(controller.signal);

    if (!intervalMs) return () => controller.abort();

    let timer = null;
    const start = () => {
      stop();
      timer = setInterval(() => {
        if (!document.hidden) run(controller.signal);
      }, intervalMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    // Catch up immediately when the tab comes back, then resume the cadence.
    const onVisibility = () => {
      if (document.hidden) return;
      run(controller.signal);
      start();
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      controller.abort();
      controllerRef.current = null;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, intervalMs, enabled, ...deps]);

  /**
   * Refetch now, without waiting for the next tick. For the case where something
   * else changed the data — placing an order, say — and polling in a few seconds
   * would leave the page visibly stale in the meantime.
   */
  const refresh = useCallback(() => {
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted) return Promise.resolve();
    return run(signal);
  }, [run]);

  return { data, error, refreshError, isLoading, isRefreshing, updatedAt, refresh };
}
