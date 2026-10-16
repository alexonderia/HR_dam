import { useLayoutEffect, useRef, useState } from "react";

export function StopFactorTag({ text }: { text: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      setLong(element.getBoundingClientRect().height > lineHeight + 0.5);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [text]);
  return <span className={`af-badge tag stop-factor-tag${long ? " stop-factor-tag--long" : ""}`}>
    <span ref={textRef}>{text}</span>
  </span>;
}
