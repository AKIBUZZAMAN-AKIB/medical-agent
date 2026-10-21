import type { Model } from 'mongoose';
import type { IProfile } from '~/types/profile';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import profileSchema from '~/schema/profile';

export function createProfileModel(mongoose: typeof import('mongoose')): Model<IProfile> {
  applyTenantIsolation(profileSchema);
  return (mongoose.models.Profile ||
    mongoose.model<IProfile>('Profile', profileSchema)) as Model<IProfile>;
}
