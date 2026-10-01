/** Which organs a vital sign or lab "lives in" - drives panel -> body highlighting for measurement rows. */
export const MEASURE_ORGANS: Record<number, string[]> = {
  3000: ["skin", "muscles"], 3002: ["skin", "muscles"], 3003: ["heart", "vessels"], 3004: ["heart", "vessels"], 3005: ["heart"],
  3006: ["skin"], 3007: ["lung_l", "lung_r"],
  3100: ["vessels", "heart"], 3101: ["vessels"], 3102: ["vessels", "liver"], 3103: ["spleen", "lymph_nodes"], 3104: ["spleen", "vessels"],
  3107: ["liver"], 3109: ["kidney_l", "kidney_r"], 3105: ["liver"], 3110: ["pancreas"], 3111: ["pancreas"],
  3120: ["stomach"], 3121: ["stomach"], 3122: ["stomach"], 3112: ["spleen", "vessels"], 3123: ["large_intestine", "stomach"],
};

/** What each physiological signal does to the 3D body (shown in the HUD legend). */
export const PHYSIOLOGY_NOTES = [
  "Heart beats at the recorded pulse",
  "Lungs breathe at the recorded respiratory rate",
  "Blood in the vessels pales as haemoglobin falls",
  "The body outline thins with weight loss",
  "Skin rim warms with fever",
];
