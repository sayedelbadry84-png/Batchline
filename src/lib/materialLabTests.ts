// Digitizes Rhino's own QC lab test forms for received raw materials
// (aggregates, sand, water, liquid admixtures) — one config + one
// calculator per test type, all stored under MaterialLabTest.resultsJson
// as `{ inputs, computed, rows? }`. Every computed value uses the exact
// arithmetic the paper form itself shows in its cells; nothing here
// decides pass/fail — that stays a human call against the spec, entered
// as MaterialLabTest.status, same as the paper form's own REMARKS line.
//
// A few of the source workbook's forms have a genuine bug that would be
// wrong to reproduce silently — most notably "SPECIFIC_GRAVITY_LIQUID",
// whose printed row labels don't match a physically sensible pycnometer
// calculation. Where that happens, the calculator below implements the
// correct standard formula and a comment says so.

export type MaterialLabTestField = {
  key: string;
  label: string; // shown as-is in both locales — matches the source paper forms, which already use English/ASTM notation for these variable names regardless of locale.
  type: "number" | "text" | "select";
  options?: readonly string[];
  required?: boolean;
};

export type MaterialLabTestTypeConfig = {
  key: string;
  astmStandard: string;
  fields: readonly MaterialLabTestField[];
  rowLabels?: readonly string[]; // present only for row-based test types
  rowFields?: readonly MaterialLabTestField[]; // per-row inputs, present only for row-based test types
  computedLabels: Record<string, string>; // key -> display label, for the detail page
};

export const SOUNDNESS_ROW_LABELS: Record<"AGGREGATE" | "SAND", readonly string[]> = {
  AGGREGATE: ['3/8"–#4', '1/2"–3/8"', '3/4"–1/2"', '1"–3/4"', '1 1/2"–1"', '2"–1 1/2"'],
  SAND: ["Finer than #50", "#30–#50", "#16–#30", "#8–#16", "#4–#8", '3/8"–#4'],
};

// The 6 sieves ASTM C136's Fineness Modulus is conventionally summed over.
const FM_SIEVES = ["#4", "#8", "#16", "#30", "#50", "#100"];
export const SIEVE_ANALYSIS_ROW_LABELS = ['1"', '3/4"', '1/2"', '3/8"', "#4", "#8", "#16", "#30", "#50", "#100", "#200"] as const;

