import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";

const batchRegistryAbi = [
  "function anchorBatch(string batchCode, bytes32 dataDigest)",
  "function getBatch(string batchCode) view returns (bytes32 dataDigest, address recordedBy, uint64 recordedAt)",
  "event BatchAnchored(string indexed batchCode, bytes32 dataDigest, address indexed recordedBy, uint64 recordedAt)",
];

export type ChainAnchorResult = {
  txHash: string;
  network: string;
};

export type ChainBatchProof = {
  dataDigest: string;
  recordedBy: string;
  recordedAt: string;
  network: string;
};

export class BlockchainService {
  private readonly rpcUrl = process.env.BLOCKCHAIN_RPC_URL;
  private readonly contractAddress = process.env.CONTRACT_ADDRESS;

  isConfigured(): boolean {
    return Boolean(this.rpcUrl && process.env.BLOCKCHAIN_PRIVATE_KEY && this.contractAddress && /^0x[a-fA-F0-9]{40}$/.test(this.contractAddress));
  }

  async anchorBatch(code: string, digest: string): Promise<ChainAnchorResult | null> {
    if (!this.isConfigured()) return null;
    const privateKey = process.env.BLOCKCHAIN_PRIVATE_KEY;
    if (!privateKey) throw new Error("BLOCKCHAIN_PRIVATE_KEY is required to anchor batches");
    const provider = new JsonRpcProvider(this.rpcUrl);
    const signer = new Wallet(privateKey, provider);
    const contract = new Contract(this.contractAddress!, batchRegistryAbi, signer);
    const transaction = await contract.anchorBatch(code, `0x${digest}`);
    const receipt = await transaction.wait();
    if (!receipt?.hash) throw new Error("Blockchain transaction was not confirmed");
    const network = await provider.getNetwork();
    return { txHash: receipt.hash, network: network.chainId.toString() };
  }

  async verifyBatch(code: string, digest: string): Promise<boolean | null> {
    if (!this.isConfigured()) return null;
    const proof = await this.getBatchProof(code);
    return proof ? proof.dataDigest.toLowerCase() === `0x${digest}`.toLowerCase() : false;
  }

  async getBatchProof(code: string): Promise<ChainBatchProof | null> {
    if (!this.isConfigured()) return null;
    const provider = new JsonRpcProvider(this.rpcUrl);
    const contract = new Contract(this.contractAddress!, batchRegistryAbi, provider);
    try {
      const [record, network] = await Promise.all([contract.getBatch(code), provider.getNetwork()]);
      if (record.recordedAt === 0n) return null;
      return {
        dataDigest: record.dataDigest.toLowerCase(),
        recordedBy: record.recordedBy,
        recordedAt: new Date(Number(record.recordedAt) * 1000).toISOString(),
        network: network.chainId.toString(),
      };
    } catch {
      return null;
    }
  }
}

export function digestBatch(data: { code: string; hiveId: string; quantityKg: number; harvestDate: string; floralSource?: string | null }): string {
  const immutableData = {
    code: data.code,
    hiveId: data.hiveId,
    quantityKg: data.quantityKg,
    harvestDate: data.harvestDate,
    floralSource: data.floralSource ?? null,
  };
  return keccak256(toUtf8Bytes(JSON.stringify(immutableData))).slice(2);
}