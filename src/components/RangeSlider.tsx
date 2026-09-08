"use client";

import type { CSSProperties } from "react";

type RangeSliderProps = {
  /** The ends of the track. `min === max` leaves the slider inert. */
  min: number;
  max: number;
  /** The selected window, always within the track and with `low <= high`. */
  low: number;
  high: number;
  step: number;
  onChange: (low: number, high: number) => void;
  /** Reader-facing names for the two handles, e.g. "Lowest height shown". */
  lowLabel: string;
  highLabel: string;
  /** How a value is spoken and shown in a tooltip, e.g. `(v) => "12.4 m"`. */
  format: (value: number) => string;
  /** Paints the selected span; the excluded ends stay grey behind it. */
  fillStyle?: CSSProperties;
  className?: string;
};

/**
 * Both thumbs are hit targets, but neither input's track is: the two inputs are
 * stacked over the same pixels, so a live track would give whichever happens to
 * be on top every press meant for the other. The visible track is drawn behind
 * them instead.
 */
const THUMB =
  "pointer-events-none absolute inset-x-0 top-1/2 h-3 w-full -translate-y-1/2 appearance-none bg-transparent " +
  "focus-visible:outline-none " +
  "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 " +
  "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:cursor-grab " +
  "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border " +
  "[&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-slate-700 " +
  "[&::-webkit-slider-thumb]:shadow-sm " +
  "[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 " +
  "[&::-moz-range-thumb]:cursor-grab [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border " +
  "[&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-slate-700 " +
  "focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-violet-500 " +
  "focus-visible:[&::-moz-range-thumb]:ring-2 focus-visible:[&::-moz-range-thumb]:ring-violet-500";

/**
 * A two-handle slider over a numeric range.
 *
 * Two native range inputs rather than a hand-rolled track: keyboard stepping,
 * the reader announcements and the platform's own touch target all come with
 * them. They are stacked over one drawn track, and clamp against each other on
 * change so a handle dragged past its partner parks against it instead of
 * swapping which one is held.
 */
export default function RangeSlider({
  min,
  max,
  low,
  high,
  step,
  onChange,
  lowLabel,
  highLabel,
  format,
  fillStyle,
  className = "",
}: RangeSliderProps) {
  const span = max - min;
  const inert = span <= 0;
  // The inputs count whole steps from `min` rather than carrying metres. A
  // native range snaps its value to a grid anchored at `min`, so a fractional
  // number of steps would leave the top handle short of `max` — the one place
  // it most needs to reach, since that is what "show everything" means here.
  const steps = inert ? 1 : Math.max(1, Math.round(span / step));
  const toIndex = (value: number) =>
    Math.min(steps, Math.max(0, Math.round(((value - min) / span) * steps)));
  const toValue = (index: number) => (index >= steps ? max : min + (index / steps) * span);
  const ratio = (value: number) => toIndex(value) / steps;

  return (
    <div className={`relative h-3 ${inert ? "opacity-50" : ""} ${className}`}>
      {/* The drawn track is inset by half a thumb at both ends, which is where
          a native range parks its thumb centres. */}
      <div className="pointer-events-none absolute top-1/2 right-1.5 left-1.5 h-1.5 -translate-y-1/2 rounded-full bg-slate-200" />
      <div
        className="pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-slate-500"
        style={{
          left: `calc(${ratio(low)} * (100% - 0.75rem) + 0.375rem)`,
          width: `calc(${Math.max(0, ratio(high) - ratio(low))} * (100% - 0.75rem))`,
          ...fillStyle,
        }}
      />
      <input
        type="range"
        min={0}
        max={steps}
        step={1}
        value={toIndex(low)}
        disabled={inert}
        aria-label={lowLabel}
        aria-valuetext={format(low)}
        title={format(low)}
        onChange={(event) => onChange(Math.min(toValue(event.target.valueAsNumber), high), high)}
        className={THUMB}
        // Both handles sit on the same pixel once the band collapses against an
        // end; the one that can still move away from it takes the press.
        style={{ zIndex: low > (min + max) / 2 ? 2 : 1 }}
      />
      <input
        type="range"
        min={0}
        max={steps}
        step={1}
        value={toIndex(high)}
        disabled={inert}
        aria-label={highLabel}
        aria-valuetext={format(high)}
        title={format(high)}
        onChange={(event) => onChange(low, Math.max(toValue(event.target.valueAsNumber), low))}
        className={THUMB}
        style={{ zIndex: low > (min + max) / 2 ? 1 : 2 }}
      />
    </div>
  );
}
