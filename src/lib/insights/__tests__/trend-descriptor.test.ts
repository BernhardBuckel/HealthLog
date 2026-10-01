import { describe, it, expect } from "vitest";
import {
  computeTrendDescriptor,
  numericDescriptorCopy,
  moodDescriptorCopy,
  MOOD_DESCRIPTOR_CONFIG,
  TREND_SLOT_DESCRIPTOR_META,
} from "../trend-descriptor";

/**
 * v1.11.4 item J — deterministic Trends-row caption descriptor.
 *
 * The helper turns the same series the mini-chart plots into a neutral,
 * observational direction + magnitude. These tests pin the direction
 * classification, the stability floor, the first-vs-last delta, and the
 * per-metric copy resolution (numeric template vs categorical mood copy).
 */

function series(values: number[]): { timestamp: number; value: number }[] {
  // One point per day, ascending; timestamps don't affect direction
  // (first-vs-last) but anchor the chronological sort.
  return values.map((value, i) => ({
    timestamp: Date.UTC(2026, 0, 1 + i, 12),
    value,
  }));
}

describe("computeTrendDescriptor", () => {
  it("returns null for fewer than two points", () => {
    expect(computeTrendDescriptor([])).toBeNull();
    expect(computeTrendDescriptor(series([120]))).toBeNull();
  });

  it("classifies a clear upward move as rising with a signed delta", () => {
    const d = computeTrendDescriptor(series([120, 124, 128]), {
      absoluteFloor: 2,
      relativeFloor: 0.02,
      decimals: 0,
    });
    expect(d).not.toBeNull();
    expect(d?.direction).toBe("rising");
    expect(d?.delta).toBe(8);
    expect(d?.magnitude).toBe(8);
    expect(d?.pointCount).toBe(3);
  });

  it("classifies a clear downward move as falling with a negative delta", () => {
    const d = computeTrendDescriptor(series([82.4, 81.5, 81.0]), {
      absoluteFloor: 0.3,
      relativeFloor: 0.01,
      decimals: 1,
    });
    expect(d?.direction).toBe("falling");
    expect(d?.delta).toBe(-1.4);
    expect(d?.magnitude).toBe(1.4);
  });

  it("classifies a within-floor move as stable", () => {
    // +1 mmHg over the window is inside the 2-mmHg absolute floor.
    const d = computeTrendDescriptor(series([120, 121]), {
      absoluteFloor: 2,
      relativeFloor: 0.02,
      decimals: 0,
    });
    expect(d?.direction).toBe("stable");
    expect(d?.delta).toBe(1);
  });

  it("uses the relative floor when it exceeds the absolute floor", () => {
    // 2 % of 10000 steps = 200; a +150 move reads stable.
    const d = computeTrendDescriptor(series([10000, 10150]), {
      absoluteFloor: 0,
      relativeFloor: 0.02,
      decimals: 0,
    });
    expect(d?.direction).toBe("stable");
  });

  it("sorts unordered points chronologically before first-vs-last", () => {
    const unordered = [
      { timestamp: Date.UTC(2026, 0, 3, 12), value: 128 },
      { timestamp: Date.UTC(2026, 0, 1, 12), value: 120 },
      { timestamp: Date.UTC(2026, 0, 2, 12), value: 124 },
    ];
    const d = computeTrendDescriptor(unordered, {
      absoluteFloor: 2,
      relativeFloor: 0.02,
      decimals: 0,
    });
    expect(d?.direction).toBe("rising");
    expect(d?.delta).toBe(8);
  });

  it("drops non-finite points", () => {
    const d = computeTrendDescriptor(
      [
        { timestamp: Date.UTC(2026, 0, 1, 12), value: 120 },
        { timestamp: Date.UTC(2026, 0, 2, 12), value: Number.NaN },
        { timestamp: Date.UTC(2026, 0, 3, 12), value: 128 },
      ],
      { absoluteFloor: 2, relativeFloor: 0.02, decimals: 0 },
    );
    expect(d?.pointCount).toBe(2);
    expect(d?.direction).toBe("rising");
  });
});

