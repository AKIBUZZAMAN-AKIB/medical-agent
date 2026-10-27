import { useQuery } from '@tanstack/react-query';
import type { UseQueryOptions, QueryObserverResult } from '@tanstack/react-query';
import type { TConversationTagsResponse } from 'librechat-data-provider';
import { PermissionTypes, Permissions, QueryKeys, dataService } from 'librechat-data-provider';
import { useHasAccess } from '~/hooks/Roles';

/**
 * See `useConversationTagsQuery`: the tags endpoint is behind the BOOKMARKS
 * capability, so this query is only enabled when the caller has it. Fetching
 * regardless produced a 403 on every chat mount in a deployment that disables
 * bookmarks.
 */
export const useGetConversationTags = (
  config?: UseQueryOptions<TConversationTagsResponse>,
): QueryObserverResult<TConversationTagsResponse> => {
  const canUseBookmarks = useHasAccess({
    permissionType: PermissionTypes.BOOKMARKS,
    permission: Permissions.USE,
  });
  return useQuery<TConversationTagsResponse>(
    [QueryKeys.conversationTags],
    () => dataService.getConversationTags(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
      enabled: (config?.enabled ?? true) && canUseBookmarks === true,
    },
  );
};
