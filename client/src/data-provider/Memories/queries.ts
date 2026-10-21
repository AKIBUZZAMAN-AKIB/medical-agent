/* Memories */
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { QueryKeys, MutationKeys, dataService } from 'librechat-data-provider';
import type {
  TUserMemory,
  MemoriesResponse,
  UpdateMemoryResponse,
  MemoryProfilesResponse,
} from 'librechat-data-provider';
import type {
  UseQueryOptions,
  UseMutationOptions,
  QueryObserverResult,
} from '@tanstack/react-query';

export const useMemoriesQuery = (
  config?: UseQueryOptions<MemoriesResponse>,
): QueryObserverResult<MemoriesResponse> => {
  return useQuery<MemoriesResponse>([QueryKeys.memories], () => dataService.getMemories(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    ...config,
  });
};

export type DeleteMemoryParams = {
  key?: string;
  id?: string;
  agentId?: string;
  profileId?: string;
};
export const useDeleteMemoryMutation = () => {
  const queryClient = useQueryClient();
  return useMutation(
    ({ key, id, agentId, profileId }: DeleteMemoryParams) => {
      if (id) {
        return dataService.deleteMemoryById(id, agentId, profileId);
      }
      if (key) {
        return dataService.deleteMemory(key, agentId, profileId);
      }
      throw new Error('Memory address is required.');
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries([QueryKeys.memories]);
      },
    },
  );
};

export const useMemoryProfilesQuery = (
  config?: UseQueryOptions<MemoryProfilesResponse>,
): QueryObserverResult<MemoryProfilesResponse> => {
  return useQuery<MemoryProfilesResponse>(
    [QueryKeys.memoryProfiles],
    () => dataService.getMemoryProfiles(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};

/**
 * Removing a person removes every fact stored about them, so the profile list
 * and the memory list are invalidated together: leaving the other stale would
 * show a record that no longer exists next to facts that are already gone.
 */
export const useDeleteMemoryProfileMutation = () => {
  const queryClient = useQueryClient();
  return useMutation((profileId: string) => dataService.deleteMemoryProfile(profileId), {
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.memoryProfiles]);
      queryClient.invalidateQueries([QueryKeys.memories]);
    },
  });
};

export type UpdateMemoryParams = {
  key?: string;
  id?: string;
  value: string;
  originalKey?: string;
  agentId?: string;
  profileId?: string;
};
export const useUpdateMemoryMutation = (
  options?: UseMutationOptions<UpdateMemoryResponse, Error, UpdateMemoryParams>,
) => {
  const queryClient = useQueryClient();
  return useMutation(
    ({ key, id, value, originalKey, agentId, profileId }: UpdateMemoryParams) => {
      if (id) {
        return dataService.updateMemoryById(id, value, key, agentId, profileId);
      }
      if (key) {
        return dataService.updateMemory(key, value, originalKey, agentId, profileId);
      }
      throw new Error('Memory address is required.');
    },
    {
      ...options,
      onSuccess: (...params) => {
        queryClient.invalidateQueries([QueryKeys.memories]);
        options?.onSuccess?.(...params);
      },
    },
  );
};

export type UpdateMemoryPreferencesParams = { memories: boolean };
export type UpdateMemoryPreferencesResponse = {
  updated: boolean;
  preferences: { memories: boolean };
};

export const useUpdateMemoryPreferencesMutation = (
  options?: UseMutationOptions<
    UpdateMemoryPreferencesResponse,
    Error,
    UpdateMemoryPreferencesParams
  >,
) => {
  const queryClient = useQueryClient();
  return useMutation<UpdateMemoryPreferencesResponse, Error, UpdateMemoryPreferencesParams>(
    [MutationKeys.updateMemoryPreferences],
    (preferences: UpdateMemoryPreferencesParams) =>
      dataService.updateMemoryPreferences(preferences),
    {
      ...options,
      onSuccess: (...params) => {
        queryClient.invalidateQueries([QueryKeys.user]);
        options?.onSuccess?.(...params);
      },
    },
  );
};

export type CreateMemoryParams = {
  key: string;
  value: string;
  agentId?: string;
  profileId?: string;
};
export type CreateMemoryResponse = { created: boolean; memory: TUserMemory };

export const useCreateMemoryMutation = (
  options?: UseMutationOptions<CreateMemoryResponse, Error, CreateMemoryParams>,
) => {
  const queryClient = useQueryClient();
  return useMutation<CreateMemoryResponse, Error, CreateMemoryParams>(
    ({ key, value, agentId, profileId }: CreateMemoryParams) =>
      dataService.createMemory({ key, value, agentId, profileId }),
    {
      ...options,
      onSuccess: (data, variables, context) => {
        queryClient.setQueryData<MemoriesResponse>([QueryKeys.memories], (oldData) => {
          if (!oldData || !data.memory) return oldData;

          const newMemories = [...oldData.memories, data.memory];
          /** Usage totals track the shared personal pool only */
          const totalTokens = newMemories.reduce(
            (sum, memory) => sum + (memory.agentId ? 0 : memory.tokenCount || 0),
            0,
          );
          const tokenLimit = oldData.tokenLimit;
          let usagePercentage = oldData.usagePercentage;

          if (tokenLimit && tokenLimit > 0) {
            usagePercentage = Math.min(100, Math.round((totalTokens / tokenLimit) * 100));
          }

          return {
            ...oldData,
            memories: newMemories,
            totalTokens,
            usagePercentage,
          };
        });

        options?.onSuccess?.(data, variables, context);
      },
    },
  );
};
