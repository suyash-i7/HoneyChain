export type HiveAnalysisInput = {
  hiveId: string;
  readings: Array<{
    temperatureC: number;
    humidityPct: number;
    weightKg: number;
    recordedAt: string;
  }>;
};

export type HiveAnalysisResult = {
  health: "HEALTHY" | "OBSERVE" | "URGENT_REVIEW";
  diseaseRisk: number;
  productivityTrend: "RISING" | "STABLE" | "FALLING";
  explanation: string;
};

export interface HiveAnalysisProvider {
  analyze(input: HiveAnalysisInput): Promise<HiveAnalysisResult>;
}