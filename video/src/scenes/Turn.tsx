import React from "react";
import { C, display, mono } from "../theme";
import { Mark, Wordmark } from "../ui/Wordmark";
import { Words } from "../ui/Words";
import { Fill, In, Kicker, useCue } from "./common";

/** The turn: full-bleed recorder orange, the crack runs across the frame, the wordmark lands on it. */
export const Turn: React.FC = () => {
  const { rel } = useCue("turn");
  const tName = rel("Faultline.");
  return (
    <Fill tone="orange">
      <div style={{ position: "absolute", left: 96, top: 84 }}>
        <In at={tName + 10}><Kicker tone="orange">a plugin for hermes agent</Kicker></In>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 214, display: "flex", justifyContent: "center", alignItems: "flex-end", gap: 44 }}>
        <In at={tName - 2} y={0} style={{ paddingBottom: 46 }}><Mark size={150} bg={C.paperInk} fg={C.orange} /></In>
        <Wordmark size={220} color={C.paperInk} accent={C.paperInk} at={tName} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 648, textAlign: "center", fontFamily: display, fontWeight: 500, fontSize: 66, letterSpacing: "-0.015em", lineHeight: 1.1, color: C.paperInk }}>
        <Words text="A flight recorder for your API, inside Hermes" at={rel("A")} every={3} accent="recorder" accentColor={C.paperInk} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 772, textAlign: "center" }}>
        <In at={rel("inside") + 6}>
          <span style={{ fontFamily: mono, fontSize: 20, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(20,19,17,0.72)" }}>
            record · learn the contract · break it on purpose · prove the fix
          </span>
        </In>
      </div>
    </Fill>
  );
};
