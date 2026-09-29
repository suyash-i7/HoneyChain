const API_URL = "/api";
let accessToken = localStorage.getItem("honeychain-token");

export function setAccessToken(token: string | null) {
  accessToken = token;
  if (token) localStorage.setItem("honeychain-token", token);
  else localStorage.removeItem("honeychain-token");
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch {
    throw new ApiError("Cannot reach the HoneyChain API. Check that the server is running.", 0);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error ?? "The request could not be completed.", response.status);
  return body as T;
}

export type User = { id: string; name: string; email: string; role: string };
export type HiveAnalysis = {
  health: "HEALTHY" | "OBSERVE" | "URGENT_REVIEW";
  diseaseRisk: number | null;
  productivityTrend: "RISING" | "STABLE" | "FALLING";
  explanation: string;
};
export type SensorReading = {
  id: string;
  hiveId: string;
  temperatureC: number;
  humidityPct: number;
  weightKg: number;
  source: string;
  recordedAt: string;
  hive?: { name: string };
};
export type Hive = {
  id: string;
  name: string;
  location: string;
  colonyType?: string | null;
  readings: SensorReading[];
};
export type BatchEvent = { id: string; type: string; note: string; createdAt: string };
export type BatchStageType = "HARVESTED" | "VERIFIED" | "PROCESSED" | "PACKAGED" | "DISTRIBUTED" | "CONSUMER_VERIFIED";
export type BatchStage = {
  id?: string;
  type: BatchStageType;
  sequence: number;
  occurredAt: string;
  status: string;
  actorId?: string | null;
  metadata: Record<string, unknown>;
  digest?: string;
  blockchainTx?: string | null;
  blockchainNet?: string | null;
  proof?: { verified: boolean; digest: string; transactionHash: string | null; network: string | null };
};
export type Batch = {
  id: string;
  code: string;
  harvestDate: string;
  quantityKg: number;
  floralSource?: string | null;
  status: string;
  blockchainTx?: string | null;
  blockchainNet?: string | null;
  createdAt: string;
  hive?: { name: string; location?: string };
  beekeeper?: { id?: string; name: string };
  events: BatchEvent[];
  stages?: BatchStage[];
};