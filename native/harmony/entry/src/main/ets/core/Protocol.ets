export interface Identity { id: string; workspaceId: string; name: string; }
export interface GpsPoint { latitude: number; longitude: number; accuracy: number; obtainedAt: string; }
export interface Poi { id: string; latitude: number; longitude: number; }
export interface Receipt {
  location: GpsPoint; placeName: string; placeSource: string; nearby: boolean; poi: Poi;
  resolvedAt: string; expiresAt: string; token: string;
}
export interface Place { id: string; name: string; address: string; distance: number; receipt: Receipt; }
export interface Places { places: Place[]; more: boolean; }
export interface Login { login: string; password: string; }
export interface Search { location: GpsPoint; nearby: boolean; query: string; page: number; }
export interface Renew { location: GpsPoint; previousToken: string; previousAt: string; }
export interface User { id: string; workspaceId: string; }
export interface Session { user: User; csrf: string; }
export interface PhotoConfig { actorId: string; actorName: string; }
export interface Failure { error?: string; }
export enum Stage { Capturing='CAPTURING', Captured='CAPTURED', Marked='WATERMARKED', Creating='CREATING', Writing='WRITING', Saved='SAVED', Failed='FAILED', Unknown='UNKNOWN' }
export interface Shot {
  id: string; actor: Identity; receipt: Receipt; capturedAt: string; stage: Stage;
  raw: string; output: string; mediaUri: string; error: string; width: number; height: number;
}
export function fresh(p: Receipt): boolean {
  const age = Date.now() - Date.parse(p.location.obtainedAt);
  return p.placeSource === 'amap-poi-selected' && p.poi.id.length > 0 && p.token.length > 0 &&
    age >= -5000 && age <= 90000 && p.location.accuracy <= 100 && p.location.accuracy >= 0 && Date.now() <= Date.parse(p.expiresAt);
}
export function shanghai(at: string): string {
  // UTC calendar access on an explicitly shifted instant is independent of device time zone.
  const d = new Date(Date.parse(at) + 8 * 3600000);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth()+1)}.${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function lines(shot: Shot): string[] {
  return watermarkLines(shot.receipt.placeName,shot.capturedAt,shot.actor.name);
}
export function watermarkLines(place: string, at: string, actor: string): string[] {
  const all = [`工地定位：${place}`, `拍摄时间：${shanghai(at)}`, `拍摄人员：${actor}`];
  const result: string[] = [];
  all.forEach((line: string) => { for (let i=0; i<line.length; i+=26) result.push(line.slice(i,i+26)); });
  return result;
}
export interface NativeMark { scale: number; font: number; gap: number; pad: number; wrapped: string[]; boxW: number; boxH: number; x: number; y: number; logoSize: number; brandFont: number; headerH: number; }
export function nativeMark(width: number, height: number, place: string, at: string, actor: string): NativeMark {
  const s=Math.min(width/1100,height/800); const wrapped=watermarkLines(place,at,actor);
  const boxH=(44+50+24+35*Math.max(0,wrapped.length-1))*s;
  return { scale:s,font:24*s,gap:35*s,pad:22*s,wrapped:wrapped,boxW:Math.min(width-32*s,780*s),boxH:boxH,x:16*s,y:height-boxH-16*s,logoSize:44*s,brandFont:32*s,headerH:50*s };
}
