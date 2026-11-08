import React from "react";
import { C, display, mono } from "../theme";
import { Mark, Wordmark } from "../ui/Wordmark";
import { Words } from "../ui/Words";
import { Fill, In, Kicker, useCue } from "./common";

/** The close: the mark, the wordmark, the line, where to get it. `repo` is a text prop until the owner is known. */
export const Close: React.FC<{ repo?: string; event?: string }> = ({ repo = "Faultline on GitHub", event = "Hermes Agent Plugin Hackathon" }) => {
  const { rel } = useCue("close");
  const tName = rel("Faultline.");
  const tRecord = rel("Record");
  const tHermes = rel("Hermes");
  return (
    <Fill tone="orange">
      <div style={{ position: "absolute", left: 96, top: 84 }}>
        <In at={tHermes}><Kicker tone="orange">{event}</Kicker></In>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 196, display: "flex", justifyContent: "center", alignItems: "flex-end", gap: 40 }}>
        <In at={tName - 2} y={0} style={{ paddingBottom: 42 }}><Mark size={128} bg={C.paperInk} fg={C.orange} /></In>
        <Wordmark size={190} color={C.paperInk} accent={C.paperInk} at={tName} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 486, textAlign: "center", fontFamily: display, fontWeight: 500, fontSize: 58, letterSpacing: "-0.015em", color: C.paperInk }}>
        <Words text="A plugin for Hermes Agent" at={rel("A")} every={3} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 600, textAlign: "center", fontFamily: display, fontWeight: 700, fontSize: 132, lineHeight: 1, letterSpacing: "-0.03em", textTransform: "uppercase", color: C.paperInk }}>
        <Words text="Record it." at={tRecord - 2} every={5} />
        <Words text="Prove it." at={rel("Prove") - 2} every={5} accent="prove" accentColor={C.paperInk} />
      </div>
      <div style={{ position: "absolute", left: 96, right: 96, top: 884, display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: mono, fontSize: 26, color: C.paperInk }}>
        <In at={tHermes + 4} y={10}><span style={{ fontWeight: 600 }}>{repo}</span></In>
        <In at={tHermes + 10} y={10}><span style={{ letterSpacing: "0.1em", textTransform: "uppercase", fontSize: 20, color: "rgba(20,19,17,0.72)" }}>record · contract · chaos · replay</span></In>
      </div>
    </Fill>
  );
};