describe("numericDescriptorCopy", () => {
  it("states a preference-bound slot in the unit the caller resolves", () => {
    const d = computeTrendDescriptor(series([181.6, 178.5]), {
      absoluteFloor: 0.66,
      relativeFloor: 0.01,
      decimals: 1,
    })!;
    const copy = numericDescriptorCopy("weight", d, (type) =>
      type === "WEIGHT" ? "lb" : "?",
    );
    expect(copy?.params.unit).toBe(" lb");
    expect(TREND_SLOT_DESCRIPTOR_META.distance.unitType).toBe(
      "WALKING_RUNNING_DISTANCE",
    );
    expect(TREND_SLOT_DESCRIPTOR_META.body_temp.unitType).toBe(
      "BODY_TEMPERATURE",
    );
  });

  it("resolves the rising template with a signed delta and spaced unit", () => {
    const d = computeTrendDescriptor(series([120, 128]), {
      absoluteFloor: 2,
      relativeFloor: 0.02,
      decimals: 0,
    })!;
    const copy = numericDescriptorCopy("bp", d, () => "unused");
    expect(copy?.key).toBe("insights.trendDescriptor.rising");
    expect(copy?.params.delta).toBe("+8");
    expect(copy?.params.unit).toBe(" mmHg");
  });

  it("renders a unit-less metric without a dangling space", () => {
    const d = computeTrendDescriptor(series([8000, 9500]), {
      absoluteFloor: 300,
      relativeFloor: 0.05,
      decimals: 0,
    })!;
    const copy = numericDescriptorCopy("steps", d, () => "unused");
    expect(copy?.key).toBe("insights.trendDescriptor.rising");
    expect(copy?.params.unit).toBe("");
  });

  it("uses a minus sign glyph for a falling delta", () => {
    const d = computeTrendDescriptor(series([82.4, 81.0]), {
      absoluteFloor: 0.3,
      relativeFloor: 0.01,
      decimals: 1,
    })!;
    const copy = numericDescriptorCopy("weight", d, () => "kg");
    expect(copy?.key).toBe("insights.trendDescriptor.falling");
    expect(copy?.params.delta).toBe("−1.4");
  });

  it("returns null for a slot with no numeric meta (mood)", () => {
    const d = computeTrendDescriptor(series([3, 4]), MOOD_DESCRIPTOR_CONFIG)!;
    expect(numericDescriptorCopy("mood", d, () => "")).toBeNull();
  });

  it("covers every numeric slot in the descriptor meta", () => {
    // Each meta-backed slot resolves a copy key — guards against a slot
    // added to the chart selector without a descriptor config.
    for (const metric of Object.keys(TREND_SLOT_DESCRIPTOR_META)) {
      const d = computeTrendDescriptor(series([1, 100]), {
        absoluteFloor: 0,
        relativeFloor: 0,
        decimals: 1,
      })!;
      expect(numericDescriptorCopy(metric, d, () => "u")).not.toBeNull();
    }
  });
});

describe("moodDescriptorCopy", () => {
  it("maps rising mood to the improved copy", () => {
    const d = computeTrendDescriptor(series([3, 4]), MOOD_DESCRIPTOR_CONFIG)!;
    expect(d.direction).toBe("rising");
    expect(moodDescriptorCopy(d).key).toBe(
      "insights.trendDescriptor.moodImproved",
    );
  });

  it("maps falling mood to the declined copy", () => {
    const d = computeTrendDescriptor(series([4, 3]), MOOD_DESCRIPTOR_CONFIG)!;
    expect(d.direction).toBe("falling");
    expect(moodDescriptorCopy(d).key).toBe(
      "insights.trendDescriptor.moodDeclined",
    );
  });

  it("maps a within-floor mood move to the stable copy", () => {
    // 0.2 points is inside the 0.3 mood floor.
    const d = computeTrendDescriptor(
      series([3.5, 3.7]),
      MOOD_DESCRIPTOR_CONFIG,
    )!;
    expect(d.direction).toBe("stable");
    expect(moodDescriptorCopy(d).key).toBe(
      "insights.trendDescriptor.moodStable",
    );
  });

  it("carries no interpolation params (no raw point delta in copy)", () => {
    const d = computeTrendDescriptor(series([3, 4]), MOOD_DESCRIPTOR_CONFIG)!;
    expect(moodDescriptorCopy(d).params).toEqual({});
  });
});
