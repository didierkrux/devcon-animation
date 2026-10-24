import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  OffthreadVideo,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import intro from "./intro-meta.json";
import type { Talk } from "./types";

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const DEFAULT_HOLD_SECONDS = 5;

const INTRO_SRC = "intro.webm";

// The intro plays to the end (its audio runs past the reveal); the card then
// stays up until holdSeconds after the iris has fully opened.
export const totalFrames = (fps: number, holdSeconds: number) =>
  Math.ceil(Math.max(intro.durationInSeconds, intro.revealEnd + holdSeconds) * fps);

export type TalkIntroProps = {
  talk: Talk;
  holdSeconds: number;
  // Output size. Both the card and the intro are 16:9 and scale to fill it,
  // so wider screens crop the top and bottom.
  width: number;
  height: number;
};

export const TalkIntro: React.FC<TalkIntroProps> = ({ talk }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  // The card sits under the intro and fades up while the intro's transparent
  // iris opens over it.
  const cardOpacity = interpolate(t, [intro.revealStart, intro.revealEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.quad),
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill style={{ opacity: cardOpacity }}>
        <Img
          src={staticFile(talk.card)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
      <AbsoluteFill>
        <OffthreadVideo
          src={staticFile(INTRO_SRC)}
          transparent
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
