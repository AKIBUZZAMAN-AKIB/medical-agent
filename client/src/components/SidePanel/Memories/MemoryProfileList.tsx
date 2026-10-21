import { useState } from 'react';
import { Trans } from 'react-i18next';
import { TrashIcon, Spinner, TooltipAnchor, OGDialogTemplate } from '@librechat/client';
import { Button, Label, OGDialog, OGDialogTrigger, useToastContext } from '@librechat/client';
import type { TMemoryProfile } from 'librechat-data-provider';
import { useDeleteMemoryProfileMutation, useMemoryProfilesQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';

/**
 * The people this user keeps a separate record for.
 *
 * An agent may only open a record for someone else after asking and being told
 * yes, and it says so when it does. This is the other half of that: the user can
 * see who has a record and what is in it, and remove either. Without it the
 * consent is one-directional — the person described by the facts has no way to
 * have them removed, and the user who agreed cannot take the agreement back.
 *
 * The user's own record is listed but not deletable here: their own facts are
 * cleared through the memory list, where a single fact can be reviewed first.
 */
export default function MemoryProfileList() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data, isLoading } = useMemoryProfilesQuery();
  const { mutate: deleteProfile, isLoading: isDeleting } = useDeleteMemoryProfileMutation();
  const [pendingDelete, setPendingDelete] = useState<TMemoryProfile | null>(null);

  const profiles = data?.profiles ?? [];
  /** Only someone else's record can be removed from here. */
  const removable = profiles.filter((profile) => !profile.isSelf && profile.profileId != null);
  if (removable.length === 0) {
    return null;
  }

  const confirmDelete = () => {
    const target = pendingDelete;
    if (target?.profileId == null) {
      return;
    }
    deleteProfile(target.profileId, {
      onSuccess: (result) => {
        showToast({
          message: localize(
            result.deletedMemories === 1
              ? 'com_ui_memory_profile_deleted_one'
              : 'com_ui_memory_profile_deleted',
            { count: result.deletedMemories, name: target.name },
          ),
          status: 'success',
        });
        setPendingDelete(null);
      },
      onError: () => {
        showToast({ message: localize('com_ui_error'), status: 'error' });
      },
    });
  };

  if (isLoading) {
    return null;
  }

  return (
    <section
      aria-label={localize('com_ui_memory_profiles')}
      className="rounded-lg border border-border-light px-3 py-2"
    >
      <h3 className="text-xs font-medium uppercase text-text-secondary">
        {localize('com_ui_memory_profiles')}
      </h3>
      <p className="mt-1 text-xs text-text-tertiary">{localize('com_ui_memory_profiles_hint')}</p>
      <ul className="mt-2 space-y-1.5">
        {removable.map((profile) => (
          <li key={profile.profileId} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
              {profile.name}
              {profile.relationship ? ` · ${profile.relationship}` : ''}
              <span className="ml-1 text-xs text-text-secondary">
                {localize(
                  profile.factCount === 1
                    ? 'com_ui_memory_profile_fact_count_one'
                    : 'com_ui_memory_profile_fact_count',
                  { count: profile.factCount },
                )}
              </span>
            </span>
            <OGDialog
              open={pendingDelete?.profileId === profile.profileId}
              onOpenChange={(open) => {
                if (!open) {
                  setPendingDelete(null);
                }
              }}
            >
              <OGDialogTrigger asChild>
                <TooltipAnchor
                  description={localize('com_ui_memory_profile_delete')}
                  side="top"
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={localize('com_ui_delete')}
                      onClick={() => setPendingDelete(profile)}
                      className="flex size-7 items-center justify-center rounded-md text-text-secondary transition-colors duration-150 hover:bg-surface-tertiary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
                    >
                      {isDeleting ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <TrashIcon className="size-3.5" aria-hidden="true" />
                      )}
                    </Button>
                  }
                />
              </OGDialogTrigger>
              <OGDialogTemplate
                showCloseButton={false}
                title={localize('com_ui_memory_profile_delete')}
                className="w-11/12 max-w-lg"
                main={
                  <Label className="text-left text-sm font-medium">
                    <Trans
                      i18nKey="com_ui_memory_profile_delete_confirm"
                      values={{ name: profile.name, count: profile.factCount }}
                      components={{ strong: <strong /> }}
                    />
                  </Label>
                }
                selection={{
                  selectHandler: confirmDelete,
                  selectClasses:
                    'bg-surface-destructive text-text-on-status hover:bg-surface-destructive-hover',
                  selectText: localize('com_ui_delete'),
                }}
              />
            </OGDialog>
          </li>
        ))}
      </ul>
    </section>
  );
}
