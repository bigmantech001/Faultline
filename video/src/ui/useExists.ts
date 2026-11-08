import React, { useEffect, useState } from "react";
import { Audio, continueRender, delayRender, staticFile } from "remotion";

const cache = new Map<string, boolean>();

/** Whether a file under public/ exists, checked once per file with a HEAD request (null while unknown). */
export function useStaticExists(file: string): boolean | null {
  const [state, setState] = useState<boolean | null>(cache.has(file) ? (cache.get(file) as boolean) : null);
  useEffect(() => {
    if (cache.has(file)) { setState(cache.get(file) as boolean); return; }
    const h = delayRender(`exists ${file}`);
    fetch(staticFile(file), { method: "HEAD" })
      .then((r) => { cache.set(file, r.ok); setState(r.ok); })
      .catch(() => { cache.set(file, false); setState(false); })
      .finally(() => continueRender(h));
  }, [file]);
  return state;
}

/** An <Audio> that simply stays silent when its file has not been generated yet. */
export const MaybeAudio: React.FC<{ file: string; volume?: number | ((f: number) => number) }> = ({ file, volume = 1 }) => {
  const ok = useStaticExists(file);
  if (!ok) return null;
  return React.createElement(Audio, { src: staticFile(file), volume });
};
