import { useLocalWorkspace } from './useWorkspace';
import { useCloudWorkspace } from './useCloudWorkspace';
import { inCloud, type CloudUser } from './cloud';
import type { ProjectDesign } from '../components/ProjectOwnerDesign';
import type { Project, Purchase } from './model';
export function useWorkspace(initialUser?: CloudUser) {
  const cloud = inCloud(),
    local = useLocalWorkspace(!cloud),
    remote = useCloudWorkspace(cloud, initialUser);
  return cloud
    ? remote
    : {
        ...local,
        hasUnsavedChanges: local.status !== '已保存',
        isCloud: false,
        cloudUser: null,
        reloadCloud: async () => {},
        changeDeadline: async (_id: string, _date: string, _reason: string) => {},
        saveProjectDesign: async (_project: Project, _design: ProjectDesign) => {},
        saveOwnerPurchase: async (
          _purchase: Purchase,
          _visible: boolean,
          _edit?: { version?: string; changed: boolean },
          _order?: { brand: string; model: string },
        ) => {},
        saveConflict: null,
        resolveSaveConflict: async (_choices: import('./workspace-merge').MergeChoices) => {},
        dismissSaveConflict: () => {},
        draftRecoveryNotice: '',
        draftRecoveryPackage: async () => ({
          format: 'chunmo-cloud-draft-recovery',
          version: 1,
          entries: [],
        }),
      };
}
