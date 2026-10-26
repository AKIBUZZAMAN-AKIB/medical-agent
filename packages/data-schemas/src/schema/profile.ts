import { createHash } from 'crypto';
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

/**
 * Derives the storage key for a human label.
 *
 * A profile id is a storage key, not a display value: it is the partition that
 * every memory row about that person is filed under, so it must be (a) total —
 * defined for every label a user can type, (b) stable — the same label always
 * yields the same key, and (c) discriminating — two different people must never
 * share one. An ASCII slug satisfies none of these outside ASCII: a label in
 * Bengali, Arabic, Devanagari, Han or Cyrillic slagged to the empty string, and
 * the empty string is what the memory layer reads as "no partition at all" —
 * i.e. the account holder's own record. One person's medical facts were then
 * filed under another, with no error anywhere.
 *
 * The rule is therefore stated once, over Unicode, with nothing enumerated:
 *
 *   the key preserves every letter and digit of the label, and nothing else.
 *
 * Runs of letters and digits are kept in order and joined by a single
 * underscore; this is the identity content of the label. Spacing, punctuation
 * and ornament (which carry no letter or digit) are folded away, so "My
 * Father" and "my father" are one person. If the identity content is already
 * storage-safe it is the key, which keeps ids readable; if it is not (any
 * non-Latin script) the key is a digest of that content, so two people whose
 * names differ only in a script that the ASCII alphabet cannot spell still get
 * separate partitions.
 */
export function toProfileId(name: string): string {
  /** NFKC so composed and decomposed spellings of one name agree. */
  const identity = name
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((run) => run !== '')
    .join('_');
  if (identity === '') {
    return '';
  }
  if (/^[a-z0-9_]+$/.test(identity)) {
    return identity.slice(0, 64);
  }
  return `u_${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
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
