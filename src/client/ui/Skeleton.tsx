/**
 * Placeholders in the shape of what is loading, so the page doesn't jump
 * when it arrives. Hidden from screen readers: the live "Loading ..." text
 * (Loading, in components/ui.tsx) says it instead. The shimmer stops under
 * reduced motion.
 */

export function Skeleton({ width = "100%", height = "1em", radius }: { width?: number | string; height?: number | string; radius?: string }) {
  return <span className="skeleton" aria-hidden="true" style={{ width, height, borderRadius: radius }} />;
}

/** A few lines of text */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="skeleton-text" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? "60%" : "100%"} />
      ))}
    </span>
  );
}
