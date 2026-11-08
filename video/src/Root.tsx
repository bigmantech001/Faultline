import React from "react";
import { Composition, Still } from "remotion";
import { Film, FilmProps } from "./Film";
import { Poster } from "./Poster";
import { T } from "./timing";

/** The film (1920x1080 @ 30; the 4K master is rendered with --scale 2) and the thumbnail. */
export const Root: React.FC = () => (
  <>
    <Composition
      id="Faultline" component={Film} durationInFrames={T.totalFrames} fps={T.fps} width={1920} height={1080}
      defaultProps={{ repo: "Faultline on GitHub", event: "Hermes Agent Plugin Hackathon" } satisfies FilmProps}
    />
    <Still id="Poster" component={Poster} width={1920} height={1080} />
  </>
);