export const MATERIAL_LAB_TEST_TYPES = {
  SIEVE_ANALYSIS: {
    key: "SIEVE_ANALYSIS",
    astmStandard: "ASTM C117 / C136",
    fields: [{ key: "sampleWeightG", label: "Weight of sample (g)", type: "number", required: true }],
    rowLabels: SIEVE_ANALYSIS_ROW_LABELS,
    rowFields: [
      { key: "cumWeightRetainedG", label: "Cumulative weight retained (g)", type: "number" },
      { key: "specLimit", label: "Specification limit (ASTM C33)", type: "text" },
    ],
    computedLabels: { finenessModulus: "Fineness Modulus" },
  },
  CLAY_LUMPS: {
    key: "CLAY_LUMPS",
    astmStandard: "ASTM C142",
    fields: [
      { key: "massTestSampleG", label: "A — Mass of test sample (g)", type: "number", required: true },
      { key: "massRetainedSieve8G", label: "B — Mass of particles retained on Sieve #8 (g)", type: "number", required: true },
    ],
    computedLabels: { clayLumpsPct: "Clay Lumps & Friable Particles = (A-B)/A × 100 (%)" },
  },
  SPECIFIC_GRAVITY_AGGREGATE: {
    key: "SPECIFIC_GRAVITY_AGGREGATE",
    astmStandard: "ASTM C127",
    fields: [
      { key: "ovenDryWeightG", label: "A — Weight of oven-dry sample in air (g)", type: "number", required: true },
      { key: "ssdWeightG", label: "B — Weight of SSD sample in air (g)", type: "number", required: true },
      { key: "saturatedWaterWeightG", label: "C — Weight of saturated sample in water (g)", type: "number", required: true },
    ],
    computedLabels: {
      bulkSGOvenDry: "Bulk Specific Gravity (Oven Dry) = A/(B-C)",
      bulkSGSSD: "Bulk Specific Gravity (SSD) = B/(B-C)",
      apparentSG: "Apparent Specific Gravity = A/(A-C)",
      absorptionPct: "Absorption = (B-A)/A × 100 (%)",
    },
  },
  SPECIFIC_GRAVITY_LIQUID: {
    key: "SPECIFIC_GRAVITY_LIQUID",
    astmStandard: "ASTM C494",
    fields: [
      { key: "weightBottleG", label: "W1 — Weight of density bottle (g)", type: "number", required: true },
      { key: "weightBottleWaterG", label: "W2 — Weight of bottle + water (g)", type: "number", required: true },
      { key: "weightBottleSampleG", label: "W4 — Weight of bottle + sample (g)", type: "number", required: true },
      { key: "admixtureType", label: "Type", type: "text" },
      { key: "batchNo", label: "Batch No.", type: "text" },
      { key: "color", label: "Color", type: "text" },
      { key: "odor", label: "Odor", type: "text" },
    ],
    computedLabels: {
      weightWaterG: "Weight of water (g)",
      weightSampleG: "Weight of sample (g)",
      specificGravity: "Specific Gravity",
    },
  },
  MATERIAL_FINER_200: {
    key: "MATERIAL_FINER_200",
    astmStandard: "ASTM C117",
    fields: [
      { key: "originalWeightG", label: "B — Original weight (g)", type: "number", required: true },
      { key: "dryWeightAfterWashingG", label: "C — Dry weight after washing (g)", type: "number", required: true },
    ],
    computedLabels: { finerThan200Pct: "Material Finer than #200 = (B-C)/B × 100 (%)" },
  },
  LA_ABRASION: {
    key: "LA_ABRASION",
    astmStandard: "ASTM C131",
    fields: [
      { key: "grading", label: "Grading", type: "text" },
      { key: "numberOfSpheres", label: "Number of spheres", type: "number" },
      { key: "numberOfRevolutions", label: "Number of revolutions", type: "number" },
      { key: "totalWeightSampleG", label: "A — Total weight of sample (g)", type: "number", required: true },
      { key: "weightRetainedSieve12G", label: "B — Weight retained on Sieve #12 after test (g)", type: "number", required: true },
    ],
    computedLabels: { lossPct: "Loss = (A-B)/A × 100 (%)" },
  },
  MOISTURE_CONTENT: {
    key: "MOISTURE_CONTENT",
    astmStandard: "ASTM C566",
    fields: [
      { key: "weightPanG", label: "Weight of pan (g)", type: "number", required: true },
      { key: "weightPanAggG", label: "Weight of pan + aggregate (g)", type: "number", required: true },
      { key: "weightPanOvenDryAggG", label: "Weight of pan + oven-dry aggregate (g)", type: "number", required: true },
    ],
    computedLabels: {
      waterWeightG: "Weight of water (g)",
      ovenDryAggWeightG: "Weight of oven-dry aggregate (g)",
      moisturePct: "Moisture Content (%)",
    },
  },
  ORGANIC_IMPURITIES: {
    key: "ORGANIC_IMPURITIES",
    astmStandard: "ASTM C40",
    fields: [
      {
        key: "colorRating",
        label: "Glass color standard rating",
        type: "select",
        options: ["1_LIGHTER", "2_LIGHTER", "3_STANDARD", "4_DARKER", "5_DARKER"],
        required: true,
      },
    ],
    computedLabels: {},
  },
  UNIT_WEIGHT_AGGREGATE: {
    key: "UNIT_WEIGHT_AGGREGATE",
    astmStandard: "ASTM C29",
    fields: [
      { key: "weightContainerKg", label: "Weight of container (kg)", type: "number", required: true },
      { key: "volumeContainerM3", label: "Volume of container (m³)", type: "number", required: true },
      { key: "weightAggContainerLooseKg", label: "Weight of aggregate + container, loose (kg)", type: "number" },
      { key: "weightAggContainerRoddedKg", label: "Weight of aggregate + container, rodded (kg)", type: "number" },
    ],
    computedLabels: {
      bulkDensityLooseKgM3: "Bulk Density, Loose (kg/m³)",
      bulkDensityRoddedKgM3: "Bulk Density, Rodded (kg/m³)",
    },
  },
  SAND_EQUIVALENT: {
    key: "SAND_EQUIVALENT",
    astmStandard: "ASTM D2419",
    fields: [
      { key: "sandReading1", label: "Sand reading — trial 1 (A)", type: "number", required: true },
      { key: "clayReading1", label: "Clay reading — trial 1 (B)", type: "number", required: true },
      { key: "sandReading2", label: "Sand reading — trial 2 (A)", type: "number" },
      { key: "clayReading2", label: "Clay reading — trial 2 (B)", type: "number" },
    ],
    computedLabels: { se1: "Sand Equivalent, trial 1 = A/B × 100 (%)", se2: "Sand Equivalent, trial 2 (%)", average: "Average (%)" },
  },
  AGGREGATE_IMPACT_VALUE: {
    key: "AGGREGATE_IMPACT_VALUE",
    astmStandard: "BS 812: Part 112",
    fields: [
      { key: "weightSampleG", label: "A — Weight of sample (g)", type: "number", required: true },
      { key: "weightPassing236mmG", label: "B — Weight of fraction passing 2.36mm (g)", type: "number", required: true },
    ],
    computedLabels: { aivPct: "Aggregate Impact Value = B/A × 100 (%)" },
  },
  SOUNDNESS_TEST: {
    key: "SOUNDNESS_TEST",
    astmStandard: "ASTM C88",
    fields: [{ key: "materialCategory", label: "Material category", type: "select", options: ["AGGREGATE", "SAND"], required: true }],
    rowLabels: [], // resolved at render/compute time from materialCategory — see SOUNDNESS_ROW_LABELS
    rowFields: [
      { key: "pctRetained", label: "% Retained", type: "number" },
      { key: "weightBeforeG", label: "Weight before test (g)", type: "number" },
      { key: "weightAfterG", label: "Weight after test (g)", type: "number" },
    ],
    computedLabels: { totalWeightedPctLoss: "Total Weighted % Loss" },
  },
  WATER_PH_TDS: {
    key: "WATER_PH_TDS",
    astmStandard: "ASTM D1239 / D1888",
    fields: [
      { key: "phValue", label: "pH @ 25°C", type: "number" },
      { key: "phSpec", label: "pH specification", type: "text" },
      { key: "tdsValue", label: "Total Dissolved Solids", type: "number" },
      { key: "tdsUnit", label: "TDS unit", type: "select", options: ["ppm", "ppt"] },
      { key: "tdsSpec", label: "TDS specification", type: "text" },
    ],
    computedLabels: {},
  },
} as const satisfies Record<string, MaterialLabTestTypeConfig>;

