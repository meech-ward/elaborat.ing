/**
 * Reading-only resource viewer content (parent side).
 *
 * Rendered inside the parent's Base UI Dialog popup, so the overlay fills
 * the workbench instead of the isolated preview frame. Props are path plus
 * the parent-generated SVG only: no API, editor, or save access, and the
 * SVG is shown through a Blob-backed `img`, never inserted as parent DOM.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { darkPicture } from "@/features/drawings/presentation.ts";
import { useAppearance } from "../appearance";
import { DialogClose, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Maximize, Minus, Plus, MoveHorizontal, X } from "lucide-react";
import {
  fitView,
  fitWidthView,
  stepViewScale,
  scaleViewAt,
  MAX_VIEW_SCALE,
  type ResourceView,
} from "./resourceViewer.ts";
import "./resourceViewer.css";

function kindForPath(path: string): "Drawing" | "Diagram" {
  return path.endsWith(".d2") ? "Diagram" : "Drawing";
}

export function ResourceViewer(props: { path: string; svg: string }): React.ReactNode {
  const { path, svg } = props;
  const [manualView, setManualView] = useState<ResourceView | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0, aspect: 1 });
  const widthView = fitWidthView(size.width, size.height, size.aspect);
  // Bound zoom relative to reading width, not a tiny whole-drawing fit.
  const maximumScale = widthView.scale * MAX_VIEW_SCALE;
  const view = manualView ?? widthView;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image) return;
    const measure = () => setSize({
      width: Math.max(0, viewport.clientWidth - 32),
      height: Math.max(0, viewport.clientHeight - 32),
      aspect: image.naturalWidth / image.naturalHeight || 1,
    });
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    image.addEventListener('load', measure);
    measure();
    return () => { observer.disconnect(); image.removeEventListener('load', measure); };
  }, []);

  // In dark, the picture shows as Excalidraw's dark export draws it, and
  // follows a change of light or dark while open.
  const dark = useAppearance().appearance.scheme === "dark";
  const shown = useMemo(() => (dark ? darkPicture(svg) : svg), [dark, svg]);

  // Parent-generated pixels only: a Blob URL keeps the SVG out of the
  // parent DOM (no innerHTML, no script execution). Revoked on cleanup.
  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    const blob = new Blob([shown], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    image.src = url;
    return () => {
      image.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [shown]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const deltaUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      if (!event.ctrlKey && !event.metaKey) {
        setManualView((current) => {
          const base = current ?? widthView;
          return { ...base, x: base.x - event.deltaX * deltaUnit, y: base.y - event.deltaY * deltaUnit };
        });
        return;
      }
      const box = viewport.getBoundingClientRect();
      const anchor = { x: event.clientX - box.x - box.width / 2, y: event.clientY - box.y - box.height / 2 };
      setManualView((current) => {
        const base = current ?? widthView;
        return scaleViewAt(base, base.scale * Math.exp(-event.deltaY * deltaUnit * 0.01), anchor, anchor, maximumScale);
      });
    };
    // React's delegated wheel listener is passive. This surface owns only
    // canvas panning and modifier-wheel zoom, not document scrolling/zoom.
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [widthView, maximumScale]);

  const zoom = (direction: "in" | "out") =>
    setManualView((current) => {
      const base = current ?? widthView;
      return scaleViewAt(base, stepViewScale(base.scale, direction, maximumScale), { x: 0, y: 0 }, { x: 0, y: 0 }, maximumScale);
    });
  const fit = () => {
    pinch.current = null;
    pointers.current.clear();
    setManualView(fitView());
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    viewportRef.current?.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      };
    }
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(event.pointerId);
    if (!prev) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, next);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const before = pinch.current;
      pinch.current = { distance, ...mid };
      if (before && before.distance > 0 && distance > 0) {
        const box = event.currentTarget.getBoundingClientRect();
        const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
        const from = { x: before.x - cx, y: before.y - cy };
        const to = { x: mid.x - cx, y: mid.y - cy };
        setManualView((current) => {
          const base = current ?? widthView;
          return scaleViewAt(base, base.scale * (distance / before.distance), from, to, maximumScale);
        });
      }
      return;
    }
    pinch.current = null;
    // Single-pointer drag pans the zoomed image.
    setManualView((current) => {
      const base = current ?? widthView;
      return { ...base, x: base.x + next.x - prev.x, y: base.y + next.y - prev.y };
    });
  };
  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key;
    if (!['+', '=', '-', '0', 'f', 'w', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return;
    event.preventDefault(); event.stopPropagation();
    if (key === '+' || key === '=') zoom('in');
    else if (key === '-') zoom('out');
    else if (key === '0' || key === 'f') fit();
    else if (key === 'w') setManualView(null);
    else setManualView(current => {
      const base = current ?? widthView;
      return { ...base, x: base.x + (key === 'ArrowLeft' ? 80 : key === 'ArrowRight' ? -80 : 0), y: base.y + (key === 'ArrowUp' ? 80 : key === 'ArrowDown' ? -80 : 0) };
    });
  };

  const kind = kindForPath(path);
  const percent = Math.round(view.scale * 100);
  return (
    <>
      <header className="rv-header">
      <DialogTitle className="rv-title" title={path}>
        {kind}: {path}
      </DialogTitle>
      <DialogDescription className="sr-only">
        Read-only drawing. Drag or scroll to pan; pinch or Ctrl/Command-scroll to zoom.
        Use plus/minus, arrow keys, 0 to fit, or W to fit width when the canvas is focused. Escape closes.
      </DialogDescription>
      <DialogClose render={<Button variant="ghost" className="rv-control" size="icon" aria-label="Close" title="Close (Esc)" />}><X /></DialogClose>
      </header>
      <div className="rv-controls" role="group" aria-label={`${kind} viewer controls`}>
        <Button variant="ghost" size="icon" className="rv-control" onClick={() => zoom('out')} aria-label="Zoom out" title="Zoom out (−)"><Minus /></Button>
        <span className="rv-scale" role="status" aria-label={`Zoom ${percent} percent`} title="Zoom relative to Fit">{percent}%</span>
        <Button variant="ghost" size="icon" className="rv-control" onClick={() => zoom('in')} aria-label="Zoom in" title="Zoom in (+)"><Plus /></Button>
        <span className="rv-divider" aria-hidden="true" />
        <Button variant="ghost" className="rv-control" onClick={fit} title="Fit entire drawing (0)"><Maximize />Fit</Button>
        <Button variant="ghost" size="icon" className="rv-control" onClick={() => setManualView(null)} aria-label="Fit width" title="Fit width (W)"><MoveHorizontal /></Button>
      </div>
      <div
        ref={viewportRef}
        className="rv-viewport"
        tabIndex={0}
        role="region"
        aria-label={`${kind} canvas`}
        onKeyDown={onKeyDown}
        onDoubleClick={fit}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={endPointer}
      >
        <img
          ref={imageRef}
          className="rv-image"
          alt={`${kind} preview of ${path}`}
          draggable={false}
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        />
      </div>
      <div className="rv-hint" aria-hidden="true">Drag to pan · Pinch or Ctrl/⌘ scroll to zoom</div>
    </>
  );
}
