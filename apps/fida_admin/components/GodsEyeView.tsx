'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

type DriverUpdate = {
  id: string;
  lat: number;
  lng: number;
  status: 'online' | 'busy';
  trip_id: string | null;
};

type DriverAnimationState = {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  status: 'online' | 'busy';
  tripId: string | null;
  startedAt: number;
  lastSeenAt: number;
};

type AdminMetrics = {
  active_trips: number;
  available_drivers: number;
  flagged_fraud_alerts: number;
  gross_marketplace_revenue: string;
  currency: string;
  generated_at: string;
};

type StreamState = 'connecting' | 'live' | 'reconnecting' | 'offline';

type GodsEyeViewProps = {
  streamUrl?: string;
  mapStyleUrl?: string;
  apiBasePath?: string;
  adminToken?: string;
};

const STREAM_PROTOCOL = 'fida-admin.v1';
const INTERPOLATION_MS = 900;
const SOURCE_RENDER_INTERVAL_MS = 100;
const DRIVER_STALE_AFTER_MS = 35_000;
const METRICS_POLL_MS = 5_000;

const EMPTY_METRICS: AdminMetrics = {
  active_trips: 0,
  available_drivers: 0,
  flagged_fraud_alerts: 0,
  gross_marketplace_revenue: '0',
  currency: 'RWF',
  generated_at: '',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function interpolate(state: DriverAnimationState, now: number): [number, number] {
  const progress = clamp((now - state.startedAt) / INTERPOLATION_MS, 0, 1);
  return [
    state.fromLat + (state.toLat - state.fromLat) * progress,
    state.fromLng + (state.toLng - state.fromLng) * progress,
  ];
}

function isDriverUpdate(value: unknown): value is DriverUpdate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<DriverUpdate>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.lat === 'number' &&
    Number.isFinite(candidate.lat) &&
    candidate.lat >= -90 &&
    candidate.lat <= 90 &&
    typeof candidate.lng === 'number' &&
    Number.isFinite(candidate.lng) &&
    candidate.lng >= -180 &&
    candidate.lng <= 180 &&
    (candidate.status === 'online' || candidate.status === 'busy') &&
    (candidate.trip_id === null || typeof candidate.trip_id === 'string')
  );
}

