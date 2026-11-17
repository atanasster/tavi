import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Whether an element has come within 200 px of the viewport, once and for good: a card reads its picture then rather
 * than when the list loads. At once where there is no `IntersectionObserver`. `watching` false leaves it unwatched
 * (a card with no picture to read).
 */
export function useNearViewport<T extends Element>(watching = true): readonly [boolean, RefObject<T | null>] {
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  const frame = useRef<T>(null);
  useEffect(() => {
    if (!watching || near || frame.current === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [watching, near]);
  return [near, frame];
}
