import { useLocalWorkspace } from './useWorkspace';
import { useCloudWorkspace } from './useCloudWorkspace';
import { inCloud } from './cloud';
export function useWorkspace() {
  const cloud = inCloud(),
    local = useLocalWorkspace(!cloud),
    remote = useCloudWorkspace(cloud);
  return cloud
    ? remote
    : {
        ...local,
        isCloud: false,
        cloudUser: null,
        reloadCloud: async () => {},
        changeDeadline: async (_id: string, _date: string, _reason: string) => {},
      };
}
