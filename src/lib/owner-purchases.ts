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
export type OwnerPurchaseItem = OwnerFeedback & {
  published: boolean;
  id: string;
  internalTitle: string;
  title: string;
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
