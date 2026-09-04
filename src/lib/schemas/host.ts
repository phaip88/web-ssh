import { z } from "zod";

export const hostSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(64),
  authType: z.enum(["password", "private_key", "certificate"]),
  credentialId: z.string().uuid().nullable().optional(),
  labels: z.array(z.string().max(40)).max(20).default([]),
  environment: z.enum(["development", "staging", "production"]).default("development"),
  keepaliveInterval: z.number().int().min(5).max(300).default(30),
  connectionTimeout: z.number().int().min(3).max(120).default(15),
  maxSessionDuration: z.number().int().min(60).max(86400).default(8 * 3600),
  hostKeyPolicy: z.enum(["strict", "tofu"]).default("strict"),
  isFavorite: z.boolean().default(false),
});

export const hostPatchSchema = hostSchema.partial().extend({ version: z.number().int().optional() });
