"use client";
/**
 * Small, shared motion helpers. Every effect is skipped when the user prefers reduced motion
 * (globals.css also turns animations and transitions off in that case).
 */
import { useEffect, useState, type RefObject } from "react";

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Rubber-band past the edge: pulling a scroll area beyond its top or bottom moves it a little, with growing
 * resistance, and it springs back on release. Native scrolling is untouched while there is room to scroll.
 */
export function useRubberBand(ref: RefObject<HTMLElement | null>, max = 48) {
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced()) return;
    let startY = 0;
    let pulling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const damp = (d: number) => Math.sign(d) * max * (1 - Math.exp(-Math.abs(d) / (max * 2.5)));
    const set = (y: number, release = false) => {
      el.style.transition = release ? "transform 0.42s cubic-bezier(0.2, 0.9, 0.3, 1.25)" : "none";
      el.style.transform = y ? `translateY(${y}px)` : "";
    };
    const atTop = () => el.scrollTop <= 0;
    const atEnd = () => el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    const onStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      pulling = false;
    };
    const onMove = (e: TouchEvent) => {
      const d = e.touches[0].clientY - startY;
      if ((d > 0 && atTop()) || (d < 0 && atEnd())) {
        pulling = true;
        set(damp(d));
      }
    };
    const onEnd = () => {
      if (pulling) set(0, true);
      pulling = false;
    };
    let wheel = 0;
    const onWheel = (e: WheelEvent) => {
      if ((e.deltaY < 0 && atTop()) || (e.deltaY > 0 && atEnd())) {
        wheel -= e.deltaY;
        set(damp(wheel));
        clearTimeout(timer);
        timer = setTimeout(() => {
          wheel = 0;
          set(0, true);
        }, 120);
      }
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.removeEventListener("wheel", onWheel);
      el.style.transform = "";
      el.style.transition = "";
    };
  }, [ref, max]);
}

/**
 * A required comment box with live feedback: a counter shows how far the comment is from the minimum, and when it
 * gets there the icon crossfades (with a blur) from a ring to a tick and the counter pulses once to confirm.
 */
export function CommentField({ id, name, label, hint, minLength, rows = 4 }: { id: string; name: string; label: string; hint: string; minLength: number; rows?: number }) {
  const [len, setLen] = useState(0);
  const ok = len >= minLength;
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        <span className="req" aria-hidden="true">
          {" "}
          *
        </span>
      </label>
      <textarea id={id} name={name} rows={rows} required minLength={minLength} onChange={(e) => setLen(e.currentTarget.value.trim().length)} aria-describedby={`${id}-meter ${id}-hint`} />
      <span id={`${id}-meter`} className="comment-meter" data-ok={ok || undefined} aria-live="polite">
        <span className="icon-swap" aria-hidden="true" data-state={ok ? "b" : "a"}>
          <span className="icon-a">○</span>
          <span className="icon-b">✓</span>
        </span>
        <span key={ok ? "ok" : "wait"} className={ok ? "pulse-once" : undefined}>
          {ok ? "Comment ready" : `${len}/${minLength} characters minimum`}
        </span>
      </span>
      <span id={`${id}-hint`} className="hint">
        {hint}
      </span>
    </div>
  );
}