export type MaterialLabTestType = keyof typeof MATERIAL_LAB_TEST_TYPES;
export const MATERIAL_LAB_TEST_TYPE_KEYS = Object.keys(MATERIAL_LAB_TEST_TYPES) as MaterialLabTestType[];

function num(formData: FormData, key: string): number | undefined {
  const raw = formData.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && raw !== "" ? n : undefined;
}
function str(formData: FormData, key: string): string | undefined {
  const raw = formData.get(key);
  const s = typeof raw === "string" ? raw.trim() : "";
  return s || undefined;
}

export type MaterialLabTestResults = {
  inputs: Record<string, number | string | undefined>;
  computed: Record<string, number | undefined>;
  rows?: Array<Record<string, number | string | undefined>>;
};

// Reads the raw form fields for `testType` and computes the same values the
// paper form's own cells show — returns null only if a genuinely required
// field is missing (the action layer rejects the submission in that case).
export function computeMaterialLabTestResults(testType: MaterialLabTestType, formData: FormData): MaterialLabTestResults | null {
  switch (testType) {
    case "SIEVE_ANALYSIS": {
      const sampleWeightG = num(formData, "sampleWeightG");
      if (!sampleWeightG) return null;
      const rows = SIEVE_ANALYSIS_ROW_LABELS.map((label, i) => {
        const cumWeightRetainedG = num(formData, `row_${i}_cumWeightRetainedG`);
        const specLimit = str(formData, `row_${i}_specLimit`);
        const retainedPct = cumWeightRetainedG != null ? (cumWeightRetainedG / sampleWeightG) * 100 : undefined;
        const passingPct = retainedPct != null ? 100 - retainedPct : undefined;
        return { label, cumWeightRetainedG, specLimit, retainedPct, passingPct };
      });
      const fmRetained = FM_SIEVES.map((s) => rows.find((r) => r.label === s)?.retainedPct).filter((v): v is number => v != null);
      const finenessModulus = fmRetained.length === FM_SIEVES.length ? fmRetained.reduce((a, b) => a + b, 0) / 100 : undefined;
      return { inputs: { sampleWeightG }, computed: { finenessModulus }, rows };
    }
    case "CLAY_LUMPS": {
      const massTestSampleG = num(formData, "massTestSampleG");
      const massRetainedSieve8G = num(formData, "massRetainedSieve8G");
      if (massTestSampleG == null || massRetainedSieve8G == null) return null;
      const clayLumpsPct = ((massTestSampleG - massRetainedSieve8G) / massTestSampleG) * 100;
      return { inputs: { massTestSampleG, massRetainedSieve8G }, computed: { clayLumpsPct } };
    }
    case "SPECIFIC_GRAVITY_AGGREGATE": {
      const ovenDryWeightG = num(formData, "ovenDryWeightG");
      const ssdWeightG = num(formData, "ssdWeightG");
      const saturatedWaterWeightG = num(formData, "saturatedWaterWeightG");
      if (ovenDryWeightG == null || ssdWeightG == null || saturatedWaterWeightG == null) return null;
      const bulkSGOvenDry = ovenDryWeightG / (ssdWeightG - saturatedWaterWeightG);
      const bulkSGSSD = ssdWeightG / (ssdWeightG - saturatedWaterWeightG);
      const apparentSG = ovenDryWeightG / (ovenDryWeightG - saturatedWaterWeightG);
      const absorptionPct = ((ssdWeightG - ovenDryWeightG) / ovenDryWeightG) * 100;
      return { inputs: { ovenDryWeightG, ssdWeightG, saturatedWaterWeightG }, computed: { bulkSGOvenDry, bulkSGSSD, apparentSG, absorptionPct } };
    }
    case "SPECIFIC_GRAVITY_LIQUID": {
      const weightBottleG = num(formData, "weightBottleG");
      const weightBottleWaterG = num(formData, "weightBottleWaterG");
      const weightBottleSampleG = num(formData, "weightBottleSampleG");
      const admixtureType = str(formData, "admixtureType");
      const batchNo = str(formData, "batchNo");
      const color = str(formData, "color");
      const odor = str(formData, "odor");
      if (weightBottleG == null || weightBottleWaterG == null || weightBottleSampleG == null) return null;
      // The source form's own printed labels for this row ("W2-W1" used
      // twice) don't describe a coherent pycnometer calculation — this
      // implements the standard one instead: weight of an equal volume of
      // water vs. weight of the sample itself, both net of the empty bottle.
      const weightWaterG = weightBottleWaterG - weightBottleG;
      const weightSampleG = weightBottleSampleG - weightBottleG;
      const specificGravity = weightWaterG !== 0 ? weightSampleG / weightWaterG : undefined;
      return {
        inputs: { weightBottleG, weightBottleWaterG, weightBottleSampleG, admixtureType, batchNo, color, odor },
        computed: { weightWaterG, weightSampleG, specificGravity },
      };
    }
    case "MATERIAL_FINER_200": {
      const originalWeightG = num(formData, "originalWeightG");
      const dryWeightAfterWashingG = num(formData, "dryWeightAfterWashingG");
      if (originalWeightG == null || dryWeightAfterWashingG == null) return null;
      const finerThan200Pct = ((originalWeightG - dryWeightAfterWashingG) / originalWeightG) * 100;
      return { inputs: { originalWeightG, dryWeightAfterWashingG }, computed: { finerThan200Pct } };
    }
    case "LA_ABRASION": {
      const grading = str(formData, "grading");
      const numberOfSpheres = num(formData, "numberOfSpheres");
      const numberOfRevolutions = num(formData, "numberOfRevolutions");
      const totalWeightSampleG = num(formData, "totalWeightSampleG");
      const weightRetainedSieve12G = num(formData, "weightRetainedSieve12G");
      if (totalWeightSampleG == null || weightRetainedSieve12G == null) return null;
      const lossPct = ((totalWeightSampleG - weightRetainedSieve12G) / totalWeightSampleG) * 100;
      return {
        inputs: { grading, numberOfSpheres, numberOfRevolutions, totalWeightSampleG, weightRetainedSieve12G },
        computed: { lossPct },
      };
    }
    case "MOISTURE_CONTENT": {
      const weightPanG = num(formData, "weightPanG");
      const weightPanAggG = num(formData, "weightPanAggG");
      const weightPanOvenDryAggG = num(formData, "weightPanOvenDryAggG");
      if (weightPanG == null || weightPanAggG == null || weightPanOvenDryAggG == null) return null;
      const waterWeightG = weightPanAggG - weightPanOvenDryAggG;
      const ovenDryAggWeightG = weightPanOvenDryAggG - weightPanG;
      const moisturePct = ovenDryAggWeightG !== 0 ? (waterWeightG / ovenDryAggWeightG) * 100 : undefined;
      return { inputs: { weightPanG, weightPanAggG, weightPanOvenDryAggG }, computed: { waterWeightG, ovenDryAggWeightG, moisturePct } };
    }
    case "ORGANIC_IMPURITIES": {
      const colorRating = str(formData, "colorRating");
      if (!colorRating) return null;
      return { inputs: { colorRating }, computed: {} };
    }
    case "UNIT_WEIGHT_AGGREGATE": {
      const weightContainerKg = num(formData, "weightContainerKg");
      const volumeContainerM3 = num(formData, "volumeContainerM3");
      const weightAggContainerLooseKg = num(formData, "weightAggContainerLooseKg");
      const weightAggContainerRoddedKg = num(formData, "weightAggContainerRoddedKg");
      if (weightContainerKg == null || !volumeContainerM3) return null;
      const bulkDensityLooseKgM3 =
        weightAggContainerLooseKg != null ? (weightAggContainerLooseKg - weightContainerKg) / volumeContainerM3 : undefined;
      const bulkDensityRoddedKgM3 =
        weightAggContainerRoddedKg != null ? (weightAggContainerRoddedKg - weightContainerKg) / volumeContainerM3 : undefined;
      return {
        inputs: { weightContainerKg, volumeContainerM3, weightAggContainerLooseKg, weightAggContainerRoddedKg },
        computed: { bulkDensityLooseKgM3, bulkDensityRoddedKgM3 },
      };
    }
    case "SAND_EQUIVALENT": {
      const sandReading1 = num(formData, "sandReading1");
      const clayReading1 = num(formData, "clayReading1");
      const sandReading2 = num(formData, "sandReading2");
      const clayReading2 = num(formData, "clayReading2");
      // `== null`, not truthiness — clayReading1 of 0 is a real entered
      // value, not a missing field; `!clayReading1` used to treat the two
      // identically and silently drop the ENTIRE test submission (not just
      // this one field) whenever a trial reading came out to 0.
      if (sandReading1 == null || clayReading1 == null) return null;
      const se1 = clayReading1 !== 0 ? (sandReading1 / clayReading1) * 100 : undefined;
      const se2 = sandReading2 != null && clayReading2 != null && clayReading2 !== 0 ? (sandReading2 / clayReading2) * 100 : undefined;
      const average = se1 != null && se2 != null ? (se1 + se2) / 2 : (se1 ?? se2);
      return { inputs: { sandReading1, clayReading1, sandReading2, clayReading2 }, computed: { se1, se2, average } };
    }
    case "AGGREGATE_IMPACT_VALUE": {
      const weightSampleG = num(formData, "weightSampleG");
      const weightPassing236mmG = num(formData, "weightPassing236mmG");
      if (!weightSampleG || weightPassing236mmG == null) return null;
      const aivPct = (weightPassing236mmG / weightSampleG) * 100;
      return { inputs: { weightSampleG, weightPassing236mmG }, computed: { aivPct } };
    }
    case "SOUNDNESS_TEST": {
      const materialCategory = str(formData, "materialCategory") as "AGGREGATE" | "SAND" | undefined;
      if (!materialCategory) return null;
      const labels = SOUNDNESS_ROW_LABELS[materialCategory];
      const rows = labels.map((label, i) => {
        const pctRetained = num(formData, `row_${materialCategory}_${i}_pctRetained`);
        const weightBeforeG = num(formData, `row_${materialCategory}_${i}_weightBeforeG`);
        const weightAfterG = num(formData, `row_${materialCategory}_${i}_weightAfterG`);
        const weightLossG = weightBeforeG != null && weightAfterG != null ? weightBeforeG - weightAfterG : undefined;
        const pctLoss = weightLossG != null && weightBeforeG ? (weightLossG / weightBeforeG) * 100 : undefined;
        const weightedPctLoss = pctLoss != null && pctRetained != null ? pctLoss * (pctRetained / 100) : undefined;
        return { label, pctRetained, weightBeforeG, weightAfterG, weightLossG, pctLoss, weightedPctLoss };
      });
      const totalWeightedPctLoss = rows.some((r) => r.weightedPctLoss != null)
        ? rows.reduce((sum, r) => sum + (r.weightedPctLoss ?? 0), 0)
        : undefined;
      return { inputs: { materialCategory }, computed: { totalWeightedPctLoss }, rows };
    }
    case "WATER_PH_TDS": {
      const phValue = num(formData, "phValue");
      const phSpec = str(formData, "phSpec");
      const tdsValue = num(formData, "tdsValue");
      const tdsUnit = str(formData, "tdsUnit");
      const tdsSpec = str(formData, "tdsSpec");
      return { inputs: { phValue, phSpec, tdsValue, tdsUnit, tdsSpec }, computed: {} };
    }
    default:
      return null;
  }
}
