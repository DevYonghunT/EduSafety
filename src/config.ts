import { getAddress, Wallet } from "ethers";
import { z } from "zod";

export const EAS_DOMAIN_NAME = "EAS Attestation";
export const EAS_DOMAIN_VERSION = "1.2.0";
export const EAS_OFFCHAIN_VERSION = 2;
export const EAS_VERIFYING_CONTRACT = "0x4200000000000000000000000000000000000021";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

const DEFAULT_SCHEMA_UID =
  "0xf58b8b212ef75ee8cd7e8d803c37c03e0519890502d5e99ee2412aae1456cafe";

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: z.string().min(1),
    EAS_CHAIN_ID: z.coerce.number().refine((value) => value === 84_532, "EAS_CHAIN_ID must be 84532").default(84_532),
    EAS_SCHEMA_UID: z
      .string()
      .transform((value) => value.toLowerCase())
      .refine((value) => value === DEFAULT_SCHEMA_UID, "EAS_SCHEMA_UID does not match the configured statement schema")
      .default(DEFAULT_SCHEMA_UID),
    EAS_ATTESTER_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    EAS_ATTESTER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    EAS_TRUSTED_ATTESTER_ADDRESSES: z.string().min(1),
    BADGE_ALLOWED_ORIGINS: z.string().default(""),
    BADGE_PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
    BADGE_EXPIRATION_DAYS: z.coerce.number().int().min(0).max(3650).default(365),
    ADMIN_ID: z.string().regex(/^[a-zA-Z0-9._-]{3,64}$/),
    ADMIN_USERNAME: z.string().min(3).max(128),
    ADMIN_PASSWORD_SCRYPT: z.string().regex(/^scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/),
    ADMIN_SESSION_SECRET: z.string().min(43),
    GITHUB_TOKEN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
  })
  .passthrough();

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly port: number;
  readonly databaseUrl: string;
  readonly eas: {
    readonly chainId: number;
    readonly schemaUid: `0x${string}`;
    readonly attesterAddress: string;
    readonly attesterPrivateKey: `0x${string}`;
    readonly trustedAttesterAddresses: ReadonlySet<string>;
  };
  readonly allowedOrigins: ReadonlySet<string>;
  readonly publicBaseUrl: string;
  readonly expirationDays: number;
  readonly admin: {
    readonly id: string;
    readonly username: string;
    readonly passwordScrypt: string;
    readonly sessionSecret: string;
  };
  readonly githubToken?: string;
}

function parseOrigins(value: string): ReadonlySet<string> {
  const origins = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const url = new URL(entry);
      if (url.origin !== entry || !["http:", "https:"].includes(url.protocol)) {
        throw new Error(`BADGE_ALLOWED_ORIGINS contains an invalid origin: ${entry}`);
      }
      return url.origin;
    });
  return new Set(origins);
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const walletAddress = getAddress(new Wallet(parsed.EAS_ATTESTER_PRIVATE_KEY).address);
  const configuredAddress = getAddress(parsed.EAS_ATTESTER_ADDRESS);
  if (walletAddress !== configuredAddress) {
    throw new Error("EAS attester private key does not match EAS_ATTESTER_ADDRESS");
  }

  const trusted = new Set(
    parsed.EAS_TRUSTED_ATTESTER_ADDRESSES.split(",")
      .map((address) => address.trim())
      .filter(Boolean)
      .map(getAddress),
  );
  if (!trusted.has(configuredAddress)) {
    throw new Error("EAS_ATTESTER_ADDRESS must be present in EAS_TRUSTED_ATTESTER_ADDRESSES");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    eas: {
      chainId: parsed.EAS_CHAIN_ID,
      schemaUid: parsed.EAS_SCHEMA_UID.toLowerCase() as `0x${string}`,
      attesterAddress: configuredAddress,
      attesterPrivateKey: parsed.EAS_ATTESTER_PRIVATE_KEY as `0x${string}`,
      trustedAttesterAddresses: trusted,
    },
    allowedOrigins: parseOrigins(parsed.BADGE_ALLOWED_ORIGINS),
    publicBaseUrl: parsed.BADGE_PUBLIC_BASE_URL.replace(/\/$/, ""),
    expirationDays: parsed.BADGE_EXPIRATION_DAYS,
    admin: {
      id: parsed.ADMIN_ID,
      username: parsed.ADMIN_USERNAME,
      passwordScrypt: parsed.ADMIN_PASSWORD_SCRYPT,
      sessionSecret: parsed.ADMIN_SESSION_SECRET,
    },
    ...(parsed.GITHUB_TOKEN === undefined ? {} : { githubToken: parsed.GITHUB_TOKEN }),
  };
}
