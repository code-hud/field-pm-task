import { useEffect, useRef, useState } from 'react';

/** Measures a container so SVG charts can be laid out in real pixels (no viewBox stretch). */
export function useElementWidth(fallback = 640) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width;
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
