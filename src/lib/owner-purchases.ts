export type OwnerPublication = {
  responsibility: 'owner' | 'company' | 'supplier';
  published: boolean;
  title: string;
  description: string;
  specification: string;
  quantity: string;
  reference: string;
};
export type OwnerFeedback = { brand: string; model: string; note: string };
export type OwnerPurchaseProject = { id: string; enabled: boolean };
export type OwnerPurchaseSummary = {
  id: string;
  projectId: string;
  published: boolean;
  complete: boolean;
  bought: boolean;
  due: string;
};
export type OwnerPurchaseItem = OwnerPublication &
  OwnerFeedback & {
    id: string;
    internalTitle: string;
    due: string;
    version: string;
    complete: boolean;
    bought: boolean;
    feedbackActor?: string;
    feedbackAt?: string;
    returnReason?: string;
  };
export type OwnerPurchaseIndex = {
  projects: OwnerPurchaseProject[];
  items: OwnerPurchaseSummary[];
};
export const ownerPurchasePath = (project: string, purchase: string) =>
  '/owner-purchases/' + encodeURIComponent(project) + '/' + encodeURIComponent(purchase);
