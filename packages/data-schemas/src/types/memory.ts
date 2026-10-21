import type { Types, Document } from 'mongoose';

// Base memory interfaces
export interface IMemoryEntry extends Document {
  userId: Types.ObjectId;
  key: string;
  value: string;
  /** Agent partition; null/absent = shared personal pool */
  agentId?: string;
  /** Subject partition; null/absent = the user themselves */
  profileId?: string;
  tokenCount?: number;
  updated_at?: Date;
  tenantId?: string;
}

export interface IMemoryEntryLean {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  key: string;
  value: string;
  agentId?: string;
  profileId?: string;
  tokenCount?: number;
  updated_at?: Date;
  __v?: number;
}

// Method parameter interfaces
export interface SetMemoryParams {
  userId: string | Types.ObjectId;
  key: string;
  value: string;
  tokenCount?: number;
  /** Agent partition; omit for the shared personal pool */
  agentId?: string;
  /** Subject partition; omit for the user themselves */
  profileId?: string;
}

export interface DeleteMemoryParams {
  userId: string | Types.ObjectId;
  key: string;
  agentId?: string;
  /** Subject partition; omit for the user themselves */
  profileId?: string;
}

export interface MemoryByIdParams {
  userId: string | Types.ObjectId;
  id: string;
  agentId?: string;
  /** Subject partition; omit for the user themselves */
  profileId?: string;
}

export interface SetMemoryByIdParams extends MemoryByIdParams {
  /** Omit to preserve the existing key. */
  key?: string;
  value: string;
  tokenCount?: number;
}

export interface GetUserMemoriesParams {
  userId: string | Types.ObjectId;
  agentId?: string;
  /** Subject partition; omit for the user themselves */
  profileId?: string;
}

export interface GetFormattedMemoriesParams {
  userId: string | Types.ObjectId;
  agentId?: string;
  /** Subject partition; omit for the user themselves */
  profileId?: string;
}

export interface DeleteMemoriesByProfileParams {
  userId: string | Types.ObjectId;
  /** Subject partition; omit for the user themselves */
  profileId?: string;
  agentId?: string;
}

// Result interfaces
export interface MemoryResult {
  ok: boolean;
}

export interface SetMemoryByIdResult extends MemoryResult {
  conflict?: boolean;
  memory?: IMemoryEntryLean;
}

export interface FormattedMemoriesResult {
  withKeys: string;
  withoutKeys: string;
  totalTokens?: number;
  tokenCountsByKey?: Map<string, number>;
}
