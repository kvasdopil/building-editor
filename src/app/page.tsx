"use client";

import dynamic from "next/dynamic";

const MapView = dynamic(() => import("@/components/MapView").then((m) => m.MapView), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center text-slate-500">Loading map…</div>
  ),
});

export default function Home() {
  return <MapView />;
}
