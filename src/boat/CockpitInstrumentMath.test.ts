import { describe, expect, it } from "vitest";
import {
  gaugeValueToAngle,
  headingToCompassAngle,
  projectWorldTargetToHeadUpRadar,
  smoothWrappedAngle,
  type RadarProjection
} from "./CockpitInstrumentMath";

const projection = (): RadarProjection => ({ x: 0, y: 0, distance: 0, visible: false });

describe("CockpitInstrumentMath", () => {
  it("maps and clamps gauge readings to the configured sweep", () => {
    expect(gaugeValueToAngle(0, 0, 100)).toBeCloseTo(3 * Math.PI / 4);
    expect(gaugeValueToAngle(50, 0, 100)).toBeCloseTo(0);
    expect(gaugeValueToAngle(100, 0, 100)).toBeCloseTo(-3 * Math.PI / 4);
    expect(gaugeValueToAngle(-10, 0, 100)).toBeCloseTo(3 * Math.PI / 4);
    expect(gaugeValueToAngle(110, 0, 100)).toBeCloseTo(-3 * Math.PI / 4);
  });

  it("takes the shortest compass path across north", () => {
    const current = headingToCompassAngle(359);
    const next = smoothWrappedAngle(current, headingToCompassAngle(1), 0.5);
    const advancedDegrees = (next - current) * 180 / Math.PI;
    expect(advancedDegrees).toBeCloseTo(1, 5);
  });

  it("maps true-north cardinal headings to compass card rotations", () => {
    expect(headingToCompassAngle(0)).toBeCloseTo(0);
    expect(headingToCompassAngle(90)).toBeCloseTo(Math.PI / 2);
    expect(headingToCompassAngle(180)).toBeCloseTo(Math.PI);
    expect(headingToCompassAngle(270)).toBeCloseTo(3 * Math.PI / 2);
  });

  it("projects world targets into a head-up radar frame", () => {
    const centered = projectWorldTargetToHeadUpRadar(0, 0, 0, 0, 0, 500, projection());
    expect(centered).toMatchObject({ x: 0, y: 0, distance: 0, visible: true });

    const northAhead = projectWorldTargetToHeadUpRadar(0, 100, 0, 0, 0, 500, projection());
    expect(northAhead.x).toBeCloseTo(0);
    expect(northAhead.y).toBeCloseTo(0.2);

    const northToPortWhenHeadingEast = projectWorldTargetToHeadUpRadar(
      0, 100, 90, 0, 0, 500, projection()
    );
    expect(northToPortWhenHeadingEast.x).toBeCloseTo(-0.2);
    expect(northToPortWhenHeadingEast.y).toBeCloseTo(0);
  });

  it("keeps the range boundary visible and rejects targets beyond it", () => {
    expect(projectWorldTargetToHeadUpRadar(0, 500, 0, 0, 0, 500, projection()).visible).toBe(true);
    expect(projectWorldTargetToHeadUpRadar(0, 500.01, 0, 0, 0, 500, projection()).visible).toBe(false);
  });
});
