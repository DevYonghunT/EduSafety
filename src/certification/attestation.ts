import {
  AbiCoder,
  Signature,
  Wallet,
  dataLength,
  getAddress,
  hexlify,
  randomBytes,
  solidityPackedKeccak256,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import type { TypedDataField } from "ethers";
import {
  EAS_DOMAIN_NAME,
  EAS_DOMAIN_VERSION,
  EAS_OFFCHAIN_VERSION,
  EAS_VERIFYING_CONTRACT,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  type AppConfig,
} from "../config.js";
import { canonicalJson } from "../lib/canonical-json.js";
import type { CertificationPayload } from "../domain/types.js";

export const EAS_PRIMARY_TYPE = "Attest";
export const EAS_ATTEST_TYPES: Record<string, TypedDataField[]> = {
  Attest: [
    { name: "version", type: "uint16" },
    { name: "schema", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "time", type: "uint64" },
    { name: "expirationTime", type: "uint64" },
    { name: "revocable", type: "bool" },
    { name: "refUID", type: "bytes32" },
    { name: "data", type: "bytes" },
    { name: "salt", type: "bytes32" },
  ],
};
Object.freeze(EAS_ATTEST_TYPES.Attest);
Object.freeze(EAS_ATTEST_TYPES);

export interface SerializedEasDomain {
  readonly name: typeof EAS_DOMAIN_NAME;
  readonly version: typeof EAS_DOMAIN_VERSION;
  readonly chainId: string;
  readonly verifyingContract: typeof EAS_VERIFYING_CONTRACT;
}

export interface SerializedEasMessage {
  readonly version: typeof EAS_OFFCHAIN_VERSION;
  readonly schema: `0x${string}`;
  readonly recipient: typeof ZERO_ADDRESS;
  readonly time: string;
  readonly expirationTime: string;
  readonly revocable: true;
  readonly refUID: typeof ZERO_BYTES32;
  readonly data: `0x${string}`;
  readonly salt: `0x${string}`;
}

export interface SignedAttestationProof {
  readonly uid: `0x${string}`;
  readonly attester: string;
  readonly domain: SerializedEasDomain;
  readonly types: typeof EAS_ATTEST_TYPES;
  readonly primaryType: typeof EAS_PRIMARY_TYPE;
  readonly message: SerializedEasMessage;
  readonly signature: `0x${string}`;
  readonly signatureParts: {
    readonly r: `0x${string}`;
    readonly s: `0x${string}`;
    readonly v: number;
  };
  readonly canonicalPayload: string;
  readonly payload: CertificationPayload;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
}

function signingDomain(domain: SerializedEasDomain) {
  return {
    name: domain.name,
    version: domain.version,
    chainId: BigInt(domain.chainId),
    verifyingContract: domain.verifyingContract,
  } as const;
}

function signingMessage(message: SerializedEasMessage) {
  return {
    ...message,
    time: BigInt(message.time),
    expirationTime: BigInt(message.expirationTime),
  };
}

export function encodeCanonicalStatement(canonicalPayload: string): `0x${string}` {
  return AbiCoder.defaultAbiCoder().encode(["string"], [canonicalPayload]) as `0x${string}`;
}

export function calculateOffchainV2Uid(message: SerializedEasMessage): `0x${string}` {
  if (message.version !== EAS_OFFCHAIN_VERSION || dataLength(message.salt) !== 32) {
    throw new Error("Invalid EAS Offchain v2 message");
  }
  return solidityPackedKeccak256(
    [
      "uint16",
      "bytes",
      "address",
      "address",
      "uint64",
      "uint64",
      "bool",
      "bytes32",
      "bytes",
      "bytes32",
      "uint32",
    ],
    [
      EAS_OFFCHAIN_VERSION,
      hexlify(toUtf8Bytes(message.schema)),
      message.recipient,
      ZERO_ADDRESS,
      BigInt(message.time),
      BigInt(message.expirationTime),
      message.revocable,
      message.refUID,
      message.data,
      message.salt,
      0,
    ],
  ) as `0x${string}`;
}

export interface AttestationSignerOptions {
  readonly now?: () => Date;
  readonly randomSalt?: () => Uint8Array;
}

export class AttestationSigner {
  readonly #wallet: Wallet;
  readonly #config: AppConfig;
  readonly #now: () => Date;
  readonly #randomSalt: () => Uint8Array;

  public constructor(config: AppConfig, options: AttestationSignerOptions = {}) {
    this.#config = config;
    this.#wallet = new Wallet(config.eas.attesterPrivateKey);
    if (getAddress(this.#wallet.address) !== getAddress(config.eas.attesterAddress)) {
      throw new Error("EAS attester private key does not match configured address");
    }
    this.#now = options.now ?? (() => new Date());
    this.#randomSalt = options.randomSalt ?? (() => randomBytes(32));
  }

  public async sign(payload: CertificationPayload): Promise<SignedAttestationProof> {
    const issuedAt = this.#now();
    const issuedAtSeconds = BigInt(Math.floor(issuedAt.getTime() / 1000));
    const expirationSeconds =
      this.#config.expirationDays === 0
        ? 0n
        : issuedAtSeconds + BigInt(this.#config.expirationDays * 86_400);
    const canonicalPayload = canonicalJson(payload);
    const salt = hexlify(this.#randomSalt()) as `0x${string}`;
    if (dataLength(salt) !== 32) throw new Error("Attestation salt must be exactly 32 bytes");

    const domain: SerializedEasDomain = {
      name: EAS_DOMAIN_NAME,
      version: EAS_DOMAIN_VERSION,
      chainId: String(this.#config.eas.chainId),
      verifyingContract: EAS_VERIFYING_CONTRACT,
    };
    const message: SerializedEasMessage = {
      version: EAS_OFFCHAIN_VERSION,
      schema: this.#config.eas.schemaUid,
      recipient: ZERO_ADDRESS,
      time: String(issuedAtSeconds),
      expirationTime: String(expirationSeconds),
      revocable: true,
      refUID: ZERO_BYTES32,
      data: encodeCanonicalStatement(canonicalPayload),
      salt,
    };
    const signature = (await this.#wallet.signTypedData(
      signingDomain(domain),
      EAS_ATTEST_TYPES,
      signingMessage(message),
    )) as `0x${string}`;
    const parsedSignature = Signature.from(signature);

    return {
      uid: calculateOffchainV2Uid(message).toLowerCase() as `0x${string}`,
      attester: getAddress(this.#wallet.address),
      domain,
      types: EAS_ATTEST_TYPES,
      primaryType: EAS_PRIMARY_TYPE,
      message,
      signature,
      signatureParts: {
        r: parsedSignature.r as `0x${string}`,
        s: parsedSignature.s as `0x${string}`,
        v: parsedSignature.v,
      },
      canonicalPayload,
      payload,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expirationSeconds === 0n ? null : new Date(Number(expirationSeconds) * 1000).toISOString(),
    };
  }
}

function sameTypes(value: unknown): boolean {
  return canonicalJson(value) === canonicalJson(EAS_ATTEST_TYPES);
}

function strictDecimal(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid unsigned decimal");
  const parsed = BigInt(value);
  if (parsed > (1n << 64n) - 1n) throw new Error("uint64 overflow");
  return parsed;
}

export function verifyAttestationSignature(
  proof: SignedAttestationProof,
  config: Pick<AppConfig, "eas">,
  rebuiltCanonicalPayload: string,
): { valid: true; recoveredAttester: string } | { valid: false; reason: string } {
  try {
    if (
      proof.domain.name !== EAS_DOMAIN_NAME ||
      proof.domain.version !== EAS_DOMAIN_VERSION ||
      proof.domain.chainId !== String(config.eas.chainId) ||
      proof.domain.verifyingContract.toLowerCase() !== EAS_VERIFYING_CONTRACT ||
      proof.primaryType !== EAS_PRIMARY_TYPE ||
      !sameTypes(proof.types)
    ) {
      return { valid: false, reason: "Typed data domain or types mismatch" };
    }
    const messageKeys = Object.keys(proof.message).sort();
    const expectedMessageKeys = [
      "data",
      "expirationTime",
      "recipient",
      "refUID",
      "revocable",
      "salt",
      "schema",
      "time",
      "version",
    ].sort();
    if (canonicalJson(messageKeys) !== canonicalJson(expectedMessageKeys)) {
      return { valid: false, reason: "Attestation message fields mismatch" };
    }
    strictDecimal(proof.message.time);
    strictDecimal(proof.message.expirationTime);
    if (
      proof.message.version !== EAS_OFFCHAIN_VERSION ||
      proof.message.schema.toLowerCase() !== config.eas.schemaUid.toLowerCase() ||
      getAddress(proof.message.recipient) !== ZERO_ADDRESS ||
      proof.message.refUID.toLowerCase() !== ZERO_BYTES32 ||
      proof.message.revocable !== true ||
      dataLength(proof.message.salt) !== 32 ||
      proof.message.data.toLowerCase() !== encodeCanonicalStatement(rebuiltCanonicalPayload).toLowerCase()
    ) {
      return { valid: false, reason: "Attestation message mismatch" };
    }

    const decoded = AbiCoder.defaultAbiCoder().decode(["string"], proof.message.data);
    if (decoded[0] !== rebuiltCanonicalPayload || proof.canonicalPayload !== rebuiltCanonicalPayload) {
      return { valid: false, reason: "Canonical statement mismatch" };
    }
    if (calculateOffchainV2Uid(proof.message).toLowerCase() !== proof.uid.toLowerCase()) {
      return { valid: false, reason: "UID mismatch" };
    }
    const recoveredAttester = getAddress(
      verifyTypedData(
        signingDomain(proof.domain),
        EAS_ATTEST_TYPES,
        signingMessage(proof.message),
        proof.signature,
      ),
    );
    if (
      recoveredAttester !== getAddress(proof.attester) ||
      !config.eas.trustedAttesterAddresses.has(recoveredAttester)
    ) {
      return { valid: false, reason: "Attester mismatch or not trusted" };
    }
    if (Signature.from(proof.signature).serialized.toLowerCase() !== proof.signature.toLowerCase()) {
      return { valid: false, reason: "Signature encoding mismatch" };
    }
    return { valid: true, recoveredAttester };
  } catch {
    return { valid: false, reason: "Malformed attestation proof" };
  }
}
