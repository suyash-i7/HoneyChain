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
  diseaseRisk: number | null;
  productivityTrend: "RISING" | "STABLE" | "FALLING";
  explanation: string;
};

export interface HiveAnalysisProvider {
  analyze(input: HiveAnalysisInput): Promise<HiveAnalysisResult>;
}

export class DefaultHiveAnalysisProvider implements HiveAnalysisProvider {
  async analyze({ readings }: HiveAnalysisInput): Promise<HiveAnalysisResult> {
    const ordered = [...readings].sort((left, right) => new Date(left.recordedAt).getTime() - new Date(right.recordedAt).getTime());
    if (!ordered.length) {
      return {
        health: "OBSERVE",
        diseaseRisk: null,
        productivityTrend: "STABLE",
        explanation: "No recent sensor readings are available yet. Disease risk cannot be scored, and the hive health check is waiting for evidence.",
      };
    }

    const latest = ordered[ordered.length - 1];
    const first = ordered[0];
    const averageTemperature = ordered.reduce((total, reading) => total + reading.temperatureC, 0) / ordered.length;
    const averageHumidity = ordered.reduce((total, reading) => total + reading.humidityPct, 0) / ordered.length;
    const weightChange = latest.weightKg - first.weightKg;

    const temperatureVariance = Math.abs(latest.temperatureC - averageTemperature);
    const humidityVariance = Math.abs(latest.humidityPct - averageHumidity);
    const riskScore = Math.min(100, Math.round(
      Math.max(0, (32 - latest.temperatureC) * 12) +
      Math.max(0, (latest.temperatureC - 36) * 12) +
      Math.max(0, (40 - latest.humidityPct) * 3) +
      Math.max(0, (latest.humidityPct - 75) * 3) +
      Math.max(0, (temperatureVariance - 1.5) * 8) +
      Math.max(0, (humidityVariance - 10) * 1) +
      (weightChange < -1 ? 18 : 0) +
      (weightChange < -3 ? 12 : 0) +
      (latest.weightKg < 18 ? 16 : 0),
    ));

    const health: HiveAnalysisResult["health"] = riskScore >= 70 ? "URGENT_REVIEW" : riskScore >= 35 || weightChange < -1 ? "OBSERVE" : "HEALTHY";
    const productivityTrend: HiveAnalysisResult["productivityTrend"] = weightChange > 2 ? "RISING" : weightChange < -2 ? "FALLING" : "STABLE";
    const evidence: string[] = [];
    if (latest.temperatureC < 32 || latest.temperatureC > 36) evidence.push(`Temperature is outside the 32-36°C monitoring range (${latest.temperatureC.toFixed(1)}°C).`);
    if (latest.humidityPct < 40 || latest.humidityPct > 75) evidence.push(`Humidity is outside the 40-75% monitoring range (${latest.humidityPct.toFixed(1)}%).`);
    if (weightChange < -1) evidence.push(`Hive weight declined by ${Math.abs(weightChange).toFixed(1)} kg across these readings.`);
    const explanation = `Evidence from ${ordered.length} readings shows ${latest.temperatureC.toFixed(1)}°C temperature, ${latest.humidityPct.toFixed(1)}% humidity, and ${weightChange >= 0 ? "+" : "-"}${Math.abs(weightChange).toFixed(1)} kg weight change. ${evidence.length ? evidence.join(" ") : "Recent readings remain within the configured monitoring ranges."} ${health === "HEALTHY" ? "Continue routine monitoring." : health === "OBSERVE" ? "Review the trend and collect follow-up readings." : "Conditions warrant immediate review."}`;

    return { health, diseaseRisk: riskScore, productivityTrend, explanation };
  }
}