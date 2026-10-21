import type { Types, Document } from 'mongoose';

/**
 * A named subject whose facts a user keeps separately. The user's own profile
 * has no `profileId`, which places its memories in the null partition — the
 * one every pre-profiles row already sits in.
 */
export interface IProfile extends Document {
  userId: Types.ObjectId;
  /** Absent for the user's own profile. */
  profileId?: string;
  name: string;
  relationship?: string;
  isSelf?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}

export interface IProfileLean {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  profileId?: string;
  name: string;
  relationship?: string;
  isSelf?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}

export interface CreateProfileParams {
  userId: string | Types.ObjectId;
  name: string;
  relationship?: string;
}

export interface UpdateProfileParams {
  userId: string | Types.ObjectId;
  profileId: string;
  name?: string;
  relationship?: string | null;
}

export interface ProfileResult {
  ok: boolean;
  conflict?: boolean;
  profile?: IProfileLean;
  /** Number of memory rows removed with the profile, for an honest UI confirmation. */
  deletedMemories?: number;
}