function base64Url(value: string): string {
  return window
    .btoa(value)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function formatMoney(amount: string, currency: string): string {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return `${currency} 0`;
  try {
    return new Intl.NumberFormat('en-RW', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(parsed);
  } catch {
    return `${currency} ${Math.round(parsed).toLocaleString('en-US')}`;
  }
}

export function GodsEyeView({
  streamUrl = process.env.NEXT_PUBLIC_ADMIN_STREAM_URL ?? 'ws://127.0.0.1:8090/admin/stream',
  mapStyleUrl =
    process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? 'https://demotiles.maplibre.org/style.json',
  apiBasePath = '/core',
  adminToken,
}: GodsEyeViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const driversRef = useRef(new Map<string, DriverAnimationState>());
  const animationFrameRef = useRef<number | null>(null);
  const lastSourceRenderAtRef = useRef(0);
  const lastCountRenderAtRef = useRef(0);
  const viewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [visibleDrivers, setVisibleDrivers] = useState(0);
  const [metrics, setMetrics] = useState<AdminMetrics>(EMPTY_METRICS);
  const [metricsError, setMetricsError] = useState(false);

  const sendViewport = useCallback(() => {
    const map = mapRef.current;
    const socket = socketRef.current;
    if (!map || !socket || socket.readyState !== WebSocket.OPEN) return;

    const bounds = map.getBounds();
    socket.send(
      JSON.stringify({
        type: 'viewport',
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      }),
    );
  }, []);

  const scheduleViewportPush = useCallback(() => {
    if (viewportTimerRef.current) clearTimeout(viewportTimerRef.current);
    viewportTimerRef.current = setTimeout(sendViewport, 200);
  }, [sendViewport]);

  useEffect(() => {
    let disposed = false;

    void import('maplibre-gl').then(({ Map, NavigationControl }) => {
      if (disposed || !containerRef.current) return;

      const map = new Map({
        container: containerRef.current,
        style: mapStyleUrl,
        center: [30.0619, -1.9441],
        zoom: 12,
        attributionControl: true,
      });
      mapRef.current = map;
      map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');

      map.once('load', () => {
        map.addSource('drivers', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        map.addLayer({
          id: 'driver-points',
          type: 'circle',
          source: 'drivers',
          paint: {
            'circle-color': [
              'case',
              ['==', ['get', 'status'], 'busy'],
              '#f59e0b',
              '#22d3ee',
            ],
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 12, 4.5, 16, 7],
            'circle-stroke-color': '#09090b',
            'circle-stroke-width': 1,
            'circle-opacity': 0.92,
          },
        });

        sendViewport();
      });

      map.on('moveend', scheduleViewportPush);
    });

    return () => {
      disposed = true;
      if (viewportTimerRef.current) clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = null;
      const map = mapRef.current;
      if (map) {
        map.off('moveend', scheduleViewportPush);
        map.remove();
      }
      mapRef.current = null;
    };
  }, [mapStyleUrl, scheduleViewportPush, sendViewport]);

  useEffect(() => {
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      if (stopped) return;
      setStreamState(attempt === 0 ? 'connecting' : 'reconnecting');

      const protocols = [STREAM_PROTOCOL];
      if (adminToken) protocols.push(`fida.jwt.${base64Url(adminToken)}`);
      const socket = new WebSocket(streamUrl, protocols);
      socketRef.current = socket;

      socket.onopen = () => {
        attempt = 0;
        setStreamState('live');
        sendViewport();
      };

      socket.onmessage = (event) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!Array.isArray(decoded)) return;

        const now = performance.now();
        for (const value of decoded) {
          if (!isDriverUpdate(value)) continue;
          const previous = driversRef.current.get(value.id);
          const [currentLat, currentLng] = previous
            ? interpolate(previous, now)
            : [value.lat, value.lng];

          driversRef.current.set(value.id, {
            fromLat: currentLat,
            fromLng: currentLng,
            toLat: value.lat,
            toLng: value.lng,
            status: value.status,
            tripId: value.trip_id,
            startedAt: now,
            lastSeenAt: now,
          });
        }
      };

      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (stopped) {
          setStreamState('offline');
          return;
        }
        setStreamState('reconnecting');
        attempt += 1;
        const backoff = Math.min(30_000, 750 * 2 ** Math.min(attempt, 6));
        const jitter = Math.floor(Math.random() * 500);
        retryTimer = setTimeout(connect, backoff + jitter);
      };
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'dashboard unmounted');
    };
  }, [adminToken, sendViewport, streamUrl]);

  useEffect(() => {
    let stopped = false;

    const render = (now: number) => {
      if (stopped) return;

      if (now - lastSourceRenderAtRef.current >= SOURCE_RENDER_INTERVAL_MS) {
        lastSourceRenderAtRef.current = now;
        const features: Array<Record<string, unknown>> = [];

        for (const [id, state] of driversRef.current) {
          if (now - state.lastSeenAt > DRIVER_STALE_AFTER_MS) {
            driversRef.current.delete(id);
            continue;
          }

          const [lat, lng] = interpolate(state, now);
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lng, lat] },
            properties: {
              id,
              status: state.status,
              trip_id: state.tripId ?? '',
            },
          });
        }

        const source = mapRef.current?.getSource('drivers') as GeoJSONSource | undefined;
        source?.setData({
          type: 'FeatureCollection',
          features,
        } as Parameters<GeoJSONSource['setData']>[0]);
      }

      if (now - lastCountRenderAtRef.current >= 1_000) {
        lastCountRenderAtRef.current = now;
        setVisibleDrivers(driversRef.current.size);
      }

      animationFrameRef.current = requestAnimationFrame(render);
    };

    animationFrameRef.current = requestAnimationFrame(render);
    return () => {
      stopped = true;
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const response = await fetch(`${apiBasePath}/admin/metrics`, {
          cache: 'no-store',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`metrics request returned ${response.status}`);
        const payload = (await response.json()) as AdminMetrics;
        if (!stopped) {
          setMetrics(payload);
          setMetricsError(false);
        }
      } catch {
        if (!stopped) setMetricsError(true);
      } finally {
        if (!stopped) timer = setTimeout(load, METRICS_POLL_MS);
      }
    };

    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [apiBasePath]);

  const revenue = useMemo(
    () => formatMoney(metrics.gross_marketplace_revenue, metrics.currency),
    [metrics.currency, metrics.gross_marketplace_revenue],
  );

  const streamLabel =
    streamState === 'live'
      ? 'Live'
      : streamState === 'connecting'
        ? 'Connecting'
        : streamState === 'reconnecting'
          ? 'Reconnecting'
          : 'Offline';

  const cards = [
    { label: 'Active Trips', value: metrics.active_trips.toLocaleString('en-US') },
    { label: 'Available Drivers', value: metrics.available_drivers.toLocaleString('en-US') },
    { label: 'Flagged Fraud Alerts', value: metrics.flagged_fraud_alerts.toLocaleString('en-US') },
    { label: "Today's Gross Revenue", value: revenue },
  ];

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <div ref={containerRef} className="absolute inset-0" aria-label="Live driver operations map" />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-5">
        <section className="pointer-events-auto rounded-2xl border border-white/10 bg-zinc-950/90 px-5 py-4 shadow-2xl backdrop-blur">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Fida-Ride</p>
              <h1 className="text-xl font-semibold tracking-tight">Command Center</h1>
            </div>
            <span className="ml-2 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-300">
              <span
                className={`h-2 w-2 rounded-full ${
                  streamState === 'live' ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
              />
              {streamLabel}
            </span>
          </div>
          <p className="mt-2 text-xs text-zinc-400">{visibleDrivers.toLocaleString('en-US')} drivers visible in current viewport</p>
        </section>

        <aside className="pointer-events-auto grid w-[340px] gap-3">
          {cards.map((card) => (
            <article
              key={card.label}
              className="rounded-2xl border border-white/10 bg-zinc-950/90 px-5 py-4 shadow-2xl backdrop-blur"
            >
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-400">{card.label}</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-white">{card.value}</p>
            </article>
          ))}
          {metricsError ? (
            <p className="rounded-xl border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Metrics refresh failed. Last successful values remain on screen.
            </p>
          ) : null}
        </aside>
      </div>

      <div className="pointer-events-none absolute bottom-5 left-5 flex gap-3 rounded-xl border border-white/10 bg-zinc-950/85 px-4 py-3 text-xs text-zinc-300 backdrop-blur">
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-cyan-400" />Available</span>
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" />Busy</span>
      </div>
    </main>
  );
}
