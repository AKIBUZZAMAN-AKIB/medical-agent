import { Schema } from 'mongoose';
import type { IProfile } from '~/types/profile';

/**
 * A named person a user keeps memory about.
 *
 * The user themselves is `isSelf: true` with no `profileId`, which is what
 * makes their partition the null one: every memory row written before profiles
 * existed has no `profileId`, and those rows are the user's own facts. A
 * named subject gets a `profileId` and its own partition, so the same fact
 * about two people never collides or leaks between them.
 */
const PROFILE_ID_REGEX = /^[a-z0-9_]{1,64}$/;

/** Slugify a human label into a stable, storage-safe profile id. */
export function toProfileId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

export function isValidProfileId(profileId: string): boolean {
  return PROFILE_ID_REGEX.test(profileId);
}

const ProfileSchema: Schema<IProfile> = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: true,
    },
    /** Absent for the user's own profile, which lives in the null partition. */
    profileId: {
      type: String,
      default: undefined,
      validate: {
        validator: (value: string | undefined) => value == null || isValidProfileId(value),
        message: 'profileId must be lowercase letters, digits and underscores',
      },
    },
    /** What the user calls this person, e.g. "father", "Priya", "patient 2". */
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    /** How this person relates to the user; free text, e.g. "parent", "spouse". */
    relationship: {
      type: String,
      default: undefined,
      trim: true,
      maxlength: 120,
    },
    /** True only for the user's own profile, which can be renamed but not deleted. */
    isSelf: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

/** One subject per user; the unique index is what makes the slug a real identity. */
ProfileSchema.index({ userId: 1, profileId: 1 }, { unique: true });
/** A user may have exactly one self profile. */
ProfileSchema.index({ userId: 1, isSelf: 1 });

export default ProfileSchema;
