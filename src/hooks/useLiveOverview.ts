"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Overview } from "@/lib/dashboard-types";

export type ConnectionState = "connecting" | "live" | "polling" | "offline";

const CACHE_KEY = "netmon:lastOverview";

/**
 * جلب حالة الشبكة مباشرة عبر SSE، وعند فشل البث يتحول تلقائيًا إلى
 * التحديث الدوري (Polling)، وعند انقطاع الشبكة بالكامل يعمل من الذاكرة
 * المحلية (localStorage + Service Worker) حتى عودة الاتصال.
 */
export function useLiveOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [browserOnline, setBrowserOnline] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const failuresRef = useRef(0);
  const queueRef = useRef<{ url: string; init: RequestInit }[]>([]);

  const apply = useCallback((overview: Overview, fromCache = false) => {
    setData(overview);
    setLastUpdate(new Date().toISOString());
    if (!fromCache) {
      try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(overview));
      } catch {
        /* storage full or blocked */
      }
    }
  }, []);

  const loadCache = useCallback(() => {
    try {
      const raw = window.localStorage.getItem(CACHE_KEY);
      if (raw) {
        apply(JSON.parse(raw) as Overview, true);
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }, [apply]);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch("/api/overview", { cache: "no-store" });
      if (!res.ok) throw new Error("bad status");
      const overview = (await res.json()) as Overview;
      failuresRef.current = 0;
      apply(overview);
      setState((prev) => (prev === "live" ? prev : "polling"));
      return true;
    } catch {
      failuresRef.current += 1;
      if (failuresRef.current >= 2) {
        setState("offline");
        loadCache();
      }
      return false;
    }
  }, [apply, loadCache]);

  const startPolling = useCallback(
    (intervalMs = 6000) => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => void fetchOnce(), intervalMs);
    },
    [fetchOnce],
  );

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const connectStream = useCallback(() => {
    if (typeof window === "undefined") return;
    try {
      const source = new EventSource("/api/stream");
      sourceRef.current = source;
      source.addEventListener("overview", (event) => {
        try {
          const overview = JSON.parse((event as MessageEvent).data) as Overview;
          failuresRef.current = 0;
          apply(overview);
          setState("live");
          stopPolling();
        } catch {
          /* ignore malformed frame */
        }
      });
      source.onerror = () => {
        source.close();
        sourceRef.current = null;
        setState((prev) => (prev === "offline" ? prev : "polling"));
        startPolling();
      };
    } catch {
      startPolling();
    }
  }, [apply, startPolling, stopPolling]);

  useEffect(() => {
    const hasCache = loadCache();
    if (!hasCache) void fetchOnce();
    connectStream();
    startPolling(15000); // شبكة أمان إذا توقف البث دون إطلاق خطأ

    const goOnline = () => {
      setBrowserOnline(true);
      setState("polling");
      connectStream();
      void flushQueue();
    };
    const goOffline = () => {
      setBrowserOnline(false);
      setState("offline");
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
      stopPolling();
      loadCache();
    };

    setBrowserOnline(navigator.onLine);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      stopPolling();
      if (sourceRef.current) sourceRef.current.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** إرسال الإجراءات المعلقة (تُخزَّن محليًا عند انقطاع الشبكة وتُرسل عند العودة) */
  const flushQueue = useCallback(async () => {
    const queue = queueRef.current;
    if (queue.length === 0) return;
    const remaining: { url: string; init: RequestInit }[] = [];
    for (const item of queue) {
      try {
        const res = await fetch(item.url, item.init);
        if (!res.ok) remaining.push(item);
      } catch {
        remaining.push(item);
      }
    }
    queueRef.current = remaining;
    setPendingActions(remaining.length);
  }, []);

  const send = useCallback(
    async (url: string, init: RequestInit = {}) => {
      try {
        const res = await fetch(url, {
          ...init,
          headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        });
        if (!res.ok) throw new Error("request failed");
        await flushQueue();
        void fetchOnce();
        return (await res.json().catch(() => ({}))) as Record<string, unknown>;
      } catch {
        queueRef.current.push({ url, init });
        setPendingActions(queueRef.current.length);
        try {
          window.localStorage.setItem("netmon:pending", String(queueRef.current.length));
        } catch {
          /* ignore */
        }
        return { ok: false, queued: true } as Record<string, unknown>;
      }
    },
    [fetchOnce, flushQueue],
  );

  return {
    data,
    state,
    browserOnline,
    lastUpdate,
    pendingActions,
    send,
    refresh: fetchOnce,
    flushQueue,
  };
}
